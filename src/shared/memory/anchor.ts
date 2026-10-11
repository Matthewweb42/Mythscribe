import { normalizeForMatch } from '../critique'
import type { QuoteLocation } from './quote'
import { splitSentences } from './sentences'

/**
 * Anchors (F-16.3; design §2.3, Invalidation): a claim stays live only while the sentences that
 * proved it are unchanged. An anchor is the hashes of the quote's sentences ±1 (across paragraph
 * boundaries), plus the sentence that names a pronoun subject. On every save the scene's sentence
 * hashes are recomputed and a claim whose anchor no longer holds goes stale.
 *
 * Names stay in the hashed text: Rename in book (F-16.13) rewrites anchors with the names, and
 * only the reading gate's own hash (F-16.16) leaves names out.
 */

/** Hex digits in a sentence hash: cyrb53 is 53 bits. */
export const SENTENCE_HASH_LENGTH = 14

/**
 * cyrb53 (public domain, bryc): a fast 53-bit string hash in plain JS, so main and the renderer
 * agree without node:crypto. Collisions do not matter at book scale (a few thousand sentences).
 */
function cyrb53(text: string): number {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507)
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507)
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return 4294967296 * (2097151 & h2) + (h1 >>> 0)
}

/** A sentence's hash: `normalizeForMatch`, then cyrb53, as 14 hex characters. */
export function sentenceHash(text: string): string {
  return cyrb53(normalizeForMatch(text)).toString(16).padStart(SENTENCE_HASH_LENGTH, '0')
}

/** One sentence of a scene, in reading order. */
export interface SceneSentence {
  /** The paragraph it is in. */
  p: number
  /** Its index in `splitSentences(paragraph)`. */
  index: number
  text: string
  hash: string
}

/** Every sentence of a scene, paragraph by paragraph, with its hash. */
export function sceneSentences(paragraphs: readonly string[]): SceneSentence[] {
  return paragraphs.flatMap((paragraph, p) =>
    splitSentences(paragraph).map((span, index) => ({
      p,
      index,
      text: span.text,
      hash: sentenceHash(span.text)
    }))
  )
}

/** The hashes a claim's proof rests on, in reading order, without repeats. */
export type MemoryAnchor = readonly string[]

/**
 * The anchor of a located quote: its sentences and one either side (across paragraph
 * boundaries), plus `namingSentence` (a position in `sentences`) when the subject was a pronoun.
 * Empty when the location names no sentence of `sentences`.
 */
export function anchorFor(
  sentences: readonly SceneSentence[],
  location: Pick<QuoteLocation, 'p' | 'sentences'>,
  namingSentence?: number
): MemoryAnchor {
  const positions = sentences
    .map((sentence, position) => ({ sentence, position }))
    .filter(
      ({ sentence }) => sentence.p === location.p && location.sentences.includes(sentence.index)
    )
    .map(({ position }) => position)
  if (positions.length === 0) return []
  const first = Math.max(Math.min(...positions) - 1, 0)
  const last = Math.min(Math.max(...positions) + 1, sentences.length - 1)
  const picked = new Set<number>()
  for (let position = first; position <= last; position += 1) picked.add(position)
  if (namingSentence !== undefined && sentences[namingSentence] !== undefined) {
    picked.add(namingSentence)
  }
  const hashes: string[] = []
  for (const position of [...picked].sort((a, b) => a - b)) {
    const hash = sentences[position]?.hash
    if (hash !== undefined && !hashes.includes(hash)) hashes.push(hash)
  }
  return hashes
}

/** Whether every sentence an anchor rests on is still in the scene (`present` is its hashes). */
export function anchorHolds(anchor: MemoryAnchor, present: ReadonlySet<string>): boolean {
  return anchor.every((hash) => present.has(hash))
}
