import { z } from 'zod'
import { docToText } from '@shared/docText'
import {
  BRIEF_SCENE_CHAR_BUDGET,
  BRIEF_TEXT_MIN,
  SCENE_BRIEF_FIELD_MAX,
  type SceneBrief
} from '@shared/sceneMeta'
import { getDocumentContent } from '../document/documentStore'
import { getSceneMeta } from '../document/sceneMetaStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { headTruncate } from './context/chatContext'
import { assertFeatureAllowed } from './dial'
import { buildBriefPrompt } from './prompts/brief.v1'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

export interface DraftBriefInput {
  /** The scene to read; its metadata rides along. */
  nodeId: string
  /**
   * The caller's id for `ai:cancel` (F-5.10). Optional so the eval harness can run without
   * one; then the request cannot be stopped.
   */
  requestId?: string
}

export interface DraftBriefResult {
  /** The five lines as the model drafted them; '' where the scene does not show one. */
  brief: SceneBrief
  /** Whether the scene was head-truncated before it was sent. */
  truncated: boolean
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** The shape the prompt asks for; the five lines are read as unknown so a non-string is a blank line, not a failure. */
const ModelAnswer = z.object({
  goal: z.unknown().optional(),
  conflict: z.unknown().optional(),
  turn: z.unknown().optional(),
  beat: z.unknown().optional(),
  after: z.unknown().optional()
})

/**
 * The scene-brief drafting use case (F-14.3). The gate first (`brief` must be allowed:
 * nothing is read or sent below Ask or with the feature toggled off), then the node must be a
 * document holding at least `BRIEF_TEXT_MIN` characters (NOT_FOUND / VALIDATION as everywhere
 * else), then exactly the context the data-sharing panel lists: the scene's text
 * head-truncated to `BRIEF_SCENE_CHAR_BUDGET` and its metadata line. No voice block and no
 * neighbouring briefs: the draft describes this scene, and every extra token is one the
 * author did not ask for.
 *
 * The answer is JSON on the `fast` tier (token rule 1: only Author mode, critique, and
 * queries may use `strong`) and is not streamed: five short lines are only useful whole.
 * Nothing is stored here — the handler records the draft as a pending proposal (F-14.5) and
 * the author fills the fields themselves on Use draft, which is the point of the feature.
 * The context hash covers everything that shaped the messages: the scene text as sent and
 * the metadata.
 */
export async function draftBrief(
  db: TreeDb,
  deps: AiRequestDeps,
  input: DraftBriefInput
): Promise<DraftBriefResult> {
  assertFeatureAllowed(getAiSettings(db), 'brief')

  const { content } = getDocumentContent(db, input.nodeId)
  const fullText = content ? docToText(content).trim() : ''
  if (fullText.length < BRIEF_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      `Write at least ${BRIEF_TEXT_MIN} characters in this scene before asking for a brief`,
      { nodeId: input.nodeId, length: fullText.length }
    )
  }
  const sceneText = headTruncate(fullText, BRIEF_SCENE_CHAR_BUDGET)
  const { meta: sceneMeta } = getSceneMeta(db, input.nodeId)
  const meta = sceneMeta.location || sceneMeta.pov || sceneMeta.timeline ? sceneMeta : null

  const prompt = buildBriefPrompt({ sceneText, meta })
  const result = await runAiRequest(deps, {
    feature: 'brief',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify({ sceneText, meta })),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  return {
    brief: parseBriefAnswer(result.text),
    truncated: fullText.length > BRIEF_SCENE_CHAR_BUDGET,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/**
 * The model's `{ goal, conflict, turn, beat, after }`: PROVIDER when the answer is not JSON or
 * not an object at all, and lenient field by field otherwise — anything that is not a string
 * reads as "the scene does not show it", and every line is trimmed and cut to
 * `SCENE_BRIEF_FIELD_MAX`, so the draft always fits the fields the author corrects.
 */
export function parseBriefAnswer(text: string): SceneBrief {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)
  const line = (value: unknown): string =>
    typeof value === 'string' ? value.trim().slice(0, SCENE_BRIEF_FIELD_MAX).trim() : ''
  return {
    goal: line(answer.data.goal),
    conflict: line(answer.data.conflict),
    turn: line(answer.data.turn),
    beat: line(answer.data.beat),
    after: line(answer.data.after)
  }
}
