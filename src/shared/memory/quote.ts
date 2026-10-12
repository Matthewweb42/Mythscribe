import { normalizeForMatch, straightenQuotes } from '../critique'
import { splitSentences } from './sentences'

/**
 * Where a claim's quote sits (F-16.3; design §2.3, the verification ladder's step 1, Presence):
 * the normalised quote must be 3–25 words, must sit exactly once in the whole window that was
 * sent, and that once must be in the paragraph the reader named. Matching is case-sensitive, on
 * `normalizeForMatch` text (straight quotes, whitespace runs as one space), and on word
 * boundaries, so "ran home" never matches inside "Moran homeward".
 */
export const QUOTE_MIN_WORDS = 3
export const QUOTE_MAX_WORDS = 25

export interface QuoteLocation {
  ok: true
  /** The paragraph's index in the window. */
  p: number
  /** Offsets of the quote in that paragraph's own text (whitespace may differ from the quote's). */
  start: number
  end: number
  /** Indexes, in `splitSentences(paragraph)`, of the sentences the quote touches. */
  sentences: number[]
}

export type QuoteMissReason = 'tooShort' | 'tooLong' | 'notFound' | 'otherParagraph' | 'repeated'

export interface QuoteMiss {
  ok: false
  reason: QuoteMissReason
}

/** The words of a normalised quote, as the length rule counts them. */
export function quoteWordCount(quote: string): number {
  const normalized = normalizeForMatch(quote)
  return normalized === '' ? 0 : normalized.split(' ').length
}

/**
 * `normalizeForMatch` of `text` with, for every character of the result, the offset in `text`
 * it came from, so a match in the normalised form maps back to the caller's string.
 */
export function normalizeWithOffsets(text: string): { text: string; offsets: number[] } {
  const straight = straightenQuotes(text)
  let out = ''
  const offsets: number[] = []
  let pendingSpace = -1
  for (let i = 0; i < straight.length; i += 1) {
    const ch = straight[i] ?? ''
    if (/\s/.test(ch)) {
      if (out !== '' && pendingSpace === -1) pendingSpace = i
      continue
    }
    if (pendingSpace !== -1) {
      out += ' '
      offsets.push(pendingSpace)
      pendingSpace = -1
    }
    out += ch
    offsets.push(i)
  }
  return { text: out, offsets }
}

const WORD_CHAR = /[\p{L}\p{N}]/u

/** Every start of `needle` in `haystack` that sits on word boundaries (overlaps included). */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = []
  const edgeStart = WORD_CHAR.test(needle[0] ?? '')
  const edgeEnd = WORD_CHAR.test(needle[needle.length - 1] ?? '')
  let from = haystack.indexOf(needle)
  while (from !== -1) {
    const before = haystack[from - 1]
    const after = haystack[from + needle.length]
    const startOk = !edgeStart || before === undefined || !WORD_CHAR.test(before)
    const endOk = !edgeEnd || after === undefined || !WORD_CHAR.test(after)
    if (startOk && endOk) found.push(from)
    from = haystack.indexOf(needle, from + 1)
  }
  return found
}

/**
 * Where `quote` sits in one text, by offsets into that text (whitespace and quote style may
 * differ, word boundaries hold), or null unless it sits there exactly once. Literal proof reads a
 * sentence with it; Rename in book rewrites a stored quote with it.
 */
export function locateInText(text: string, quote: string): { start: number; end: number } | null {
  const needle = normalizeForMatch(quote)
  if (needle === '') return null
  const normalized = normalizeWithOffsets(text)
  const [only, ...rest] = occurrences(normalized.text, needle)
  if (only === undefined || rest.length > 0) return null
  const start = normalized.offsets[only] ?? 0
  const end = (normalized.offsets[only + needle.length - 1] ?? start) + 1
  return { start, end }
}

/**
 * Locates `quote` in `paragraphs` (the window sent to the reader) and checks it is in paragraph
 * `p`. Misses, in the order they are checked: `tooShort` and `tooLong` (outside 3–25 words),
 * `notFound`, `repeated` (more than once anywhere in the window, even if once in `p`), and
 * `otherParagraph` (exactly once, but not in `p`).
 */
export function locateQuote(
  paragraphs: readonly string[],
  p: number,
  quote: string
): QuoteLocation | QuoteMiss {
  const needle = normalizeForMatch(quote)
  const words = quoteWordCount(needle)
  if (words < QUOTE_MIN_WORDS) return { ok: false, reason: 'tooShort' }
  if (words > QUOTE_MAX_WORDS) return { ok: false, reason: 'tooLong' }

  const hits: { p: number; at: number; offsets: number[] }[] = []
  paragraphs.forEach((paragraph, index) => {
    const normalized = normalizeWithOffsets(paragraph)
    for (const at of occurrences(normalized.text, needle)) {
      hits.push({ p: index, at, offsets: normalized.offsets })
    }
  })
  const [hit, ...rest] = hits
  if (hit === undefined) return { ok: false, reason: 'notFound' }
  if (rest.length > 0) return { ok: false, reason: 'repeated' }
  if (hit.p !== p) return { ok: false, reason: 'otherParagraph' }

  const start = hit.offsets[hit.at] ?? 0
  const end = (hit.offsets[hit.at + needle.length - 1] ?? start) + 1
  const sentences = splitSentences(paragraphs[p] ?? '')
    .map((span, index) => ({ span, index }))
    .filter(({ span }) => span.start < end && span.end > start)
    .map(({ index }) => index)
  return { ok: true, p, start, end, sentences }
}
