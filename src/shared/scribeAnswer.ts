import { estimateTokens } from './ai'
import { findQuote, normalizeForMatch } from './critique'
import { namesInQuestion, SCENE_REF, type AskIndex } from './memory/askParse'
import { splitSentences } from './memory/sentences'
import { SCRIBE_HISTORY_TOKENS, type SearchScope, type TextSpan } from './scribe'

/**
 * Reading a Ms Scribe answer (F-16.25; plan P3 §1.2, used from slice 2): its sentences with their
 * inline `[E7 "exact words"]` citations, the text as the chat streams it (markup stripped), which
 * sentences need a citation (P3-D13), the answer with `[n]` markers once code has kept or dropped
 * each citation, the "Not found" line with its scope (P3-D14), and the history an answer is sent
 * (P3-D12). Pure.
 */

/** One citation as the answer wrote it. */
export interface RawCitation {
  /** `E7`, `W2`, `E0`. */
  evidence: string
  quote: string
}

/** One sentence of the answer (markup stripped) with the citations written in or after it. */
export interface CitedSentence {
  text: string
  /** Where the sentence sits in the stripped answer. */
  start: number
  end: number
  citations: RawCitation[]
}

export interface ParsedAnswer {
  /** The answer with every citation marker taken out. */
  text: string
  sentences: CitedSentence[]
  /** Markers that were not one id and one quoted stretch: dropped, counted. */
  malformed: number
}

/** A well-formed citation marker: `[E7 "words"]`, escaped quotes allowed inside. */
const MARKER = /\[\s*([EW]\d{1,3})\s*[:,]?\s*"((?:[^"\\]|\\.)*)"\s*\]/gu
/** Anything that opens like a citation marker. */
const OPENER = /\[\s*[EW]\d{1,3}\b/gu

/** The quote as written, its escapes read (`\"` is `"`, `\\` is `\`). */
const unescape = (text: string): string => text.replace(/\\(.)/gu, '$1')

interface Cut {
  /** Where the marker (and the space before it) starts and ends in the raw answer. */
  from: number
  to: number
  citation: RawCitation | null
}

/** Every marker of a raw answer, well-formed or not, in order. */
function markersOf(raw: string): Cut[] {
  const cuts: Cut[] = []
  for (const match of raw.matchAll(MARKER)) {
    cuts.push({
      from: match.index,
      to: match.index + match[0].length,
      citation: { evidence: match[1] ?? '', quote: unescape(match[2] ?? '') }
    })
  }
  for (const match of raw.matchAll(OPENER)) {
    if (cuts.some((cut) => cut.from <= match.index && match.index < cut.to)) continue
    // A malformed marker runs to its closing bracket, or to the end of the line.
    const close = raw.indexOf(']', match.index)
    const line = raw.indexOf('\n', match.index)
    const end = close >= 0 && (line < 0 || close < line) ? close + 1 : line >= 0 ? line : raw.length
    cuts.push({ from: match.index, to: end, citation: null })
  }
  return cuts
    .sort((a, b) => a.from - b.from)
    .map((cut) => {
      let from = cut.from
      while (from > 0 && /[ \t]/u.test(raw[from - 1] ?? '')) from -= 1
      return { ...cut, from }
    })
}

/** The raw answer with every cut taken out, and where each cut's citation lands in the result. */
function strip(raw: string, cuts: readonly Cut[]): { text: string; at: number[] } {
  let text = ''
  let copied = 0
  const at: number[] = []
  for (const cut of cuts) {
    if (cut.from < copied) {
      at.push(text.length)
      copied = Math.max(copied, cut.to)
      continue
    }
    text += raw.slice(copied, cut.from)
    at.push(text.length)
    copied = cut.to
  }
  text += raw.slice(copied)
  return { text, at }
}

/**
 * The answer's sentences (`splitSentences`) with their citations: a marker belongs to the sentence
 * it stands in, or to the one it follows ("It was Orrin. [E3 "…"]"). A marker that is not one id
 * and one quoted stretch is dropped and counted.
 */
export function parseCitedAnswer(raw: string): ParsedAnswer {
  const cuts = markersOf(raw)
  const { text, at } = strip(raw, cuts)
  const sentences: CitedSentence[] = splitSentences(text).map((span) => ({
    text: span.text,
    start: span.start,
    end: span.end,
    citations: []
  }))
  let malformed = 0
  cuts.forEach((cut, i) => {
    if (cut.citation === null) {
      malformed += 1
      return
    }
    const pos = at[i] ?? 0
    const owner = [...sentences].reverse().find((sentence) => sentence.start <= pos) ?? sentences[0]
    owner?.citations.push(cut.citation)
  })
  return { text, sentences, malformed }
}

/** A marker still being written at the end of a streamed answer: `[`, `[E7`, `[E7 "half`. */
const UNFINISHED = /\s*\[\s*(?:[EW]\d{0,3}(?:\s*[:,]?\s*"(?:[^"\\]|\\.)*(?:"\s*)?)?)?$/u

/**
 * The answer as the chat streams it: every citation marker taken out, and an unfinished one at the
 * end held back, so a half-written `[E7 "…` never shows.
 */
export function stripCitationMarkup(raw: string): string {
  const held = raw.replace(UNFINISHED, '')
  return strip(held, markersOf(held)).text
}

/** How advice and replies to the author open: they need no citation (P3-D13). */
const ADVICE =
  /^(?:you (?:could|might|may|can)|consider|try|perhaps you|maybe you|if you|i (?:suggest|would|could|can)|would you|do you|shall i|let me)\b/iu

/** A question back to the author or advice ("You could…"): it needs no citation (P3-D13). */
export function isAdviceOrQuestion(sentence: string): boolean {
  const text = sentence.trim()
  return text === '' || /\?["')\]]*$/u.test(text) || ADVICE.test(text)
}

/**
 * Whether a sentence must rest on a citation (P3-D13): it names a record (the roster's names) or a
 * scene reference. A question back to the author and advice ("You could…") need none.
 */
export function needsCitation(sentence: string, index: AskIndex): boolean {
  const text = sentence.trim()
  if (isAdviceOrQuestion(text)) return false
  if (SCENE_REF.test(text)) return true
  const named = namesInQuestion(text, index)
  return named.records.length > 0 || named.ambiguous.length > 0 || named.topics.length > 0
}

/** A citation's quote: 3 to 25 copied words (the prompt's rule, enforced in code). */
export const QUOTE_WORDS_MIN = 3
export const QUOTE_WORDS_MAX = 25

/** How many words a quote holds (letters or digits, inner apostrophes and hyphens kept). */
export const quoteWords = (quote: string): number =>
  quote.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)?.length ?? 0

/**
 * The code quote check of one citation (P3 §2.3 step 4): the quote is 3 to 25 words, and lies
 * whole within one of the item's quotable stretches (`EvidenceItem.quotable`: the book's own
 * words, never a line the app composed). A one-word quote ("Orrin") or one that runs from one
 * paragraph into the next proves nothing.
 */
export function quoteHeld(quotable: readonly string[], quote: string): boolean {
  const words = quoteWords(quote)
  if (words < QUOTE_WORDS_MIN || words > QUOTE_WORDS_MAX) return false
  return quotable.some((text) => findQuote(text, quote))
}

/**
 * Where a kept quote stands, for the quote check (`cite.v1`, P3 §3.2): the sentence or sentences
 * of the item's quotable stretch that hold it, with one sentence either side (`around`), spaces
 * made one. Null when no stretch holds it.
 */
export function quoteContext(
  quotable: readonly string[],
  quote: string,
  around = 1
): string | null {
  const text = quotable.find((stretch) => findQuote(stretch, quote))
  if (text === undefined) return null
  const spans = splitSentences(text)
  if (spans.length === 0) return normalizeForMatch(text)
  // The sentence the quote ends in, then the latest sentence it can start in.
  const last = spans.findIndex((span) => findQuote(text.slice(0, span.end), quote))
  if (last < 0) return normalizeForMatch(text)
  let first = last
  while (first > 0 && !findQuote(text.slice(spans[first]?.start ?? 0, spans[last]?.end), quote)) {
    first -= 1
  }
  const from = spans[Math.max(0, first - around)]?.start ?? 0
  const to = spans[Math.min(spans.length - 1, last + around)]?.end ?? text.length
  return normalizeForMatch(text.slice(from, to))
}

/** How a sentence that found nothing opens ("I found no scene…", "I could not find…"). */
const ABSENCE_OPENING =
  /^(?:I\s+(?:found|could\s+find|can\s+find|see|saw|have\s+found)\s+no(?:thing)?\b|I\s+(?:did\s+not|didn['’]t|could\s+not|couldn['’]t|cannot|can['’]t|was\s+unable\s+to)\s+find\b|(?:No|Nothing\s+in\s+the)\s+(?:scene|passage|sentence|evidence|manuscript|book)\b)/iu

/**
 * A sentence that says the search found nothing ("I found no scene where Tomas learns it
 * (searched …)", P3 rule 5): the scope is code's, so it needs no citation to stand as the main
 * claim; the answer must say what was searched (`statesScope`).
 */
export function isAbsence(sentence: string): boolean {
  return ABSENCE_OPENING.test(sentence.trim())
}

/** Words that say what was searched ("searching every scene up to 14.2", "I looked in"). */
const SCOPE_WORDS = /\b(?:search(?:ed|ing)?|looked\s+(?:in|at|through))\b/iu

/**
 * Whether an answer says what was searched (P3 §3.3 step 2): a first, last, ever or never answer,
 * or one that found nothing, must, or its main claim is unsupported.
 */
export function statesScope(answer: string): boolean {
  return SCOPE_WORDS.test(answer)
}

/** What code decided about one sentence's citations. */
export interface SentenceVerdict {
  /** Per citation of the sentence, in order: kept (its id was sent and its quote is in it). */
  keep: readonly boolean[]
  /** The sentence names a record or a scene (`needsCitation`). */
  needsCitation: boolean
  /** The checker found it unsupported (slice 3): its citations go and it is marked. */
  unsupported: boolean
}

/** The answer with `[n]` markers, the citations behind them, and the marked spans. */
export interface Markerized {
  text: string
  citations: { n: number; evidence: string; quote: string }[]
  /** Sentences that name a record or a scene and kept no citation: "not checked". */
  notChecked: TextSpan[]
  unsupported: TextSpan[]
}

/**
 * The answer as the chat shows it: each sentence followed by the `[n]` markers of the citations
 * kept for it (one number per item and quote, in order of first use), the sentences that needed a
 * citation and kept none as `notChecked`, the unsupported ones as `unsupported`. The text between
 * sentences is kept as it was.
 */
export function markerize(
  answer: Pick<ParsedAnswer, 'text' | 'sentences'>,
  verdicts: readonly SentenceVerdict[]
): Markerized {
  const numbers = new Map<string, number>()
  const citations: Markerized['citations'] = []
  const notChecked: TextSpan[] = []
  const unsupported: TextSpan[] = []
  let text = ''
  let copied = 0
  answer.sentences.forEach((sentence, i) => {
    const verdict = verdicts[i] ?? { keep: [], needsCitation: false, unsupported: false }
    text += answer.text.slice(copied, sentence.start)
    const start = text.length
    text += sentence.text
    const span: TextSpan = [start, text.length]
    copied = sentence.end
    const kept = verdict.unsupported
      ? []
      : sentence.citations.filter((_, j) => verdict.keep[j] === true)
    const markers: number[] = []
    for (const citation of kept) {
      const key = `${citation.evidence}\u0000${citation.quote}`
      let n = numbers.get(key)
      if (n === undefined) {
        n = citations.length + 1
        numbers.set(key, n)
        citations.push({ n, evidence: citation.evidence, quote: citation.quote })
      }
      if (!markers.includes(n)) markers.push(n)
    }
    text += markers.map((n) => `[${n}]`).join('')
    if (verdict.unsupported) unsupported.push(span)
    else if (verdict.needsCitation && markers.length === 0) notChecked.push(span)
  })
  text += answer.text.slice(copied)
  return { text, citations, notChecked, unsupported }
}

const listed = (items: readonly string[]): string => {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`
}

/**
 * The "Not found" answer (P3-D14), its scope composed in code from what was looked at: "Not found
 * in the manuscript (I looked in the open scene 14.2, scenes 7.4 and 9.3, and searched every
 * scene up to 14.2 for distrust, suspicion)". Never from `checkedUpTo` (P2b-D9).
 */
export function notFoundLine(
  scope: SearchScope | null,
  refs: { open: string | null; cited: readonly string[] }
): string {
  const places: string[] = []
  if (refs.open !== null && refs.open !== '') places.push(`the open scene ${refs.open}`)
  const cited = [...new Set(refs.cited)].filter((ref) => ref !== '' && ref !== refs.open)
  if (cited.length > 0) places.push(`${cited.length === 1 ? 'scene' : 'scenes'} ${listed(cited)}`)
  const searched = scope === null ? null : searchedPhrase(scope)
  if (places.length === 0 && searched === null) return 'Not found in the manuscript.'
  const looked = places.length === 0 ? null : `looked in ${places.join(', ')}`
  const said =
    looked === null
      ? `searched ${searched ?? ''}`
      : searched === null
        ? looked
        : `${looked}, and searched ${searched}`
  return `Not found in the manuscript (I ${said})`
}

/** What a search covered, in words: "every scene up to 14.2 for distrust, suspicion". */
export function searchedPhrase(scope: SearchScope): string {
  const words = scope.terms.length > 0 ? ` for ${scope.terms.join(', ')}` : ''
  if (scope.wholeBook) return `the whole book${words}`
  if (scope.allEarlier) return `every scene up to ${scope.to}${words}`
  if (scope.from === scope.to) return `${scope.from}${words}`
  return `${scope.from}–${scope.to}${words}`
}

/**
 * The scope line of an answer (P3-D8), from what code searched, never from `checkedUpTo`:
 * "Searched every scene up to 14.2 for distrust, suspicion". Ms Scribe's prompt carries it, and
 * the turn keeps it under the answer.
 */
export function scopeLine(scope: SearchScope): string {
  return `Searched ${searchedPhrase(scope)}`
}

/** One earlier message of the conversation. */
export interface HistoryTurn {
  role: 'user' | 'assistant'
  content: string
}

/** P3-D12: the newest turns sent whole, up to this many tokens each. */
export const HISTORY_WHOLE_TURNS = 2
export const HISTORY_WHOLE_TOKENS = 400
/** P3-D12: an older turn is cut to its first line, at most this many words. */
export const HISTORY_LINE_WORDS = 25

const firstLine = (text: string): string => {
  const line = (text.trim().split('\n')[0] ?? '').trim()
  const words = line.split(/\s+/u).filter((word) => word !== '')
  return words.length <= HISTORY_LINE_WORDS
    ? line
    : `${words.slice(0, HISTORY_LINE_WORDS).join(' ')}…`
}

/** `text` cut to about `tokens` tokens (four characters each), at a word. */
const headTokens = (text: string, tokens: number): string => {
  if (estimateTokens(text) <= tokens) return text
  const cut = text.slice(0, tokens * 4)
  const at = cut.lastIndexOf(' ')
  return `${(at > cut.length / 2 ? cut.slice(0, at) : cut).trimEnd()}…`
}

/**
 * The earlier turns an answer is sent (P3-D12), oldest first: citation markup stripped; the newest
 * two whole up to 400 tokens each, older ones cut to their first line (25 words); the oldest
 * dropped first until the whole fits `budget` (1,500). The prompt labels them "earlier turn, not
 * a source".
 */
export function scribeHistory(
  turns: readonly HistoryTurn[],
  budget: number = SCRIBE_HISTORY_TOKENS
): HistoryTurn[] {
  const shaped = turns
    .map((turn, i) => {
      const clean = stripCitationMarkup(turn.content)
        .replace(/\[\d+\]/gu, '')
        .trim()
      const newest = i >= turns.length - HISTORY_WHOLE_TURNS
      return {
        role: turn.role,
        content: newest ? headTokens(clean, HISTORY_WHOLE_TOKENS) : firstLine(clean)
      }
    })
    .filter((turn) => turn.content !== '')
  const cost = (list: readonly HistoryTurn[]): number =>
    list.reduce((sum, turn) => sum + estimateTokens(turn.content), 0)
  while (shaped.length > 0 && cost(shaped) > budget) shaped.shift()
  return shaped
}
