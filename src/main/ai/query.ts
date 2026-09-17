import { z } from 'zod'
import { estimateTokens, inputBudget } from '@shared/ai'
import { findQuote, normalizeForMatch } from '@shared/critique'
import {
  QUERY_ALSO_MAX,
  QUERY_ANSWER_MAX,
  QUERY_MAX_CITATIONS,
  QUERY_QUOTE_MAX,
  QUERY_SCENE_CHAR_FLOOR,
  QUERY_SHRINK_CHARS,
  stripDanglingMarkers,
  type QueryCitation,
  type QuerySceneRef
} from '@shared/query'
import { AppError } from '../ipc/errors'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { headTruncate } from './context/chatContext'
import { rankCandidates } from './context/queryContext'
import { assertFeatureAllowed } from './dial'
import type { ChatTurn } from './prompts/chat.v1'
import { buildQueryPrompt } from './prompts/query.v1'
import { AiFallbackError, type AiMessage, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

export interface QueryInput {
  /** The active document, or null with none open; it breaks ranking ties. */
  nodeId: string | null
  /** The author's question. */
  message: string
  /** The recent turns the renderer keeps, oldest first. */
  history: ChatTurn[]
  /**
   * The caller's id for `ai:cancel` (F-5.10). Optional so the eval harness can run without
   * one; then the request cannot be stopped.
   */
  requestId?: string
}

export interface QueryResult {
  /** The answer, capped, with every `[n]` marker whose citation did not survive stripped out. */
  answer: string
  /** False when the model reported that the retrieved scenes do not answer the question. */
  found: boolean
  /** True when it claimed an answer but no citation survived the quote check. */
  uncited: boolean
  /** The citations main found in the text it sent, in the model's order. */
  citations: QueryCitation[]
  /** The ranked candidates the answer did not cite, best match first. */
  also: QuerySceneRef[]
  /** How many citations were dropped: a bad shape, a scene out of range, or a quote not found. */
  dropped: number
  usage: CompletionUsage
  costUsd: number
  cached: boolean
  model: string
  promptVersion: string
}

/** One retrieved scene as it goes into the prompt, with the text a citation is matched against. */
export interface QueryFullScene {
  nodeId: string
  title: string
  /** Plain text as sent: head-truncated by the ranker and shrunk further by the fit. */
  text: string
}

/** One further candidate sent as its stored summary (F-5.6); never a citation source. */
export interface QuerySummaryScene {
  nodeId: string
  /** The summary row's content hash, so the cache key changes when a summary is rewritten. */
  contentHash: string
  title: string
  summary: string
  keyPoints: string[]
}

const ModelAnswer = z.object({
  found: z.unknown(),
  answer: z.string(),
  citations: z.array(z.unknown()).optional()
})
const ModelCitation = z.object({ scene: z.number(), quote: z.string() })

const BAD_FORMAT = 'The model did not answer in the expected format.'

/**
 * Story Intelligence (F-5.7). The gate first (`query` must be allowed: nothing is read or sent
 * below Ask or with the feature off), then the manuscript must hold at least one document with
 * text, then retrieval: `rankCandidates` scores every manuscript document locally and hands
 * back the top few in full, the next few as their stored summaries, and the whole ranked list.
 * Never the whole manuscript (CLAUDE.md, token rule 2).
 *
 * `fitQueryPrompt` then counts before sending (token rule 8) and trims by priority rather than
 * failing: the full scenes shrink to their floor first, then the summaries go, then the
 * lowest-ranked full scenes (one always stays), then the oldest history turns. The answer is
 * JSON on the strong tier (token rule 1: queries may use `strong`) and is not streamed, because
 * the citations have to be checked before anything is shown.
 *
 * Every citation is verified against the scene text as it was sent (the F-14.8 rule), so the
 * author never sees a passage nobody wrote; the rest are dropped and counted, their `[n]`
 * markers stripped from the answer. An answer with no surviving citation comes back `uncited`
 * and the panel says so, and `found: false` is a valid answer, not a failure (author-control
 * rule 4). Nothing enters the manuscript: the proposal the handler writes stays pending.
 */
export async function runQuery(
  db: TreeDb,
  deps: AiRequestDeps,
  input: QueryInput
): Promise<QueryResult> {
  const settings = getAiSettings(db)
  assertFeatureAllowed(settings, 'query')

  const candidates = rankCandidates(db, { question: input.message, nodeId: input.nodeId })
  if (candidates.ranked.length === 0) {
    throw new AppError('VALIDATION', 'Write a scene before asking about the manuscript', {
      nodeId: input.nodeId
    })
  }

  const full: QueryFullScene[] = candidates.full.map((candidate) => ({
    nodeId: candidate.nodeId,
    title: candidate.title,
    text: candidate.text
  }))
  const summaries: QuerySummaryScene[] = candidates.summaries.flatMap((candidate) =>
    candidate.summary === null
      ? []
      : [
          {
            nodeId: candidate.nodeId,
            contentHash: candidate.summary.contentHash,
            title: candidate.title,
            summary: candidate.summary.summary,
            keyPoints: candidate.summary.keyPoints
          }
        ]
  )

  const fit = fitQueryPrompt(
    { full, summaries, history: input.history },
    inputBudget('query'),
    (scenes, summarised, history) =>
      buildQueryPrompt({
        full: scenes,
        summaries: summarised,
        history,
        question: input.message
      }).messages
  )
  const prompt = buildQueryPrompt({
    full: fit.full,
    summaries: fit.summaries,
    history: fit.history,
    question: input.message
  })

  const result = await runAiRequest(deps, {
    feature: 'query',
    tier: 'strong',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(
      JSON.stringify({
        question: input.message,
        history: fit.history,
        full: fit.full.map((scene) => [scene.nodeId, scene.text]),
        summaries: fit.summaries.map((scene) => [scene.nodeId, scene.contentHash])
      })
    ),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })

  const parsed = parseQueryAnswer(result.text, fit.full)
  const cited = new Set(parsed.citations.map((citation) => citation.nodeId))
  return {
    answer: parsed.answer,
    found: parsed.found,
    uncited: parsed.uncited,
    citations: parsed.citations,
    also: candidates.ranked
      .filter((candidate) => !cited.has(candidate.nodeId))
      .slice(0, QUERY_ALSO_MAX)
      .map((candidate) => ({ nodeId: candidate.nodeId, title: candidate.title })),
    dropped: parsed.dropped,
    usage: result.usage,
    costUsd: result.costUsd,
    cached: result.cached,
    model: result.model,
    promptVersion: prompt.version
  }
}

/**
 * The retrieval that fits the feature's input budget (CLAUDE.md, token efficiency rule 8), in
 * the order that keeps what the answer most needs. The full scenes shrink together — the
 * longest one loses `QUERY_SHRINK_CHARS` at a time, never below `QUERY_SCENE_CHAR_FLOOR` —
 * because a cited passage can be anywhere in a scene and cutting one scene to nothing while
 * another rides along whole would bias the answer. Then the summaries go, lowest-ranked first
 * (they orient, they cannot be cited); then the oldest history turns down to the last
 * `QUERY_HISTORY_KEEP`, since the retrieved scenes are what the answer cites and a follow-up
 * question needs only the exchange it follows on from; then the lowest-ranked full scenes, with
 * the best match always kept; and only last the remaining history. Measured exactly as
 * `runAiRequest` measures. Pure, so the fit is tested without a project.
 */
/** The most recent history turns the fit keeps ahead of dropping a full scene (one exchange). */
export const QUERY_HISTORY_KEEP = 2

export function fitQueryPrompt(
  input: { full: QueryFullScene[]; summaries: QuerySummaryScene[]; history: ChatTurn[] },
  budget: number,
  build: (
    full: QueryFullScene[],
    summaries: QuerySummaryScene[],
    history: ChatTurn[]
  ) => AiMessage[]
): { full: QueryFullScene[]; summaries: QuerySummaryScene[]; history: ChatTurn[] } {
  const originals = input.full.map((scene) => scene.text)
  const chars = originals.map((text) => text.length)
  let kept = input.full.length
  let summaries = input.summaries
  let history = input.history
  const scenes = (): QueryFullScene[] =>
    input.full
      .slice(0, kept)
      .map((scene, index) => ({
        ...scene,
        text: headTruncate(originals[index] ?? '', chars[index] ?? 0)
      }))
  const over = (): boolean => promptTokens(build(scenes(), summaries, history)) > budget

  while (over()) {
    let longest = -1
    for (let index = 0; index < kept; index++) {
      const length = chars[index] ?? 0
      if (length > QUERY_SCENE_CHAR_FLOOR && (longest === -1 || length > (chars[longest] ?? 0))) {
        longest = index
      }
    }
    if (longest === -1) break
    chars[longest] = Math.max(QUERY_SCENE_CHAR_FLOOR, (chars[longest] ?? 0) - QUERY_SHRINK_CHARS)
  }
  while (over() && summaries.length > 0) summaries = summaries.slice(0, -1)
  while (over() && history.length > QUERY_HISTORY_KEEP) history = history.slice(1)
  while (over() && kept > 1) kept -= 1
  while (over() && history.length > 0) history = history.slice(1)
  return { full: scenes(), summaries, history }
}

/** The request path's own estimate, so the fit measures what the budget check measures. */
function promptTokens(messages: AiMessage[]): number {
  return estimateTokens(messages.map((message) => message.content).join('\n'))
}

/**
 * The model's `{ found, answer, citations }` against the scenes that were sent in full
 * (`scenes[i]` is scene `i + 1`): PROVIDER when the answer is not JSON or not that shape at
 * all, and citation by citation otherwise. A citation whose scene number is not one that went
 * out in full, whose quote is blank, or whose quote is not in that scene's text as sent is
 * dropped and counted, so no citation ever points the author at words nobody wrote; duplicates
 * by scene and normalized quote collapse and the list is capped at `QUERY_MAX_CITATIONS`. The
 * answer is trimmed, capped, and stripped of the `[n]` markers whose citation did not survive.
 *
 * `found: false` is the grounded "not found" answer (CLAUDE.md, author-control rule 4): any
 * citations it came with are discarded rather than counted as dropped, since the model itself
 * said the scenes do not answer. `found` with nothing left to cite is `uncited`, which the
 * panel shows as a warning rather than hiding the answer.
 */
export function parseQueryAnswer(
  text: string,
  scenes: QueryFullScene[]
): {
  answer: string
  found: boolean
  uncited: boolean
  citations: QueryCitation[]
  dropped: number
} {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const parsed = ModelAnswer.safeParse(json)
  if (!parsed.success) throw new AiFallbackError(BAD_FORMAT, parsed.error)

  const found = Boolean(parsed.data.found)
  const answer = parsed.data.answer.trim().slice(0, QUERY_ANSWER_MAX).trim()
  if (!found) {
    return {
      answer: stripDanglingMarkers(answer, []),
      found: false,
      uncited: false,
      citations: [],
      dropped: 0
    }
  }

  const citations: QueryCitation[] = []
  const seen = new Set<string>()
  let dropped = 0
  for (const entry of parsed.data.citations ?? []) {
    const citation = ModelCitation.safeParse(entry)
    if (!citation.success) {
      dropped += 1
      continue
    }
    const number = citation.data.scene
    const scene = Number.isInteger(number) ? scenes[number - 1] : undefined
    const quote = citation.data.quote.trim().slice(0, QUERY_QUOTE_MAX).trim()
    if (scene === undefined || !quote || !findQuote(scene.text, quote)) {
      dropped += 1
      continue
    }
    const key = `${number}:${normalizeForMatch(quote)}`
    if (seen.has(key)) continue
    seen.add(key)
    citations.push({ nodeId: scene.nodeId, title: scene.title, scene: number, quote })
    if (citations.length === QUERY_MAX_CITATIONS) break
  }
  return {
    answer: stripDanglingMarkers(
      answer,
      citations.map((citation) => citation.scene)
    ),
    found: true,
    uncited: citations.length === 0,
    citations,
    dropped
  }
}
