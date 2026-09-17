import { z } from 'zod'
import { estimateTokens, inputBudget } from '@shared/ai'
import {
  BETA_READER_CATEGORIES,
  BETA_READER_MAX_ITEMS,
  BETA_READER_NOTE_MAX,
  BETA_READER_QUOTE_MAX,
  BETA_READER_SCENE_CHAR_BUDGET,
  BETA_READER_SCENE_CHAR_FLOOR,
  BETA_READER_SHRINK_CHARS,
  BETA_READER_TEXT_MIN,
  type BetaReaderItem,
  type BetaReaderScene
} from '@shared/betaReader'
import { findQuote, normalizeForMatch } from '@shared/critique'
import { docToText } from '@shared/docText'
import { normalizeProposalNote } from '@shared/proposal'
import { getDocumentContent } from '../document/documentStore'
import { summariesFor } from '../document/summaryStore'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { headTruncate } from './context/chatContext'
import { sceneTitles } from './context/queryContext'
import { assertFeatureAllowed } from './dial'
import {
  buildBetaReaderPrompt,
  type BuildBetaReaderPromptInput,
  type BetaReaderPromptScene,
  type BuiltBetaReaderPrompt
} from './prompts/betaReader.v1'
import {
  buildBetaReaderRegenPrompt,
  type BuiltBetaReaderRegenPrompt
} from './prompts/betaReaderRegen.v1'
import { AiFallbackError, type AiMessage, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

export interface BetaReaderInput {
  /** The scene the reader reads up to; everything before it in reading order rides along. */
  nodeId: string
  /** The author's note from Ask again… (F-14.5); blank or absent is none. */
  note?: string | null
  /** The report these items replace (F-14.5), when the author asked again. */
  regeneratedFrom?: string | null
  /**
   * The caller's id for `ai:cancel` (F-5.10). Optional so the eval harness can run without
   * one; then the request cannot be stopped.
   */
  requestId?: string
}

export interface BetaReaderResult {
  /** What the reader reports: each item quotes the scene it names, as that scene was sent. */
  items: BetaReaderItem[]
  /** The scenes the reader read, in the order sent; the current one is last, `current: true`. */
  scenes: BetaReaderScene[]
  /** Whether the current scene was cut before it was sent (head-truncated, or shrunk to fit). */
  truncated: boolean
  /** How many of the farthest earlier scenes were left out to fit the input budget. */
  skipped: number
  /** How many earlier scenes had no stored summary, so the reader never read them. */
  missing: number
  /** How many items were dropped: a bad shape, a scene out of range, or an uncited quote. */
  dropped: number
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

/** One scene as it goes into the prompt, with the text an item citing it is matched against. */
interface ReadScene extends BetaReaderPromptScene {
  nodeId: string
  /** The summary row's content hash, so the cache key changes when a summary is rewritten. */
  contentHash: string
  /** `summary + key points`: exactly the text of this scene the model saw. */
  text: string
}

const ModelAnswer = z.object({ items: z.array(z.unknown()) })
const ModelItem = z.object({
  category: z.enum(BETA_READER_CATEGORIES),
  scene: z.number(),
  quote: z.string(),
  note: z.string()
})

const BAD_FORMAT = 'The model did not answer in the expected format.'

/**
 * The beta-reader use case (F-14.11). The gate first (`betaReader` must be allowed: nothing is
 * read or sent below Ask or with the feature off), then the node must be a manuscript document
 * holding at least `BETA_READER_TEXT_MIN` characters (NOT_FOUND / VALIDATION as everywhere
 * else), then exactly the context the data-sharing panel lists: every manuscript document
 * before it in reading order as its stored summary and key points (F-5.6), and the scene itself
 * head-truncated to `BETA_READER_SCENE_CHAR_BUDGET`. An earlier scene with no stored row is
 * skipped and counted in `missing` (the panel tells the author to turn summaries on); staleness
 * is not checked, because the stored row is what the reader has read. No voice profile, no
 * story bible, no brief: a first-time reader knows only what the page said, and that is what
 * makes the report worth reading.
 *
 * If the prompt is over `inputBudget('betaReader')` — a long manuscript is the normal case —
 * `fitReadThrough` shrinks the scene text first and then drops the farthest earlier scenes,
 * counted in `skipped` (CLAUDE.md, token efficiency rule 8), so a long book costs the same as a
 * short one and the reader keeps the scenes nearest the one in hand.
 *
 * The answer is JSON on the strong tier (token rule 1: the critique family) and is not
 * streamed: a report is only useful whole. Every item must quote the scene it names, matched
 * through `normalizeForMatch` against that scene's text as sent, so the author never sees a
 * claim about words nobody wrote; the rest are dropped and counted. Nothing is proposed for the
 * manuscript — a reader reports, the editor's notes (F-14.8) fix — so there is no fidelity
 * check and no Apply.
 *
 * A regenerate (F-14.5: a note, a predecessor proposal, or both) goes through
 * `betaReaderRegen.v1`, and the note and the predecessor join the context hash, so asking again
 * never answers from the cache with the report the author just turned down. The hash otherwise
 * covers everything that shaped the messages: the scene text as sent, the ordered summaries by
 * content hash, what was missing or skipped, and the honesty setting.
 */
export async function runBetaReader(
  db: TreeDb,
  deps: AiRequestDeps,
  input: BetaReaderInput
): Promise<BetaReaderResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'betaReader')

  const { content } = getDocumentContent(db, input.nodeId)
  const fullText = content ? docToText(content).trim() : ''
  if (fullText.length < BETA_READER_TEXT_MIN) {
    throw new AppError(
      'VALIDATION',
      `Write at least ${BETA_READER_TEXT_MIN} characters in this scene before asking your beta reader to read up to it`,
      { nodeId: input.nodeId, length: fullText.length }
    )
  }

  const documents = manuscriptDocuments(db)
  const index = documents.findIndex((row) => row.id === input.nodeId)
  const current = index === -1 ? undefined : documents[index]
  if (current === undefined) {
    throw new AppError(
      'VALIDATION',
      'The beta reader reads manuscript scenes: this document is not in the manuscript',
      { nodeId: input.nodeId }
    )
  }

  const title = sceneTitles(db)
  const earlier = documents.slice(0, index)
  const summaries = summariesFor(
    db,
    earlier.map((row) => row.id)
  )
  const read: ReadScene[] = []
  let missing = 0
  for (const row of earlier) {
    const summary = summaries.get(row.id)
    if (summary === undefined) {
      missing += 1
      continue
    }
    read.push({
      nodeId: row.id,
      title: title(row.id),
      summary: summary.summary,
      keyPoints: summary.keyPoints,
      contentHash: summary.contentHash,
      text: [summary.summary, ...summary.keyPoints].join('\n')
    })
  }

  const honesty = settings.critique.honesty
  const note = normalizeProposalNote(input.note)
  const regeneratedFrom = input.regeneratedFrom ?? null
  const isRegenerate = note !== null || regeneratedFrom !== null
  const currentTitle = title(current.id)
  const build = (
    sceneText: string,
    scenes: ReadScene[]
  ): BuiltBetaReaderPrompt | BuiltBetaReaderRegenPrompt => {
    const base: BuildBetaReaderPromptInput = {
      scenes,
      current: { title: currentTitle, text: sceneText },
      honesty
    }
    return isRegenerate ? buildBetaReaderRegenPrompt({ ...base, note }) : buildBetaReaderPrompt(base)
  }

  // Token rule 8: count before sending, and trim the read-through rather than overspend or fail.
  const fit = fitReadThrough(fullText, read, inputBudget('betaReader'), (sceneText, scenes) =>
    build(sceneText, scenes).messages
  )
  const prompt = build(fit.sceneText, fit.scenes)

  const result = await runAiRequest(deps, {
    feature: 'betaReader',
    tier: 'strong',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(
      JSON.stringify({
        sceneText: fit.sceneText,
        scenes: fit.scenes.map((scene) => [scene.nodeId, scene.contentHash]),
        missing,
        skipped: fit.skipped,
        honesty,
        note,
        regeneratedFrom: isRegenerate ? regeneratedFrom : null
      })
    ),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const texts = [...fit.scenes.map((scene) => scene.text), fit.sceneText]
  const { items, dropped } = parseBetaReaderAnswer(result.text, texts)
  return {
    items,
    scenes: [
      ...fit.scenes.map((scene) => ({ nodeId: scene.nodeId, title: scene.title, current: false })),
      { nodeId: current.id, title: currentTitle, current: true }
    ],
    truncated: fit.truncated,
    skipped: fit.skipped,
    missing,
    dropped,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/**
 * The read-through that fits the feature's input budget (CLAUDE.md, token efficiency rule 8),
 * in the order that keeps what the reader most needs: the current scene is cut from
 * `BETA_READER_SCENE_CHAR_BUDGET` down to `BETA_READER_SCENE_CHAR_FLOOR` first,
 * `BETA_READER_SHRINK_CHARS` at a time (the scene is the expensive part and its opening is
 * where the reader's expectations were set), and only then are the farthest earlier scenes
 * dropped one at a time and counted in `skipped`. Measured exactly as `runAiRequest` measures.
 * Pure, so the fit is tested without a project.
 */
export function fitReadThrough<Scene>(
  fullText: string,
  scenes: Scene[],
  budget: number,
  build: (sceneText: string, scenes: Scene[]) => AiMessage[]
): { sceneText: string; scenes: Scene[]; truncated: boolean; skipped: number } {
  let chars = Math.min(fullText.length, BETA_READER_SCENE_CHAR_BUDGET)
  let sceneText = headTruncate(fullText, chars)
  let kept = scenes
  while (promptTokens(build(sceneText, kept)) > budget && chars > BETA_READER_SCENE_CHAR_FLOOR) {
    chars = Math.max(BETA_READER_SCENE_CHAR_FLOOR, chars - BETA_READER_SHRINK_CHARS)
    sceneText = headTruncate(fullText, chars)
  }
  let skipped = 0
  while (promptTokens(build(sceneText, kept)) > budget && kept.length > 0) {
    kept = kept.slice(1)
    skipped += 1
  }
  return { sceneText, scenes: kept, truncated: fullText.length > chars, skipped }
}

/** The request path's own estimate, so the fit measures what the budget check measures. */
function promptTokens(messages: AiMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}

/**
 * The model's `{ items: [...] }` against the scenes that were sent (`texts[i]` is the text of
 * scene `i + 1`, the current scene last): PROVIDER when the answer is not JSON or not that
 * shape at all, and item by item otherwise. An item with an unknown category, a scene number
 * that is not a whole number in range, a blank quote or note, or — the citation rule F-14.8
 * turned on — a quote that is not in the scene it names is dropped and counted, so no item
 * ever tells the author about words that scene does not contain. The strings are trimmed and
 * capped; duplicates by scene and quote collapse and the list is capped at
 * `BETA_READER_MAX_ITEMS`.
 */
export function parseBetaReaderAnswer(
  text: string,
  texts: string[]
): { items: BetaReaderItem[]; dropped: number } {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const answer = ModelAnswer.safeParse(json)
  if (!answer.success) throw new AiFallbackError(BAD_FORMAT, answer.error)

  const items: BetaReaderItem[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of answer.data.items) {
    const parsed = ModelItem.safeParse(entry)
    if (!parsed.success) {
      dropped += 1
      continue
    }
    const scene = parsed.data.scene
    const source = Number.isInteger(scene) ? texts[scene - 1] : undefined
    const quote = parsed.data.quote.trim().slice(0, BETA_READER_QUOTE_MAX).trim()
    const note = parsed.data.note.trim().slice(0, BETA_READER_NOTE_MAX).trim()
    if (source === undefined || !quote || !note || !findQuote(source, quote)) {
      dropped += 1
      continue
    }
    const key = `${scene}:${normalizeForMatch(quote)}`
    if (seen.has(key)) continue
    seen.add(key)
    items.push({ category: parsed.data.category, scene, quote, note })
    if (items.length === BETA_READER_MAX_ITEMS) break
  }
  return { items, dropped }
}
