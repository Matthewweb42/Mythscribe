import { z } from 'zod'

/**
 * Story Intelligence query mode (F-5.7): the third assistant mode. The author asks a question
 * about the whole manuscript; main ranks the manuscript's scenes as candidates from their
 * titles, tags, metadata, and stored summaries (F-5.6), loads the full text of only the top
 * matches within the feature's input budget, and asks the strong tier for a JSON answer that
 * cites the scenes it rests on. Every citation names a scene and quotes a passage main found
 * in that scene's text as sent (the F-14.8 rule); the rest are dropped and counted. An answer
 * with no surviving citation is shown flagged as uncited, and "not found" is a valid answer
 * (CLAUDE.md, author-control rule 4). No embeddings yet: ranking is lexical (PLAN.md §2.5 keeps
 * vectors for a later feature).
 */

/** How many top-ranked scenes ride along in full. */
export const QUERY_FULL_SCENES = 3
/** How many further candidates ride along as their stored summary and key points. */
export const QUERY_SUMMARY_SCENES = 10
/** Each full scene is head-truncated to this many characters before it is sent. */
export const QUERY_SCENE_CHAR_BUDGET = 12_000
/** The fit shrinks a full scene this many characters at a time, never below the floor. */
export const QUERY_SHRINK_CHARS = 2_000
export const QUERY_SCENE_CHAR_FLOOR = 3_000
/** Citations kept per answer, in the model's order. */
export const QUERY_MAX_CITATIONS = 6
/** A citation's quote is capped to this many characters. */
export const QUERY_QUOTE_MAX = 240
/** The answer text is capped to this many characters. */
export const QUERY_ANSWER_MAX = 2_000
/** How many uncited candidates the "Also mentioned in" list names. */
export const QUERY_ALSO_MAX = 8
/** The line shown when the model reports that the scenes do not answer the question. */
export const QUERY_NOT_FOUND = 'Not found in the manuscript.'

/** A scene the answer points at: enough to open it from the chat. */
export const QuerySceneRef = z.object({
  nodeId: z.string(),
  /** `Chapter › Scene`, as the beta reader names scenes (F-14.11). */
  title: z.string()
})
export type QuerySceneRef = z.infer<typeof QuerySceneRef>

/**
 * One citation: the scene's number as it was sent (the `[n]` markers in the answer refer to
 * it), the scene, and the passage main found in the text that was sent.
 */
export const QueryCitation = QuerySceneRef.extend({
  scene: z.number().int().positive(),
  quote: z.string().min(1).max(QUERY_QUOTE_MAX)
})
export type QueryCitation = z.infer<typeof QueryCitation>

/** What a Query-mode assistant turn carries beside its answer text. */
export const QueryTurn = z.object({
  /** False when the model reported that the scenes do not answer the question. */
  found: z.boolean(),
  /** True when the model claimed an answer but no citation survived the quote check. */
  uncited: z.boolean(),
  citations: z.array(QueryCitation).max(QUERY_MAX_CITATIONS),
  /** Ranked candidates the answer did not cite, best match first. */
  also: z.array(QuerySceneRef).max(QUERY_ALSO_MAX)
})
export type QueryTurn = z.infer<typeof QueryTurn>

/** A `[n]` citation marker in an answer, with optional space before it. */
export const CITATION_MARKER = /\s?\[(\d+)\]/g

/**
 * The scene numbers an answer's `[n]` markers name, first appearance first, deduplicated.
 * Shared by main (to strip dangling markers) and the renderer (to render the live ones).
 */
export function citedSceneNumbers(answer: string): number[] {
  const numbers: number[] = []
  for (const match of answer.matchAll(CITATION_MARKER)) {
    const n = Number(match[1])
    if (Number.isInteger(n) && n > 0 && !numbers.includes(n)) numbers.push(n)
  }
  return numbers
}

/** `answer` without the `[n]` markers whose scene number is not in `kept`. */
export function stripDanglingMarkers(answer: string, kept: readonly number[]): string {
  return answer
    .replace(CITATION_MARKER, (marker, digits: string) =>
      kept.includes(Number(digits)) ? marker : ''
    )
    .trim()
}
