import { z } from 'zod'
import { parseStoredSceneMeta, type SceneMeta } from '@shared/sceneMeta'
import {
  SUMMARY_BANK_NAMES_MAX,
  SUMMARY_CHARACTER_MAX,
  SUMMARY_CHARACTERS_MAX,
  SUMMARY_KEY_POINT_MAX,
  SUMMARY_KEY_POINTS_MAX,
  SUMMARY_MAX_CHARS,
  SUMMARY_SCENE_CHAR_BUDGET,
  SUMMARY_TEXT_MIN,
  type SceneSummary,
  type StoredSceneSummary
} from '@shared/summary'
import { deleteSummary, getSummary, summariesFor, upsertSummary } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import { listTags } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'
import { documentText, manuscriptDocuments } from '../voice/profile'
import { headTruncate } from './context/chatContext'
import { assertFeatureAllowed } from './dial'
import { buildSummaryPrompt, SUMMARY_PROMPT_VERSION } from './prompts/summary.v1'
import { AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * The scene-summary use case (F-5.6). It runs in the background, so it is deliberately quiet
 * and cheap: the gate first (`summary` must be allowed), then the node must be a manuscript
 * document holding at least `SUMMARY_TEXT_MIN` characters, then exactly the context the
 * data-sharing panel lists — the scene head-truncated to `SUMMARY_SCENE_CHAR_BUDGET`, its
 * metadata line, and the bank's character names so the cast is spelled the author's way.
 *
 * Invalidation is by content hash, never by time (CLAUDE.md, token efficiency rule 4): a
 * stored row made from the same hash by the same prompt version is answered without a
 * request at all, so a save that changed nothing the summary saw costs nothing. The answer is
 * JSON on the `fast` tier (token rule 1) and is stored, not proposed: a summary is derived
 * index data, nothing enters the manuscript, and its cost lives in the usage ledger alone.
 */

const BAD_FORMAT = 'The model did not answer in the expected format.'

/** What the request was built from; the handler reuses it to tell a stale row from a current one. */
export interface SummarySource {
  /** The scene text as it is sent: head-truncated to the budget. */
  sceneText: string
  /** The scene's full plain-text length, before the truncation. */
  length: number
  truncated: boolean
  /** The scene's metadata when any field is set, else null. */
  meta: SceneMeta | null
  /** The bank's character names, capped for the prompt. */
  characters: string[]
  /** sha256 over everything that shapes the messages; a different hash means a stale row. */
  contentHash: string
}

/**
 * Everything a summary of `nodeId` would be made from, or null when the node is not a
 * manuscript document (front and end matter, folders, an unknown id): those never carry a
 * summary, so `summary:get` answers `UNAVAILABLE_SUMMARY` for them. One owner for the hash,
 * so the staleness check and the run can never disagree about what "unchanged" means.
 */
export function summarySource(db: TreeDb, nodeId: string): SummarySource | null {
  const row = manuscriptDocuments(db).find((document) => document.id === nodeId)
  if (row === undefined) return null

  const fullText = documentText(row).trim()
  const sceneText = headTruncate(fullText, SUMMARY_SCENE_CHAR_BUDGET)
  const stored = parseStoredSceneMeta(row.sceneMeta)
  const meta = stored.location || stored.pov || stored.timeline ? stored : null
  const characters = listTags(db)
    .filter((tag) => tag.category === 'character')
    .map((tag) => tag.name)
    .slice(0, SUMMARY_BANK_NAMES_MAX)

  return {
    sceneText,
    length: fullText.length,
    truncated: fullText.length > SUMMARY_SCENE_CHAR_BUDGET,
    meta,
    characters,
    // Only the three metadata fields the prompt renders: an edited brief must not cost a rerun.
    contentHash: sha256(
      JSON.stringify({
        sceneText,
        meta:
          meta === null
            ? null
            : { location: meta.location, pov: meta.pov, timeline: meta.timeline },
        characters
      })
    )
  }
}

/**
 * Every manuscript document that should have a summary and does not have a current one
 * (F-5.13, "Summarize all scenes"): long enough to be worth summarising, and either no stored
 * row, a row made from different text, or one from an older prompt version. In reading order,
 * so the queue works through the book from the front. The staleness test is `summarySource`'s
 * hash, the same one `summary:get` shows as "Out of date", so the button and the pane can
 * never disagree; a scene whose hash still matches is left alone and costs nothing.
 */
export function staleSummaryNodeIds(db: TreeDb): string[] {
  const rows = manuscriptDocuments(db)
  const stored = summariesFor(
    db,
    rows.map((row) => row.id)
  )
  const stale: string[] = []
  for (const row of rows) {
    const source = summarySource(db, row.id)
    if (source === null || source.length < SUMMARY_TEXT_MIN) continue
    const current = stored.get(row.id)
    if (
      current?.contentHash === source.contentHash &&
      current.promptVersion === SUMMARY_PROMPT_VERSION
    ) {
      continue
    }
    stale.push(row.id)
  }
  return stale
}

export interface SummarizeSceneInput {
  nodeId: string
  /**
   * The caller's id for `ai:cancel` (F-5.10). A background job carries the queue's own
   * `job-<n>` (F-5.13), so Cancel can stop it too; `ai:summarize` passes the renderer's.
   */
  requestId?: string
}

export interface SummarizeSceneResult {
  /** The row as it now stands, fresh or served from the content-hash match. */
  summary: StoredSceneSummary
  usage: CompletionUsage
  costUsd: number
  /** True for a stored row answered without a request, or a local response-cache hit. */
  cached: boolean
  model: string
  promptVersion: string
}

export async function summarizeScene(
  db: TreeDb,
  deps: AiRequestDeps,
  input: SummarizeSceneInput
): Promise<SummarizeSceneResult> {
  assertFeatureAllowed(getAiSettings(db), 'summary')

  const source = summarySource(db, input.nodeId)
  if (source === null) {
    throw new AppError('VALIDATION', 'Only a scene in the manuscript can be summarised', {
      nodeId: input.nodeId
    })
  }
  if (source.length < SUMMARY_TEXT_MIN) {
    // A scene cut back below the gate keeps no summary: a stale one would state what is gone.
    deleteSummary(db, input.nodeId)
    throw new AppError(
      'VALIDATION',
      `Write at least ${SUMMARY_TEXT_MIN} characters in this scene before summarising it`,
      { nodeId: input.nodeId, length: source.length }
    )
  }

  const stored = getSummary(db, input.nodeId)
  if (
    stored !== null &&
    stored.contentHash === source.contentHash &&
    stored.promptVersion === SUMMARY_PROMPT_VERSION
  ) {
    return {
      summary: stored,
      usage: { inputTokens: 0, outputTokens: 0 },
      costUsd: 0,
      cached: true,
      model: stored.model,
      promptVersion: stored.promptVersion
    }
  }

  const prompt = buildSummaryPrompt({
    sceneText: source.sceneText,
    meta: source.meta,
    characters: source.characters
  })
  const result = await runAiRequest(deps, {
    feature: 'summary',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: source.contentHash,
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const summary: StoredSceneSummary = {
    ...parseSummaryAnswer(result.text),
    nodeId: input.nodeId,
    contentHash: source.contentHash,
    promptVersion: prompt.version,
    model: result.model,
    truncated: source.truncated,
    createdAt: deps.now().toISOString()
  }
  upsertSummary(db, summary)

  return {
    summary,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/** The shape the prompt asks for; every field is read as unknown so one bad list is not a failure. */
const ModelAnswer = z.object({
  summary: z.unknown().optional(),
  keyPoints: z.unknown().optional(),
  characters: z.unknown().optional()
})

/**
 * The model's `{ summary, keyPoints, characters }`: PROVIDER when the answer is not JSON, not
 * an object, or carries no summary — a row with nothing to say is worse than no row. The two
 * lists are lenient, because a dropped key point costs the author nothing: anything that is
 * not a string goes, each entry is trimmed and cut to its cap, blanks and case-insensitive
 * duplicates go, and the rest is capped in count.
 */
export function parseSummaryAnswer(text: string): SceneSummary {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const raw = answer.data.summary
  const summary = typeof raw === 'string' ? raw.trim().slice(0, SUMMARY_MAX_CHARS).trim() : ''
  if (summary.length === 0) throw new AiFallbackError(BAD_FORMAT)

  return {
    summary,
    keyPoints: cleanList(answer.data.keyPoints, SUMMARY_KEY_POINT_MAX, SUMMARY_KEY_POINTS_MAX),
    characters: cleanList(answer.data.characters, SUMMARY_CHARACTER_MAX, SUMMARY_CHARACTERS_MAX)
  }
}

function cleanList(value: unknown, itemMax: number, countMax: number): string[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const kept: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string') continue
    const cleaned = entry.trim().slice(0, itemMax).trim()
    if (cleaned.length === 0) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    kept.push(cleaned)
    if (kept.length === countMax) break
  }
  return kept
}
