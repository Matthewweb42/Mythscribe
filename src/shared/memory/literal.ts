import { straightenQuotes } from '../critique'
import type { Paragraph } from '../mentions'
import type { ClaimMode, ClaimVoice } from './claims'
import { findMarkers, type MarkerKind } from './markers'
import type { NameMention } from './nameScan'
import { locateInText } from './quote'
import type { RecordKind } from './records'
import type { SentenceSpan } from './sentences'
import { OBJECT_SLOTS, type Slot } from './slots'

/**
 * Literal proof in code (F-16.17; design §2.3, the verification ladder's step 3): a claim the
 * prose states in so many words is proved here, for free, and never sent to the verifier. The
 * quote must match one of its slot's patterns ("<Name>'s <value> <cue>", "<Name>'s <cue> was/were
 * <value>", "<Name> had <value> <cue>", "<Name> was born in <value>", "<Name> was <age>", "<Name>
 * was dead", "<Name> wore <value>", "<Name> carried <value>", "<Name> was at <value>" …), and:
 * - the claim is narration in `now` mode (code cannot prove a voice or a mode);
 * - its sentence names exactly one character, the subject, and no name in it is ambiguous;
 * - a claim that names a second record (kinship with an object) is not proved here: the second
 *   person is never named in the sentence, so code cannot check it;
 * - the quote sits outside quotation marks, read over its whole paragraph (a speech opened in an
 *   earlier sentence, or carried over from the paragraph before, still holds it);
 * - no marker (`markers.ts`: negation, modal, conditional, comparative, simile, pluperfect,
 *   reported, a question mark) sits anywhere in its sentence (design §2.3 step 3);
 * - the words between a possessive and its cue are modifiers only ("Mara's cold grey eyes", never
 *   "Mara's brother had blue eyes" or "Mara's mother's grey eyes");
 * - an age or a death ends its clause ("Mara was ten minutes late" and "dead tired" are no age and
 *   no death);
 * - the claim's value is words of the quote, in order: the displayed value is cut to them.
 *
 * Beyond the plan's slots, `kinship` ("<Name> was the son of …") has a pattern, because the test
 * book's labels expect it proved in code (decided by Claude, unconfirmed). Traits have no cue
 * word, so code cannot tell the slot is right: they go to the verifier. A miss is never a
 * rejection: the claim goes to the verifier.
 */

/** A name the name scan found in the sentence, by offsets into the sentence's own text. */
export interface LiteralName {
  recordId: string
  kind: RecordKind
  start: number
  end: number
  ambiguous: boolean
}

export interface LiteralClaim {
  recordId: string
  slot: Slot
  value: string
  /** The second record of a kinship or relation claim (`OBJECT_SLOTS`), or null. */
  objectId: string | null
  voice: ClaimVoice
  mode: ClaimMode
  quote: string
}

/**
 * The quote's sentence where it sits: the scene's paragraph texts, its paragraph, and its span
 * in that paragraph (`splitSentences`). The paragraphs are read for quotation marks only.
 */
export interface LiteralSentence {
  paragraphs: readonly string[]
  p: number
  span: SentenceSpan
}

export type LiteralMiss =
  | 'voiceMode'
  | 'slot'
  | 'object'
  | 'quote'
  | 'quoted'
  | 'names'
  | 'subject'
  | 'pattern'
  | 'value'
  | 'marker'

export type LiteralResult =
  { ok: true; value: string } | { ok: false; reason: LiteralMiss; marker?: MarkerKind }

/** Where the subject sits in a pattern: its masked span, after an optional "the". */
const N = '(?:the\\s+)?§+'
/** The subject with a possessive. */
const P = `${N}(?:'s|')`
const BE = '(?:was|is|were|are)'
/** Up to four words before a cue ("a cold, clear"); `modifiersOnly` then checks them. */
const WORDS = "[\\p{L}'-]+(?:,?\\s+[\\p{L}'-]+){0,3}"
const END = '(?![\\p{L}\\p{N}])'
const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|' +
  'sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred'
/** An age: digits or number words, joined as "seven-and-twenty", "twenty-one" or "a hundred". */
const AGE = `(?:a\\s+)?(?:\\d{1,3}|${NUMBER_WORDS})(?:[- ](?:and[- ])?(?:${NUMBER_WORDS}))*`
const KIN_WORDS = [
  'son',
  'daughter',
  'brother',
  'sister',
  'father',
  'mother',
  'wife',
  'husband',
  'widow',
  'widower',
  'cousin',
  'aunt',
  'uncle',
  'niece',
  'nephew',
  'grandson',
  'granddaughter',
  'grandfather',
  'grandmother',
  'heir',
  'heiress',
  'twin',
  'child',
  'stepson',
  'stepdaughter',
  'stepmother',
  'stepfather',
  'half-brother',
  'half-sister'
]
const KIN = KIN_WORDS.join('|')

/**
 * Words that may not stand between a possessive (or "had") and its cue: verbs, which make the
 * sentence about someone or something else ("Mara's brother had blue eyes", "Mara had seen blue
 * eyes"), kin, and "of".
 */
const NOT_MODIFIERS = new Set([
  ...KIN_WORDS,
  'of',
  'had',
  'has',
  'have',
  'having',
  'was',
  'were',
  'is',
  'are',
  'be',
  'been',
  'being',
  'wore',
  'wears',
  'bore',
  'bears',
  'did',
  'does',
  'do',
  'got',
  'gets',
  'kept',
  'keeps',
  'showed',
  'shows',
  'saw',
  'sees',
  'seen',
  'met',
  'meets',
  'watched',
  'watches',
  'noticed',
  'notices',
  'loved',
  'loves',
  'admired',
  'admires',
  'envied',
  'envies',
  'liked',
  'likes',
  'hated',
  'hates',
  'inherited',
  'shared',
  'shares',
  'gave',
  'gives',
  'took',
  'takes',
  'made',
  'makes',
  'found',
  'finds',
  'felt',
  'feels',
  'knew',
  'knows',
  'known',
  'turned',
  'turns',
  'closed',
  'closes',
  'opened',
  'opens',
  'narrowed',
  'narrows'
])

/** Whether the words captured before a cue are modifiers only: no verb, kin, "of" or possessive. */
function modifiersOnly(captured: string): boolean {
  return captured
    .split(/[\s,]+/u)
    .filter((word) => word !== '')
    .every((word) => {
      const lower = word.toLowerCase()
      return !NOT_MODIFIERS.has(lower) && !/(?:'s|s'|')$/u.test(lower)
    })
}

/** What may follow an age in its sentence: the clause's end, or a word of time ("that spring"). */
const AGE_TAIL =
  /^(?:\s*(?:$|[,;:.!?)—–]|\s-\s)|\s+(?:that|this|last|next|now|then|when|by|before|since)(?![\p{L}\p{N}]))/u
/** What may follow a death or "alive" in its sentence: the clause's end only ("dead tired" is no death). */
const CLAUSE_END_TAIL = /^\s*(?:$|[,;:.!?)—–]|\s-\s)/u

/** One pattern: the regex over the masked quote, and what it needs around it. */
interface LiteralPattern {
  pattern: RegExp
  /** The words captured before a cue must be modifiers only (`modifiersOnly`). */
  modifiers?: boolean
  /** What the rest of the sentence after the match must start with. */
  tail?: RegExp
}

const rx = (source: string): RegExp => new RegExp(source, 'iud')

const cuePatterns = (cue: string): LiteralPattern[] => [
  { pattern: rx(`${P}\\s+(?<v>${WORDS})\\s+${cue}${END}`), modifiers: true },
  { pattern: rx(`${P}\\s+${cue}\\s+${BE}\\s+(?<v>.+)$`) },
  { pattern: rx(`${N}\\s+(?<verb>had|has)\\s+(?<v>${WORDS})\\s+${cue}${END}`), modifiers: true }
]

export const LITERAL_PATTERNS: Readonly<Partial<Record<Slot, readonly LiteralPattern[]>>> = {
  eyes: cuePatterns('eyes?'),
  hair: cuePatterns('hair'),
  scars: [
    {
      pattern: rx(`${N}\\s+(?<verb>had|has|bore|bears)\\s+(?<v>(?:.*?[^\\p{L}])?scars?${END}.*)$`)
    }
  ],
  born: [{ pattern: rx(`${N}\\s+was\\s+born\\s+(?<v>.+)$`) }],
  age: [
    {
      pattern: rx(
        `${N}\\s+(?:was|is|turned)\\s+(?<v>${AGE})(?:\\s+years?\\s+(?:old|of\\s+age))?(?![\\p{L}\\p{N}-])`
      ),
      tail: AGE_TAIL
    }
  ],
  alive: [{ pattern: rx(`${N}\\s+(?:was|lay)\\s+(?<v>dead|alive)${END}`), tail: CLAUSE_END_TAIL }],
  location: [
    {
      pattern: rx(
        `${N}\\s+(?:was|stood|sat|lay|waited|lived|stayed|remained)\\s+` +
          '(?<v>(?:at|in|on|inside|outside|near|by|beside|behind|under|upon|within)\\s+.+)$'
      )
    }
  ],
  clothing: [
    { pattern: rx(`${N}\\s+(?:wore|wears|was\\s+wearing|was\\s+dressed\\s+in)\\s+(?<v>.+)$`) }
  ],
  objects: [
    {
      pattern: rx(
        `${N}\\s+(?:carried|carries|held|holds|was\\s+carrying|was\\s+holding)\\s+(?<v>.+)$`
      )
    }
  ],
  kinship: [
    {
      pattern: rx(
        `${N}\\s+(?:was|is)\\s+(?<v>(?:(?:the|a|an|his|her|their)\\s+)?(?:${KIN})${END}.*)$`
      )
    }
  ]
}

/**
 * The value a slot's patterns read from a sentence (P4's C6 note side, P4-D8): `masked` is `text`
 * with the subject's names masked as `§` and every other name as `_`, at the same length. The
 * first pattern that matches (its modifiers and tail rules holding) gives the captured words as
 * written, outer punctuation trimmed; null when none matches, or when a marker (a negation, a
 * modal, a comparison…) stands in the sentence, as for a literal proof.
 */
export function patternValue(slot: Slot, text: string, masked: string): string | null {
  const patterns = LITERAL_PATTERNS[slot]
  if (patterns === undefined) return null
  const plain = straightenQuotes(text)
  for (const { pattern, modifiers, tail } of patterns) {
    const match = pattern.exec(masked)
    const captured = match?.groups?.v
    const span = match?.indices?.groups?.v
    if (match === null || captured === undefined || span === undefined) continue
    if (modifiers === true && !modifiersOnly(captured)) continue
    if (tail !== undefined && !tail.test(masked.slice(match.index + match[0].length))) continue
    const value = plain
      .slice(span[0], span[1])
      .replace(/[\s,;:.!?]+$/u, '')
      .trim()
    if (value === '') continue
    const verb = match.indices?.groups?.verb
    const ignore: [number, number][] = verb === undefined ? [] : [[verb[0], verb[1]]]
    return findMarkers(masked, { ignore }).length === 0 ? value : null
  }
  return null
}

const KIN_PATTERN = new RegExp(`(?<![\\p{L}\\p{N}])(?:${KIN})(?![\\p{L}\\p{N}])`, 'giu')

/** The kin words of a text ("son", "sister"), lower case, each with where it stands. */
export function kinWords(text: string): { word: string; start: number; end: number }[] {
  return [...text.matchAll(KIN_PATTERN)].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length
  }))
}

/** Whether a slot has literal patterns at all. */
export function hasLiteralPatterns(slot: Slot): boolean {
  return LITERAL_PATTERNS[slot] !== undefined
}

const WORD_CHAR = /[\p{L}\p{N}]/u
/** What may stand before a straight single quote that opens a quotation. */
const OPENS_SINGLE = /^(?:|[\s([{—–"“-])$/u

interface QuoteState {
  double: boolean
  single: boolean
}

const CLOSED: QuoteState = { double: false, single: false }

/**
 * The quotation state after the first `until` characters of `text`, from `from` (a quotation
 * carried over from the paragraph before). Curly marks say which way they face; a straight
 * double quote toggles; a straight or right single quote between two letters is an apostrophe.
 * A carried quotation's paragraph opens with its marks again: they re-open it, never close it.
 */
function scanQuotes(text: string, from: QuoteState, until = text.length): QuoteState {
  let { double, single } = from
  let i = 0
  while (i < until && /\s/u.test(text[i] ?? '')) i += 1
  if (double && (text[i] === '"' || text[i] === '“')) i += 1
  else if (single && (text[i] === "'" || text[i] === '‘')) i += 1
  for (; i < until; i += 1) {
    const ch = text[i]
    if (ch === '“') double = true
    else if (ch === '”') double = false
    else if (ch === '"') double = !double
    else if (ch === '‘') single = true
    else if (ch === "'" || ch === '’') {
      const before = text[i - 1] ?? ''
      const after = text[i + 1] ?? ''
      const wordAfter = WORD_CHAR.test(after)
      if (WORD_CHAR.test(before) && wordAfter) continue
      if (ch === "'" && wordAfter && OPENS_SINGLE.test(before)) single = true
      else if (single && !wordAfter) single = false
    }
  }
  return { double, single }
}

/**
 * Whether offset `at` of paragraph `p` lies inside a quotation: one opened before it in the
 * paragraph, or one the paragraph before opened and did not close (a speech running on).
 */
export function insideQuotation(paragraphs: readonly string[], p: number, at: number): boolean {
  const carried = p > 0 ? scanQuotes(paragraphs[p - 1] ?? '', CLOSED) : CLOSED
  const state = scanQuotes(paragraphs[p] ?? '', carried, at)
  return state.double || state.single
}

/**
 * Whether the quote sits inside quotation marks: inside a quotation open at its start (read over
 * the paragraph), a double quote inside it, or any single quote that opens a quotation in its
 * sentence (British style; an apostrophe after a letter never does).
 */
function quoted(where: LiteralSentence, text: string, at: { start: number; end: number }): boolean {
  if (insideQuotation(where.paragraphs, where.p, where.span.start + at.start)) return true
  if (text.slice(at.start, at.end).includes('"')) return true
  return /(?:^|[\s([—–-])'(?=\p{L})/u.test(text)
}

/** The words of a value, with offsets: letters and digits, joined by inner hyphens and apostrophes. */
function words(text: string): { word: string; start: number; end: number }[] {
  return [...text.matchAll(/[\p{L}\p{N}]+(?:['-][\p{L}\p{N}]+)*/gu)].map((match) => ({
    word: match[0].toLowerCase(),
    start: match.index,
    end: match.index + match[0].length
  }))
}

/**
 * The claim's value as words of `captured`, in order and side by side, cut from it as written;
 * null when the value has words the capture does not.
 */
export function cutValue(value: string, captured: string): string | null {
  const want = words(straightenQuotes(value)).map((entry) => entry.word)
  const have = words(straightenQuotes(captured))
  if (want.length === 0) return null
  for (let i = 0; i + want.length <= have.length; i += 1) {
    if (want.every((word, j) => have[i + j]?.word === word)) {
      const first = have[i]
      const last = have[i + want.length - 1]
      if (first === undefined || last === undefined) return null
      return captured.slice(first.start, last.end)
    }
  }
  return null
}

const miss = (reason: LiteralMiss, marker?: MarkerKind): LiteralResult =>
  marker === undefined ? { ok: false, reason } : { ok: false, reason, marker }

/**
 * Proves `claim` in code from its sentence (`where`) and the names the scan found there
 * (`names`, offsets into the sentence). Answers the value to display, cut to the quote's words,
 * or why it could not prove it.
 */
export function literalProof(
  claim: LiteralClaim,
  where: LiteralSentence,
  names: readonly LiteralName[]
): LiteralResult {
  if (claim.voice !== 'narration' || claim.mode !== 'now') return miss('voiceMode')
  const patterns = LITERAL_PATTERNS[claim.slot]
  if (patterns === undefined) return miss('slot')
  if (claim.objectId !== null && OBJECT_SLOTS.includes(claim.slot)) return miss('object')
  const text = straightenQuotes(where.span.text)
  const at = locateInText(text, claim.quote)
  if (at === null) return miss('quote')
  if (quoted(where, text, at)) return miss('quoted')

  if (names.some((name) => name.ambiguous)) return miss('names')
  if (names.some((name) => name.recordId !== claim.recordId && name.kind === 'character')) {
    return miss('names')
  }
  const subject = names.filter(
    (name) => name.recordId === claim.recordId && name.start < at.end && name.end > at.start
  )
  if (subject.length === 0) return miss('subject')

  // Names are masked at the same length, so offsets hold: the subject as § (what the patterns
  // look for), every other name as _ (so a name never reads as a marker word: "May", "Will").
  let masked = text
  for (const name of names) {
    const mark = name.recordId === claim.recordId ? '§' : '_'
    masked =
      masked.slice(0, name.start) + mark.repeat(name.end - name.start) + masked.slice(name.end)
  }
  const region = masked.slice(at.start, at.end)

  let proved: { value: string; ignore: [number, number][] } | null = null
  let valueMiss = false
  for (const { pattern, modifiers, tail } of patterns) {
    const match = pattern.exec(region)
    const captured = match?.groups?.v
    const span = match?.indices?.groups?.v
    if (match === null || captured === undefined || span === undefined) continue
    if (modifiers === true && !modifiersOnly(captured)) continue
    if (tail !== undefined && !tail.test(masked.slice(at.start + match.index + match[0].length))) {
      continue
    }
    const original = text.slice(at.start + span[0], at.start + span[1]).replace(/[\s,;:.!?]+$/u, '')
    const value = cutValue(claim.value, original)
    if (value === null) {
      valueMiss = true
      continue
    }
    const verb = match.indices?.groups?.verb
    const ignore: [number, number][] =
      verb === undefined ? [] : [[at.start + verb[0], at.start + verb[1]]]
    proved = { value, ignore }
    break
  }
  if (proved === null) return miss(valueMiss ? 'value' : 'pattern')

  // Markers: anywhere in the sentence (design §2.3 step 3), the pattern's own "had" aside.
  const marker = findMarkers(masked, { ignore: proved.ignore })[0]
  if (marker !== undefined) return miss('marker', marker.kind)
  return { ok: true, value: proved.value }
}

/**
 * The names of one sentence as `literalProof` reads them: the scan's mentions in the sentence's
 * paragraph (`para`, ProseMirror positions), moved to offsets into the sentence. A mention whose
 * span is not wholly in the sentence is left out.
 */
export function sentenceNames(
  paragraph: Paragraph,
  span: SentenceSpan,
  mentions: readonly NameMention[],
  kindOf: (recordId: string) => RecordKind | undefined
): LiteralName[] {
  const names: LiteralName[] = []
  for (const mention of mentions) {
    if (mention.para !== paragraph.index) continue
    const start = mention.from - paragraph.from
    const end = mention.to - paragraph.from
    if (start < span.start || end > span.end) continue
    const kind = kindOf(mention.recordId)
    if (kind === undefined) continue
    names.push({
      recordId: mention.recordId,
      kind,
      start: start - span.start,
      end: end - span.start,
      ambiguous: mention.ambiguous
    })
  }
  return names
}
