import { straightenQuotes } from '../critique'
import { opensSentence } from '../proposedTags'
import { SENTENCE_ABBREVIATIONS } from './sentences'

/**
 * Names in story memory v2 (F-16.4, design §2.2 identity rules): the one normal form a name is
 * compared by, the titles the twin gate folds, and the capitalised spans of a paragraph that the
 * name scan (`nameScan.ts`) matches against the roster. Pure and shared: main scans with it, and
 * the renderer will preview the gate with the same rules.
 */

/**
 * The form names and aliases are compared by (`alias.norm`): NFC, straight quotes, full stops
 * removed ("Mr. Harrow" and "Mr Harrow" are one name), whitespace collapsed, a possessive ending
 * stripped, lower case. Diacritics and titles are kept: "Rene" and "René", "Harrow" and "Mr.
 * Harrow" are different names here, and only the twin gate folds them (`gateWords`).
 */
export function normName(text: string): string {
  return straightenQuotes(text.normalize('NFC'))
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/'s$/i, '')
    .replace(/'$/, '')
    .trim()
    .toLowerCase()
}

/**
 * `normName` without the lower case: what an `exact` name is compared by, so "Will" and "will"
 * differ while "Mr. Harrow's" and "Mr Harrow" do not.
 */
export function caseForm(text: string): string {
  return straightenQuotes(text.normalize('NFC'))
    .replace(/\./g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/'s$/i, '')
    .replace(/'$/, '')
    .trim()
}

/**
 * Titles (identity rule 2): folded only inside the twin gate, never when matching mentions, so
 * "Mrs Harrow" is a twin of "Mrs. Harrow" for the gate while the scan still tells "Mr. Harrow"
 * from "Mrs. Harrow". Each entry is the lower-case word as written; `TITLE_CANON` maps the short
 * forms onto one spelling.
 */
export const TITLES: readonly string[] = [
  'mr',
  'mrs',
  'miss',
  'ms',
  'mx',
  'mister',
  'missus',
  'master',
  'mistress',
  'dr',
  'doctor',
  'lord',
  'lady',
  'sir',
  'dame',
  'madam',
  'madame',
  'captain',
  'capt',
  'king',
  'queen',
  'prince',
  'princess',
  'duke',
  'duchess',
  'earl',
  'count',
  'countess',
  'baron',
  'baroness',
  'father',
  'mother',
  'brother',
  'sister',
  'reverend',
  'rev',
  'professor',
  'prof',
  'general',
  'gen',
  'colonel',
  'col',
  'major',
  'lieutenant',
  'lt',
  'sergeant',
  'sgt',
  'commander',
  'cmdr',
  'admiral',
  'uncle',
  'aunt',
  'auntie'
]

const TITLE_SET: ReadonlySet<string> = new Set(TITLES)

/** The short and long forms of one title, read as one ("Capt" is "captain"). */
const TITLE_CANON: Readonly<Record<string, string>> = {
  mister: 'mr',
  missus: 'mrs',
  doctor: 'dr',
  capt: 'captain',
  rev: 'reverend',
  prof: 'professor',
  gen: 'general',
  col: 'colonel',
  lt: 'lieutenant',
  sgt: 'sergeant',
  cmdr: 'commander',
  auntie: 'aunt',
  madame: 'madam'
}

/** Whether a lower-case word is a title. */
export function isTitle(word: string): boolean {
  return TITLE_SET.has(word)
}

/** A run of letters, with the apostrophes and hyphens inside it ("O'Rourke", "Jean-Luc"). */
const WORD = /\p{L}[\p{L}\p{M}]*(?:['’-]\p{L}[\p{L}\p{M}]*)*/gu

/** A possessive ending: "Varrow's", "Varrow’s". */
const POSSESSIVE = /['’]s$/iu

/**
 * The words the twin gate compares a name by: letters only (full stops and other punctuation
 * dropped), possessive stripped, diacritics folded, lower case, and every title in its one
 * canonical spelling. "Mrs. Harrow's" → ["mrs", "harrow"]; "Capt René" → ["captain", "rene"].
 */
export function gateWords(text: string): string[] {
  const words: string[] = []
  for (const match of straightenQuotes(text.normalize('NFC')).matchAll(WORD)) {
    const word = match[0]
      .replace(POSSESSIVE, '')
      .normalize('NFD')
      .replace(/\p{M}/gu, '')
      .toLowerCase()
    if (word.length > 0) words.push(TITLE_CANON[word] ?? word)
  }
  return words
}

/**
 * The gate's words with the titles taken out, and a leading "the" with them ("the Captain" →
 * []; "Sir Walter Pell" → ["walter", "pell"]). For the twin gate only (identity rule 2): a name
 * that is nothing but a title folds to no words and matches nothing on this side.
 */
export function foldTitles(words: readonly string[]): string[] {
  const kept = words.filter((word) => !isTitle(word))
  return kept[0] === 'the' ? kept.slice(1) : kept
}

/**
 * The small words a name may carry inside it ("Isle of Skye", "Anne de Vere", "Jan van Eyck").
 * A span joined by one of them is tried whole first (`nameScan.ts`); only a span joined by a
 * descriptive word (`NAME_PART_JOINERS`) is tried in its parts after.
 */
export const NAME_LINK_WORDS: ReadonlySet<string> = new Set([
  'of',
  'the',
  'de',
  'del',
  'della',
  'di',
  'da',
  'du',
  'des',
  'la',
  'le',
  'van',
  'von',
  'der',
  'den',
  'y'
])

/**
 * The link words that join two names rather than make one ("Mr. Varrow of Elsdale", "Wat the
 * Elder"), so a span they join that is no name as a whole is tried in its parts. A surname
 * particle (de, van, von…) is part of the name: "Anne de Vere" is an unknown name, never the
 * "Vere" of another record (identity rule 1, as "Jem Falsire" is not Falsire).
 */
export const NAME_PART_JOINERS: ReadonlySet<string> = new Set(['of', 'the'])

/**
 * Words that open sentences in prose without being anybody's name ("Then Mr. Pruett came",
 * "Dearest Jo", "Old Hobb"). A span that opens a sentence with one of them is tried without it
 * (`nameScan.ts`); a title is never dropped (identity rule 2), and a word the scene also writes
 * in lower case is dropped only to leave the rest uncertain ("Rose Harrow" may be anyone's
 * Rose). Any other opener is kept, so "Jem Falsire" at a sentence start stays an unknown name
 * (identity rule 1).
 */
export const SENTENCE_OPENERS: ReadonlySet<string> = new Set([
  'a',
  'after',
  'again',
  'ah',
  'all',
  'also',
  'although',
  'an',
  'and',
  'as',
  'at',
  'before',
  'behind',
  'beside',
  'both',
  'but',
  'by',
  'dear',
  'dearest',
  'did',
  'do',
  'does',
  'each',
  'even',
  'every',
  'for',
  'from',
  'good',
  'had',
  'has',
  'have',
  'here',
  'her',
  'his',
  'how',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'just',
  'later',
  'little',
  'meanwhile',
  'my',
  'near',
  'never',
  'no',
  'not',
  'now',
  'o',
  'of',
  'oh',
  'old',
  'on',
  'once',
  'only',
  'our',
  'perhaps',
  'poor',
  'since',
  'so',
  'still',
  'such',
  'suddenly',
  'that',
  'the',
  'their',
  'then',
  'there',
  'these',
  'this',
  'those',
  'though',
  'through',
  'to',
  'today',
  'tomorrow',
  'tonight',
  'until',
  'was',
  'well',
  'were',
  'what',
  'when',
  'where',
  'which',
  'while',
  'who',
  'why',
  'with',
  'without',
  'yes',
  'yesterday',
  'yet',
  'young',
  'your'
])

/** One word of a capitalised span, in paragraph offsets (a possessive ending excluded). */
export interface SpanWord {
  start: number
  end: number
  text: string
  /** A lower-case link word inside the span (`NAME_LINK_WORDS`). */
  link: boolean
}

/**
 * A capitalised span of a paragraph: the longest run of capitalised words, joined by single
 * spaces (after a title's full stop too: "Mr. Harrow") or by link words between two capitalised
 * words. `start`/`end` are offsets into the paragraph, a trailing possessive excluded.
 */
export interface NameSpan {
  start: number
  end: number
  text: string
  /** The span's first word opens a sentence (`opensSentence`), where any word is capitalised. */
  sentenceStart: boolean
  words: SpanWord[]
}

/** Whether a word opens with an upper-case (or title-case) letter. */
export function isCapitalisedWord(word: string): boolean {
  return /^[\p{Lu}\p{Lt}]/u.test(word)
}

const ABBREVIATIONS: ReadonlySet<string> = new Set(SENTENCE_ABBREVIATIONS)

/**
 * Whether the text between two words keeps them in one span: a single run of spaces (no line
 * break), or, after an abbreviation such as "Mr", its full stop and one run of spaces.
 */
function joins(gap: string, previous: string): boolean {
  if (/^[^\S\n]+$/u.test(gap)) return true
  return ABBREVIATIONS.has(previous) && /^\.[^\S\n]+$/u.test(gap)
}

/**
 * The capitalised spans of one paragraph, in order (identity rule 1). The possessive is stripped
 * from the span's last word ("Mr. Varrow's" → "Mr. Varrow"); link words join two capitalised
 * words but never start or end a span; a span's `sentenceStart` says its first word opens a
 * sentence. Single letters count ("O" in a name), so the caller decides what is worth matching.
 */
export function capitalisedSpans(paragraph: string): NameSpan[] {
  const words: SpanWord[] = []
  for (const match of paragraph.matchAll(WORD)) {
    const raw = match[0]
    const text = raw.replace(POSSESSIVE, '')
    const start = match.index
    words.push({ start, end: start + text.length, text, link: false })
  }
  const spans: NameSpan[] = []
  let i = 0
  while (i < words.length) {
    const first = words[i]
    if (first === undefined || !isCapitalisedWord(first.text)) {
      i += 1
      continue
    }
    const taken: SpanWord[] = [first]
    let j = i + 1
    for (;;) {
      const last = taken[taken.length - 1]
      const next = words[j]
      if (last === undefined || next === undefined) break
      // A possessive ends the span: "Varrow's sister" is not one name.
      if (last.end !== wordEnd(paragraph, last)) break
      if (!joins(paragraph.slice(last.end, next.start), last.text)) break
      if (isCapitalisedWord(next.text)) {
        taken.push(next)
        j += 1
        continue
      }
      // A link word joins only when a capitalised word follows it in the same way.
      const after = words[j + 1]
      if (
        NAME_LINK_WORDS.has(next.text) &&
        after !== undefined &&
        isCapitalisedWord(after.text) &&
        next.end === wordEnd(paragraph, next) &&
        joins(paragraph.slice(next.end, after.start), next.text)
      ) {
        taken.push({ ...next, link: true }, after)
        j += 2
        continue
      }
      break
    }
    const head = taken[0]
    const tail = taken[taken.length - 1]
    if (head !== undefined && tail !== undefined) {
      spans.push({
        start: head.start,
        end: tail.end,
        text: paragraph.slice(head.start, tail.end),
        sentenceStart: opensSentence(paragraph, head.start),
        words: taken
      })
    }
    i = j
  }
  return spans
}

/** Where the word as written ends (before its possessive was stripped). */
function wordEnd(paragraph: string, word: SpanWord): number {
  const rest = paragraph.slice(word.end)
  const possessive = /^['’]s(?![\p{L}\p{M}])/iu.exec(rest)
  return possessive === null ? word.end : word.end + possessive[0].length
}
