import { straightenQuotes } from '../critique'

/**
 * Sentence splitting for story memory (F-16.3, design §2.3): the unit a claim's proof, its
 * anchor hashes and the reading gate work in. Pure and shared, so main (the reader) and the
 * renderer (underlines from anchors, P4) split a paragraph the same way.
 *
 * The text is read through `straightenQuotes`, which keeps every offset, so `start` and `end`
 * index the caller's own string; `text` is the straightened slice.
 */
export interface SentenceSpan {
  /** Offset of the sentence's first character in the input. */
  start: number
  /** Offset just past its last character (closing quotes included). */
  end: number
  /** The sentence, with straight quotes. */
  text: string
}

/** Titles that end in a full stop without ending a sentence ("Mr. Harrow"). */
export const SENTENCE_ABBREVIATIONS: readonly string[] = [
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
  'St',
  'Capt',
  'Col',
  'Lt',
  'Rev',
  'Sgt'
]

const TERMINAL = new Set(['.', '!', '?', '…'])
const CLOSERS = new Set(['"', "'", ')', ']'])
const DASHES = new Set(['—', '–'])
const UPPER = /\p{Lu}/u
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u
const SPACE = /[^\S\n]/

/** The word that ends just before `index` (letters only), for the abbreviation and initial rules. */
function wordBefore(text: string, index: number): string {
  let start = index
  while (start > 0 && /\p{L}/u.test(text[start - 1] ?? '')) start -= 1
  return text.slice(start, index)
}

/** A run of `.` that is an abbreviation's or an initial's full stop, not a sentence end. */
function isNonFinalStop(text: string, dot: number): boolean {
  const word = wordBefore(text, dot)
  if (word === '') return false
  if (SENTENCE_ABBREVIATIONS.includes(word)) return true
  // An initial: one capital letter standing alone ("J. R. Hale", "U.S.").
  const before = text[dot - word.length - 1]
  return (
    word.length === 1 &&
    UPPER.test(word) &&
    (before === undefined || before === ' ' || before === '.' || before === '\n')
  )
}

/**
 * Whether a new sentence starts at `index` (after the gap): a capital letter or a digit, or an
 * opening quote or bracket before one. A lowercase word continues the sentence, which keeps a
 * dialogue tag with its speech (`"Go!" she said.`). After an ellipsis (`strict`) only a capital
 * letter starts one, so `I don't know... maybe.` stays whole.
 */
function startsSentence(text: string, index: number, strict: boolean): boolean {
  let i = index
  while (i < text.length && (text[i] === '"' || text[i] === "'" || text[i] === '(')) i += 1
  const next = text[i]
  if (next === undefined) return false
  if (UPPER.test(next)) return true
  if (strict) return false
  return /\p{N}/u.test(next) || (i > index && !LETTER_OR_DIGIT.test(next))
}

/**
 * The sentences of `text`, in order. A sentence ends at `.`, `!`, `?`, `…` or `...` (runs such
 * as `?!` count once), together with any closing quotes or brackets after it, when the next
 * word starts a sentence. Kept together: abbreviations (`SENTENCE_ABBREVIATIONS`), initials,
 * dialogue tags (`"Go," she said.` and `"Go!" she said.` are one sentence each), an ellipsis
 * before a lowercase word, and em dashes inside a sentence. An em dash right before a closing
 * quote (speech broken off: `"But I—" She stopped.`) ends one. A line break always ends one, and
 * text after the last terminal is a sentence of its own. Whitespace between sentences belongs
 * to none.
 */
export function splitSentences(text: string): SentenceSpan[] {
  const straight = straightenQuotes(text)
  const spans: SentenceSpan[] = []
  let start = -1

  const close = (end: number): void => {
    if (start === -1) return
    let last = end
    while (last > start && /\s/.test(straight[last - 1] ?? '')) last -= 1
    if (last > start) spans.push({ start, end: last, text: straight.slice(start, last) })
    start = -1
  }

  let i = 0
  while (i < straight.length) {
    const ch = straight[i] ?? ''
    if (ch === '\n') {
      close(i)
      i += 1
      continue
    }
    if (start === -1) {
      if (!/\s/.test(ch)) start = i
      else {
        i += 1
        continue
      }
    }

    const brokenSpeech = DASHES.has(ch) && (straight[i + 1] === '"' || straight[i + 1] === "'")
    if (!TERMINAL.has(ch) && !brokenSpeech) {
      i += 1
      continue
    }

    // The whole run of terminal punctuation ("?!", "...", "—"), then its closing quotes.
    let end = i + 1
    while (end < straight.length && TERMINAL.has(straight[end] ?? '')) end += 1
    const ellipsis = ch === '…' || straight.slice(i, end).includes('..')
    if (ch === '.' && end === i + 1 && isNonFinalStop(straight, i)) {
      i = end
      continue
    }
    while (end < straight.length && CLOSERS.has(straight[end] ?? '')) end += 1

    // The gap to the next word: spaces only (a line break is handled above).
    let next = end
    while (next < straight.length && SPACE.test(straight[next] ?? '')) next += 1
    const atEnd = next >= straight.length || straight[next] === '\n'
    if (atEnd) {
      close(end)
      i = next
      continue
    }
    const gap = next > end
    if (gap && startsSentence(straight, next, ellipsis)) {
      close(end)
      i = next
      continue
    }
    i = end
  }
  close(straight.length)
  return spans
}
