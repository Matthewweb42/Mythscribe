import { normalizeForMatch } from '@shared/critique'
import { SCRIBE_QUOTE_MAX, SCRIBE_QUOTE_MIN } from '@shared/scribe2'

/**
 * Ms Scribe's quotes, checked locally (`scribe.v2`, 2026-10-15): a quote she gives for a source
 * is kept only when the scene's or page's text holds it, and then as the text has it once
 * normalized the way `normalizeForMatch` does (straight quotes, one space), which is what the
 * renderer's `locateText` matches against the document. Case may differ from the text (her copy
 * is then corrected to the text's); quote marks and ellipses around the quote are dropped; a quote
 * she elided inside ("…") is kept as its longest piece the text holds.
 */

const EDGES = /^(?:[\s"'“”‘’«»…]|\.\.\.)+|(?:[\s"'“”‘’«»…]|\.\.\.)+$/g
const ELLIPSIS = /\s*(?:…|\.\.\.)\s*/

/** Strips the quote marks and ellipses she may wrap a quote in. */
function trimQuote(quote: string): string {
  return quote.replace(EDGES, '')
}

/** `needle` (normalized) in `haystack` (normalized), as the haystack has it, or null. */
function findIn(haystack: string, needle: string): string | null {
  if (needle.length < SCRIBE_QUOTE_MIN || needle.length > SCRIBE_QUOTE_MAX) return null
  if (haystack.includes(needle)) return needle
  const folded = haystack.toLowerCase()
  // A case-folded copy of another length cannot map its offsets back to the text.
  if (folded.length !== haystack.length) return null
  const at = folded.indexOf(needle.toLowerCase())
  return at === -1 ? null : haystack.slice(at, at + needle.length)
}

/** The quote as `text` has it (normalized), or null when the text does not hold it. */
export function checkQuote(text: string, quote: string): string | null {
  const haystack = normalizeForMatch(text)
  const needle = normalizeForMatch(trimQuote(quote))
  if (needle === '' || haystack === '') return null
  const whole = findIn(haystack, needle)
  if (whole !== null) return whole
  const pieces = needle
    .split(ELLIPSIS)
    .map((piece) => normalizeForMatch(trimQuote(piece)))
    .filter((piece) => piece !== '')
  if (pieces.length < 2) return null
  let best: string | null = null
  for (const piece of pieces) {
    const found = findIn(haystack, piece)
    if (found !== null && (best === null || found.length > best.length)) best = found
  }
  return best
}

/** The quotes `text` holds, as it has them, each once, at most `max`. */
export function checkQuotes(text: string, quotes: readonly string[], max: number): string[] {
  const kept: string[] = []
  for (const quote of quotes) {
    if (kept.length >= max) break
    const found = checkQuote(text, quote)
    if (found !== null && !kept.includes(found)) kept.push(found)
  }
  return kept
}
