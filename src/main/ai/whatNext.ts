import { z } from 'zod'
import { estimateTokens, inputBudget } from '@shared/ai'
import { docToText } from '@shared/docText'
import { STORY_BIBLE_TOKEN_BUDGET } from '@shared/storyBible'
import {
  WHAT_NEXT_CHAR_BUDGET,
  WHAT_NEXT_DIRECTIONS,
  WHAT_NEXT_TEXT_MAX,
  WHAT_NEXT_TEXT_MIN,
  WHAT_NEXT_TITLE_MAX,
  type WhatNextDirection
} from '@shared/whatNext'
import { getDocumentContent } from '../document/documentStore'
import { sceneBriefBlock } from '../document/sceneNeighbours'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { buildSceneSteer } from './context/sceneSteer'
import { buildStoryBible } from './context/storyBible'
import { assertFeatureAllowed } from './dial'
import { buildWhatNextPromptV2 } from './prompts/whatNext.v2'
import { AiFallbackError, type AiMessage, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

export interface WhatNextInput {
  /** The scene the directions are for. */
  nodeId: string
  /**
   * The document's text up to the selection's end, when the author selected a passage; null,
   * absent, or blank reads the saved scene.
   */
  before?: string | null
  /** The caller's id for `ai:cancel` (F-5.10); optional so tests and the eval can run without one. */
  requestId?: string
}

export interface WhatNextResult {
  /** Up to `WHAT_NEXT_DIRECTIONS` directions, trimmed and cut to their caps. */
  directions: WhatNextDirection[]
  /** How many directions the answer held that `parseWhatNextAnswer` threw away. */
  dropped: number
  /** Whether the text was cut from the front before it was sent. */
  truncated: boolean
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

const ModelAnswer = z.object({ directions: z.array(z.unknown()) })
const ModelDirection = z.object({ title: z.string(), text: z.string() })

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** How much shorter the tail gets per step while the prompt is over the input budget. */
const SHRINK_CHARS = 500

/**
 * What should come next? (F-5.17). The gate first (`whatNext` must be allowed: nothing is read
 * or sent below Ask or with the feature toggled off), then the node must be a document
 * (NOT_FOUND / VALIDATION as everywhere else) in the manuscript (VALIDATION). The text is
 * `before` when the renderer sent one (the document up to the selection's end), else the saved
 * scene; either needs `WHAT_NEXT_TEXT_MIN` characters. Exactly the context the data-sharing
 * panel lists goes with it: the tail of that text within `WHAT_NEXT_CHAR_BUDGET` (shorter still
 * if the prompt is over `inputBudget('whatNext')`, token rule 8), the scene brief, the scene
 * steer (F-14.13: its tone, content, plot thread, and theme tags), and the story bible. No voice block: directions are advice, not prose.
 *
 * The answer is JSON from the fast tier, not streamed. The context hash covers the text, the
 * brief, the steer, and the bible, everything that shaped the messages.
 */
export async function runWhatNext(
  db: TreeDb,
  deps: AiRequestDeps,
  input: WhatNextInput
): Promise<WhatNextResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'whatNext')

  const { content } = getDocumentContent(db, input.nodeId)
  if (!manuscriptDocuments(db).some((row) => row.id === input.nodeId)) {
    throw new AppError('VALIDATION', 'Only a scene in the manuscript can be continued', {
      nodeId: input.nodeId
    })
  }
  const before = input.before?.trim() ?? ''
  const fullText = before || (content ? docToText(content).trim() : '')
  if (fullText.length < WHAT_NEXT_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      `Write at least ${WHAT_NEXT_TEXT_MIN} characters in this scene before asking what comes next`,
      { nodeId: input.nodeId, length: fullText.length }
    )
  }

  const brief = sceneBriefBlock(db, input.nodeId)
  const bible = buildStoryBible(db, { nodeId: input.nodeId, maxTokens: STORY_BIBLE_TOKEN_BUDGET })
  const steer = buildSceneSteer(db, input.nodeId)
  const build = (text: string): ReturnType<typeof buildWhatNextPromptV2> =>
    buildWhatNextPromptV2({ text, brief, steer, bible })

  const { text, truncated } = fitTailToBudget(
    fullText,
    inputBudget('whatNext'),
    (cut) => build(cut).messages
  )
  const prompt = build(text)

  const result = await runAiRequest(deps, {
    feature: 'whatNext',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify({ text, brief, steer, bible })),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const { directions, dropped } = parseWhatNextAnswer(result.text)
  return {
    directions,
    dropped,
    truncated,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/**
 * The last `max` characters of `text`, cut from the front at a word boundary: the partial word
 * the cut lands in is dropped and an ellipsis marks the cut, so the result (ellipsis included)
 * is never longer than `max`. Text that fits comes back unchanged.
 */
export function tailText(text: string, max: number): string {
  if (text.length <= max) return text
  const tail = text.slice(text.length - (max - 1))
  const space = tail.search(/\s/)
  const cut = space === -1 ? tail : tail.slice(space).trimStart()
  return `…${cut === '' ? tail : cut}`
}

/**
 * The tail of the text that fits the input budget (token rule 8): `WHAT_NEXT_CHAR_BUDGET` first,
 * then `SHRINK_CHARS` less at a time while the built prompt is still over, down to
 * `WHAT_NEXT_TEXT_MIN` (the request path's own budget refusal takes over below that). Measured
 * as `runAiRequest` measures.
 */
export function fitTailToBudget(
  fullText: string,
  budget: number,
  build: (text: string) => AiMessage[]
): { text: string; truncated: boolean } {
  let chars = Math.min(fullText.length, WHAT_NEXT_CHAR_BUDGET)
  let text = tailText(fullText, chars)
  while (promptTokens(build(text)) > budget && chars > WHAT_NEXT_TEXT_MIN) {
    chars = Math.max(WHAT_NEXT_TEXT_MIN, chars - SHRINK_CHARS)
    text = tailText(fullText, chars)
  }
  return { text, truncated: fullText.length > chars }
}

function promptTokens(messages: AiMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}

/**
 * The model's `{ directions: [...] }`: PROVIDER when the answer is not JSON or not that shape
 * at all, and lenient direction by direction otherwise — the title and text are trimmed and cut
 * to `WHAT_NEXT_TITLE_MAX` / `WHAT_NEXT_TEXT_MAX`, and a direction of the wrong shape, with a
 * blank title or text, or past the `WHAT_NEXT_DIRECTIONS`th kept one is dropped and counted.
 */
export function parseWhatNextAnswer(text: string): {
  directions: WhatNextDirection[]
  dropped: number
} {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const directions: WhatNextDirection[] = []
  for (const entry of answer.data.directions) {
    if (directions.length >= WHAT_NEXT_DIRECTIONS) break
    const parsed = ModelDirection.safeParse(entry)
    if (!parsed.success) continue
    const title = cut(parsed.data.title, WHAT_NEXT_TITLE_MAX)
    const body = cut(parsed.data.text, WHAT_NEXT_TEXT_MAX)
    if (title && body) directions.push({ title, text: body })
  }
  return { directions, dropped: answer.data.directions.length - directions.length }
}

function cut(value: string, max: number): string {
  return value.trim().slice(0, max).trim()
}
