import { estimateTokens } from '../ai'
import { splitSentences } from './sentences'

/**
 * What a reading sends (F-16.16, F-16.17; design §2.3 "Window" and "Output caps"): the changed
 * paragraphs ±2, extended back to the last paragraph that names a record (so a pronoun has its
 * antecedent), merged, and split at paragraph boundaries when over 1,500 prose tokens; or, for a
 * full read, the whole scene in pages of at most 2,500 tokens, a longer paragraph split at
 * sentence boundaries and never truncated. Pure: paragraph texts in, pieces out.
 */

/** Paragraphs of context either side of a changed one. */
export const WINDOW_CONTEXT = 2
/** A window piece's most prose tokens before it is split at a paragraph boundary. */
export const WINDOW_SPLIT_TOKENS = 1_500
/** A full-read page's most prose tokens. */
export const PAGE_TOKENS = 2_500

/** Output caps (design §2.3): a first or full-read page, a window's ceiling, and the card's share. */
export const FULL_OUTPUT_CAP = 720
export const WINDOW_OUTPUT_MAX = 600
export const WINDOW_OUTPUT_BASE = 120
export const WINDOW_OUTPUT_PER_TOKEN = 0.3
export const CARD_OUTPUT = 120
/** Share of a scene's finished sentences unread since the card was made that makes it due (P2a-D17). */
export const CARD_DUE_SHARE = 0.25

/** One paragraph, or a stretch of a long one, in a piece: offsets into the paragraph's text. */
export interface PieceParagraph {
  p: number
  start: number
  end: number
}

/** One request's worth of prose. */
export interface ReadPiece {
  paragraphs: PieceParagraph[]
  tokens: number
}

type Tokens = (text: string) => number

const whole = (paragraphs: readonly string[], p: number): PieceParagraph => ({
  p,
  start: 0,
  end: paragraphs[p]?.length ?? 0
})

const pieceTokens = (
  paragraphs: readonly string[],
  parts: readonly PieceParagraph[],
  tokens: Tokens
): number =>
  parts.reduce(
    (sum, part) => sum + tokens((paragraphs[part.p] ?? '').slice(part.start, part.end)),
    0
  )

/**
 * A paragraph too long for one piece, cut at sentence boundaries into stretches of at most
 * `limit` tokens (a single longer sentence stays whole: nothing is ever truncated).
 */
function splitParagraph(text: string, p: number, limit: number, tokens: Tokens): PieceParagraph[] {
  const parts: PieceParagraph[] = []
  let start = 0
  for (const span of splitSentences(text)) {
    // Close the stretch before this sentence when taking it in would pass the limit.
    if (span.start > start && tokens(text.slice(start, span.end)) > limit) {
      parts.push({ p, start, end: span.start })
      start = span.start
    }
  }
  parts.push({ p, start, end: text.length })
  return parts
}

/**
 * Packs whole paragraphs `from`..`to` into pieces of at most `limit` tokens, at paragraph
 * boundaries; a paragraph over `pageLimit` is cut at sentences into pieces of its own.
 */
function pack(
  paragraphs: readonly string[],
  from: number,
  to: number,
  limit: number,
  pageLimit: number,
  tokens: Tokens
): ReadPiece[] {
  const pieces: ReadPiece[] = []
  let current: PieceParagraph[] = []
  let size = 0
  const flush = (): void => {
    if (current.length > 0) pieces.push({ paragraphs: current, tokens: size })
    current = []
    size = 0
  }
  for (let p = from; p <= to; p += 1) {
    const text = paragraphs[p] ?? ''
    const cost = tokens(text)
    if (cost > pageLimit) {
      flush()
      for (const part of splitParagraph(text, p, pageLimit, tokens)) {
        pieces.push({ paragraphs: [part], tokens: pieceTokens(paragraphs, [part], tokens) })
      }
      continue
    }
    if (current.length > 0 && size + cost > limit) flush()
    current.push(whole(paragraphs, p))
    size += cost
  }
  flush()
  return pieces
}

/**
 * The window pieces of a partial read: each unread paragraph ±2; when none of the paragraphs
 * from that start to the changed one names a record, the start moves back to the last one that
 * does; overlapping or touching ranges merge; a range over 1,500 prose tokens is split at
 * paragraph boundaries (a single paragraph over a page is cut at sentences).
 */
export function planWindows(
  paragraphs: readonly string[],
  unreadParas: readonly number[],
  namingParas: ReadonlySet<number>,
  tokens: Tokens = estimateTokens
): ReadPiece[] {
  const last = paragraphs.length - 1
  if (last < 0) return []
  const ranges: [number, number][] = []
  for (const p of [...new Set(unreadParas)].sort((a, b) => a - b)) {
    if (p < 0 || p > last) continue
    let start = Math.max(0, p - WINDOW_CONTEXT)
    const end = Math.min(last, p + WINDOW_CONTEXT)
    let named = false
    for (let q = start; q <= p && !named; q += 1) named = namingParas.has(q)
    if (!named) {
      for (let q = start - 1; q >= 0; q -= 1) {
        if (namingParas.has(q)) {
          start = q
          break
        }
      }
    }
    ranges.push([start, end])
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const range of ranges) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && range[0] <= previous[1] + 1) {
      previous[1] = Math.max(previous[1], range[1])
    } else merged.push([range[0], range[1]])
  }
  return merged.flatMap(([from, to]) =>
    pack(paragraphs, from, to, WINDOW_SPLIT_TOKENS, PAGE_TOKENS, tokens)
  )
}

/** The pages of a full read: the whole scene in pieces of at most 2,500 prose tokens. */
export function planPages(
  paragraphs: readonly string[],
  tokens: Tokens = estimateTokens
): ReadPiece[] {
  if (paragraphs.length === 0) return []
  return pack(paragraphs, 0, paragraphs.length - 1, PAGE_TOKENS, PAGE_TOKENS, tokens)
}

/** The paragraphs a set of pieces sends (for the read set and `reading.paras`). */
export function piecesParas(pieces: readonly ReadPiece[]): Set<number> {
  return new Set(pieces.flatMap((piece) => piece.paragraphs.map((part) => part.p)))
}

export interface CardDueInput {
  /**
   * The scene's card (its quotes' sentence hashes, and the gate hashes of the finished sentences
   * it was made from), or null when it has none.
   */
  card: { anchor: readonly string[]; seen: readonly string[] } | null
  /** A first or full read. */
  full: boolean
  /** The scene's current sentence hashes (`sceneSentences`). */
  present: ReadonlySet<string>
  /** The gate hashes of the scene's finished sentences now (`gateSentences`). */
  finished: readonly string[]
}

/**
 * Whether the reading asks for a new card (P2a-D17): on a first or full read, when the scene has
 * none, when a card quote's sentence changed, or when a quarter of the finished sentences are new
 * since the card was made (window reads in between do not reset that count).
 */
export function cardDue(input: CardDueInput): boolean {
  if (input.full || input.card === null) return true
  if (input.card.anchor.some((hash) => !input.present.has(hash))) return true
  if (input.finished.length === 0) return false
  const seen = new Set(input.card.seen)
  const changed = input.finished.filter((hash) => !seen.has(hash)).length
  return changed >= input.finished.length * CARD_DUE_SHARE
}

/**
 * A request's `max_tokens` (design §2.3): 720 for a first or full-read page (600 for claims, 120
 * for the card); a window min(600, 120 + ⌈0.3 × prose tokens⌉), plus 120 when a card is due.
 */
export function outputCap(input: {
  purpose: 'full' | 'window'
  proseTokens: number
  cardDue: boolean
}): number {
  if (input.purpose === 'full') return FULL_OUTPUT_CAP
  const claims = Math.min(
    WINDOW_OUTPUT_MAX,
    WINDOW_OUTPUT_BASE + Math.ceil(WINDOW_OUTPUT_PER_TOKEN * input.proseTokens)
  )
  return claims + (input.cardDue ? CARD_OUTPUT : 0)
}
