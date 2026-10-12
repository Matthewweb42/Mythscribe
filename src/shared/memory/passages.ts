import { z } from 'zod'
import { MEMORY_SOURCES, meaningOf, type MemorySource } from './sources'

/**
 * The local passage index of story memory v2 (F-16.5): one FTS5 table (`memory_passage_fts`,
 * migration 0031) over the manuscript, scene notes, Pinned, Ideas, Research and (F-16.18) the
 * scenes' card lines and gists, each row labelled with its source and its paragraph's canon
 * status, so a search answer says what a hit means (`meaningOf`). Free and local; it works with
 * Use AI off. Card rows are a map, never canon: a search leaves them out unless asked for them
 * (`DEFAULT_PASSAGE_SOURCES`).
 */

/** The sources a passage row can come from: a subset of `MemorySource`. */
export const PASSAGE_SOURCES = [
  'scene',
  'sceneNote',
  'pinned',
  'idea',
  'note',
  'research',
  'ideaScene',
  'excludedScene',
  'card'
] as const satisfies readonly MemorySource[]
export const PassageSource = z.enum(PASSAGE_SOURCES)
export type PassageSource = z.infer<typeof PassageSource>

/** What a search covers when it names no sources: everything but the card lines (a map). */
export const DEFAULT_PASSAGE_SOURCES: readonly PassageSource[] = PASSAGE_SOURCES.filter(
  (source) => source !== 'card'
)

/**
 * A paragraph's canon status: `notCanon` when it is never real (design §2.2 "Meaning by place"),
 * because the author marked it, or its page, Not canon, or because of where it is (Ideas, an Idea
 * scene, a scene left out of compile); `canon` otherwise.
 */
export const PASSAGE_CANON = ['canon', 'notCanon'] as const
export const PassageCanon = z.enum(PASSAGE_CANON)
export type PassageCanon = z.infer<typeof PassageCanon>

/**
 * Whether text from `source` is never real wherever the author is (Ideas, Idea and left-out
 * scenes) or is a map (a card line, F-16.18): both are `notCanon` and keep their own label.
 */
const neverReal = (source: PassageSource): boolean => {
  const meaning = meaningOf(source, { order: 0, openOrder: 0 })
  return meaning === 'never' || meaning === 'map'
}

/** A paragraph's canon status from its source and its Not canon mark. */
export function passageCanon(source: PassageSource, marked: boolean): PassageCanon {
  return marked || neverReal(source) ? 'notCanon' : 'canon'
}

/**
 * The source a hit reads as: where it is when that is never real already (`idea`, `ideaScene`,
 * `excludedScene`) or a map (`card`), else `notCanon` when marked so, else where it is.
 */
export function passageLabel(source: PassageSource, canon: PassageCanon): MemorySource {
  return canon === 'notCanon' && !neverReal(source) ? 'notCanon' : source
}

/**
 * Who owns a group of passage rows (and a `memory_scan` row): a scene, its notes, a record, a
 * Research page, or a scene's card (F-16.18, keyed by the scene's node id).
 */
export const MEMORY_OWNER_KINDS = ['scene', 'sceneNote', 'record', 'research', 'card'] as const
export const MemoryOwnerKind = z.enum(MEMORY_OWNER_KINDS)
export type MemoryOwnerKind = z.infer<typeof MemoryOwnerKind>

/** Most hits `passages:search` answers. */
export const MEMORY_PASSAGE_SEARCH_MAX = 50

export const MemoryPassageQuery = z.object({
  query: z.string().max(500),
  sources: z.array(PassageSource).optional(),
  limit: z.number().int().min(1).max(MEMORY_PASSAGE_SEARCH_MAX).default(10)
})
export type MemoryPassageQuery = z.input<typeof MemoryPassageQuery>

export const MemoryPassageHit = z.object({
  source: PassageSource,
  /** The scene's node id (`scene`, `sceneNote`, `card`, …) or the record's id (`pinned`, `idea`). */
  ownerId: z.string(),
  /** The paragraph's index in its document or page. */
  para: z.number().int(),
  /** `notCanon` whenever the hit is never real: marked so, or Ideas, an Idea or left-out scene. */
  canon: PassageCanon,
  /** What the hit reads as (`passageLabel`), for `meaningOf`. */
  label: z.enum(MEMORY_SOURCES),
  /** The matching stretch, plain text, with `…` where it was cut. */
  snippet: z.string(),
  /** Higher is better (bm25, negated). */
  score: z.number()
})
export type MemoryPassageHit = z.infer<typeof MemoryPassageHit>
