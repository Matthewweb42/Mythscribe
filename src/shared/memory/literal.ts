import { straightenQuotes } from '../critique'
import type { Paragraph } from '../mentions'
import { valueKey, type ClaimMode, type ClaimVoice } from './claims'
import { findMarkers, scopeBackMarkers, type MarkerKind } from './markers'
import type { NameMention } from './nameScan'
import { locateInText } from './quote'
import type { RecordKind } from './records'
import type { SentenceSpan } from './sentences'
import type { Slot } from './slots'

/**
 * Literal proof in code (F-16.17; design §2.3, the verification ladder's step 3): a claim the
 * prose states in so many words is proved here, for free, and never sent to the verifier. The
 * quote must match one of its slot's patterns ("<Name>'s <value> <cue>", "<Name>'s <cue> was/were
 * <value>", "<Name> had <value> <cue>", "<Name> was born in <value>", "<Name> was <age>", "<Name>
 * was dead", "<Name> wore <value>", "<Name> carried <value>", "<Name> was at <value>" …), and:
 * - the claim is narration in `now` mode (code cannot prove a voice or a mode);
 * - its sentence names exactly one character, the subject, and no name in it is ambiguous;
 * - the quote sits outside quotation marks;
 * - no marker (`markers.ts`) sits before the quote or in the rest of its clause, and no marker
 *   that reaches back over a sentence (if, dream, rumour, or so …) sits in the clauses after it;
 * - the claim's value is words of the quote, in order: the displayed value is cut to them.
 *
 * Beyond the plan's slots, `traits` ("<Name> was <value>") and `kinship` ("<Name> was the son of
 * …") have patterns, because the test book's labels expect those claims proved in code (decided
 * by Claude, unconfirmed). A miss is never a rejection: the claim goes to the verifier.
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
  voice: ClaimVoice
  mode: ClaimMode
  quote: string
}

export type LiteralMiss =
  'voiceMode' | 'slot' | 'quote' | 'quoted' | 'names' | 'subject' | 'pattern' | 'value' | 'marker'

export type LiteralResult =
  { ok: true; value: string } | { ok: false; reason: LiteralMiss; marker?: MarkerKind }

/** Where the subject sits in a pattern: its masked span, after an optional "the". */
const N = '(?:the\\s+)?§+'
/** The subject with a possessive. */
const P = `${N}(?:'s|')`
const BE = '(?:was|is|were|are)'
/** Up to four words before a cue ("a cold, clear"). */
const WORDS = "[\\p{L}'-]+(?:,?\\s+[\\p{L}'-]+){0,3}"
const END = '(?![\\p{L}\\p{N}])'
const NUMBER_WORDS =
  'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|' +
  'sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred'
/** An age: digits or number words, joined as "seven-and-twenty", "twenty-one" or "a hundred". */
const AGE = `(?:a\\s+)?(?:\\d{1,3}|${NUMBER_WORDS})(?:[- ](?:and[- ])?(?:${NUMBER_WORDS}))*`
const KIN =
  'son|daughter|brother|sister|father|mother|wife|husband|widow|widower|cousin|aunt|uncle|' +
  'niece|nephew|grandson|granddaughter|grandfather|grandmother|heir|heiress|twin|child|stepson|' +
  'stepdaughter|stepmother|stepfather|half-brother|half-sister'

/** One pattern: the regex over the masked quote, and, for `alive`, the value it proves. */
interface LiteralPattern {
  pattern: RegExp
  /** The slot value the pattern proves when it is not the words it captured ("died" → dead). */
  fixed?: string
}

const rx = (source: string): RegExp => new RegExp(source, 'iud')

const cuePatterns = (cue: string): LiteralPattern[] => [
  { pattern: rx(`${P}\\s+(?<v>${WORDS})\\s+${cue}${END}`) },
  { pattern: rx(`${P}\\s+${cue}\\s+${BE}\\s+(?<v>.+)$`) },
  { pattern: rx(`${N}\\s+(?<verb>had|has)\\s+(?<v>${WORDS})\\s+${cue}${END}`) }
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
      )
    }
  ],
  alive: [
    { pattern: rx(`${N}\\s+(?:was|lay)\\s+(?<v>dead|alive)${END}`) },
    { pattern: rx(`${N}\\s+(?<v>died)${END}`), fixed: 'dead' }
  ],
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
  ],
  traits: [
    {
      pattern: rx(
        `${N}\\s+(?:was|is)\\s+(?<v>` +
          '(?!(?:at|in|on|by|with|inside|near|dead|alive|born|wearing|carrying|holding|dressed)(?![\\p{L}]))' +
          `(?!${AGE}(?![\\p{L}\\p{N}-]))` +
          `(?!(?:(?:the|a|an|his|her|their)\\s+)?(?:${KIN})${END})` +
          '.+)$'
      )
    }
  ]
}

/** Whether a slot has literal patterns at all. */
export function hasLiteralPatterns(slot: Slot): boolean {
  return LITERAL_PATTERNS[slot] !== undefined
}

/**
 * Whether the quote sits inside quotation marks: an odd number of double quotes before it, a
 * double quote inside it, or any single quote that opens a quotation in the sentence (British
 * style; an apostrophe after a letter never does).
 */
function quoted(text: string, at: { start: number; end: number }): boolean {
  const before = (text.slice(0, at.start).match(/"/g) ?? []).length
  if (before % 2 === 1) return true
  if (text.slice(at.start, at.end).includes('"')) return true
  return /(?:^|[\s([—–-])'(?=\p{L})/u.test(text)
}

const CONJUNCTIONS =
  'and|but|or|nor|yet|so|for|though|although|while|whereas|because|since|unless|until|when|' +
  'where|which|who|whom|whose|after|before'
const CLAUSE_BREAK = new RegExp(
  `[;:()\\u2014\\u2013]|\\s-\\s|,\\s*(?:${CONJUNCTIONS})(?![\\p{L}\\p{N}])`,
  'gu'
)

/** Where the clause that holds `from` ends: the next ; : ( ) dash, or a comma before a conjunction. */
function clauseEnd(text: string, from: number): number {
  CLAUSE_BREAK.lastIndex = from
  const found = CLAUSE_BREAK.exec(text)
  return found === null ? text.length : found.index
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
function cutValue(value: string, captured: string): string | null {
  const want = words(straightenQuotes(value)).map((entry) => entry.word)
  const have = words(captured)
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
 * Proves `claim` in code from `sentence` (the sentence its quote is in, as `splitSentences` gives
 * it) and the names the scan found there (`names`, offsets into `sentence`). Answers the value
 * to display, cut to the quote's words, or why it could not prove it.
 */
export function literalProof(
  claim: LiteralClaim,
  sentence: string,
  names: readonly LiteralName[]
): LiteralResult {
  if (claim.voice !== 'narration' || claim.mode !== 'now') return miss('voiceMode')
  const patterns = LITERAL_PATTERNS[claim.slot]
  if (patterns === undefined) return miss('slot')
  const text = straightenQuotes(sentence)
  const at = locateInText(text, claim.quote)
  if (at === null) return miss('quote')
  if (quoted(text, at)) return miss('quoted')

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
  for (const { pattern, fixed } of patterns) {
    const match = pattern.exec(region)
    const captured = match?.groups?.v
    const span = match?.indices?.groups?.v
    if (match === null || captured === undefined || span === undefined) continue
    const original = text.slice(at.start + span[0], at.start + span[1]).replace(/[\s,;:.!?]+$/u, '')
    const value = fixed ?? cutValue(claim.value, original)
    if (value === null || (fixed !== undefined && valueKey(claim.value) !== fixed)) {
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

  // Markers: everything before the quote and the rest of its clause; after that clause, only the
  // markers that reach back over the whole sentence.
  const end = clauseEnd(masked, at.end)
  const own = findMarkers(masked.slice(0, end), { ignore: proved.ignore })[0]
  if (own !== undefined) return miss('marker', own.kind)
  const after = scopeBackMarkers(masked.slice(end))[0]
  if (after !== undefined) return miss('marker', after.kind)
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
