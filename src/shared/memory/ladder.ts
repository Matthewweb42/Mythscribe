import { normalizeForMatch, straightenQuotes } from '../critique'
import type { ClaimVoice } from './claims'
import type { LiteralName } from './literal'
import { nameSpans } from './nameQuestions'
import type { QuoteMissReason } from './quote'
import { ageYears } from './years'

/**
 * The verification ladder's subject step (F-16.17; design §2.3 step 2, plan P2a §2.4): who a
 * proposed fact is about, settled in code wherever the text allows and never guessed.
 *
 * - A name or nickname of the proposed record in the quote's sentences pins it (`named`); a name
 *   the scan could not settle (a shared alias with more than one owner here) makes it wait on
 *   those owners (`shared`), and the name scan attaches it once the span settles (P2a-D22).
 * - A third-person pronoun ("she", "his", "they"), or a description with no name ("a single man
 *   of large fortune"), is resolved by the checker from its antecedent span: every character
 *   named in the quote and in the `ANTECEDENT_SENTENCES` sentences before it is a candidate, so
 *   the checker always sees each rival the pronoun could mean, and more than one fitting makes it
 *   wait (`antecedent`). The proposed record joins them, marked as not named there, only for a
 *   role the text gives ("his wife"); the checker picks it only then. A sentence that holds a
 *   capitalised name the scan does not know and no pronoun is about that new name, never a
 *   description of a roster record (the twin rule: "Jem Falsire" is not Rynna).
 * - First person resolves to the speaker of a dialogue or thought fact, or to the typed POV, and
 *   then only when the card's verified POV agrees (the pipeline checks that after the checker).
 *   P2b (slice 3's replays): a told, overheard or read line quoting its source's own words ("Mr.
 *   Dunmore and I are engaged," Lottie tells Bel) is the exception: the first person is the
 *   source's, so the learner is settled from the names in reach as a pronoun's would be, the
 *   source left out of the candidates.
 * - Anything else is refused: a fact whose sentence neither names its subject nor points to one.
 *
 * Pure: the pipeline passes each sentence with the names the scan found in it.
 */

/** Why the ladder refused an item (`reading.rejections`, counted by reason). */
export type LadderReject =
  | QuoteMissReason
  /** Not a slot of the closed list, or a knows line or thread step with no how the rules know. */
  | 'slot'
  /** The fact's record is not on the roster, or not a record at all. */
  | 'record'
  /** The text neither names nor points to the subject, or the checker named someone else. */
  | 'subject'
  /** The checker did not support it. */
  | 'unsupported'
  /**
   * The checker gave it no verdict (a reply cut off at its cap, once retried, or one that skipped
   * it): not the checker's refusal, so neither a rejected quote nor a check that failed; its
   * paragraph stays unread.
   */
  | 'unanswered'
  /** The checker supported it without confirming its subject, voice and mode. */
  | 'unconfirmed'
  /** A new name that is not a name the manuscript writes there, or one the author dismissed. */
  | 'name'
  /** An item of the reply that did not parse. */
  | 'shape'
  /** P2b-D8: a knows line whose learner is not here or the point of view, nor shown on the page. */
  | 'notHere'
  /** P2b-D8: a group learner its sentence does not name. */
  | 'group'
  /**
   * P2b-D3: a new secret or thread whose revealing sentence is not in the window or the checker did
   * not find revealing it, and every fact that came with it.
   */
  | 'topic'
  /** P2b-D11: a new secret or thread past the page's caps, and its facts. */
  | 'topicCap'
  /** A fact whose value's words are not in its quote (`valueStated`; live run 2026-10-14). */
  | 'value'
  /** A fact in a slot its record's kind cannot hold (`slotFitsKind`: a place's "home"). */
  | 'kind'
  /** A state fact read as now from a want, wish, hope or plan (`wishWord`; "Johanna wanted thread"). */
  | 'wish'
  /*
   * The gates of the second live run of 2026-10-14 (each before the checker):
   */
  /** A value that states an absence or a negation ("not there"; `absentValue`). */
  | 'absence'
  /** A value not of its slot's kind: an age that is no age, a feeling as an object (`valueOfKind`). */
  | 'valueKind'
  /** A location not stated as where the subject is or goes (`locationStated`; "the road"). */
  | 'where'
  /** A state of the subject's at their death, which is history, not now (`diesInQuote`). */
  | 'past'
  /** The quote states it of another person reached through the subject ("my father"; `possessedOnly`). */
  | 'possessed'
  /** The same fact again in another slot or quote of this reading: one claim, one slot. */
  | 'duplicate'

/** One sentence of the scene as the ladder reads it. */
export interface LadderSentence {
  /** Its position in the scene's sentence list (`sceneSentences`). */
  position: number
  text: string
  /** The names the scan found in it, offsets into the sentence (`sentenceNames`). */
  names: readonly LiteralName[]
}

export type SubjectResult =
  | { kind: 'named'; text: string }
  | { kind: 'shared'; candidates: string[]; text: string }
  | {
      kind: 'antecedent'
      /** The characters named in the quote and the sentences before it, nearest first, then `unnamed`. */
      candidates: string[]
      /** The earliest sentence that names a candidate: the checker's text starts there. */
      naming: number
      /** Each candidate named before the quote, at its nearest naming sentence. */
      namedAt: Readonly<Record<string, number>>
      /** The proposed record when nothing in reach names it (a role, "his wife"); null otherwise. */
      unnamed: string | null
    }
  | { kind: 'firstPerson'; via: 'speaker' | 'pov'; recordId: string }
  | { kind: 'none' }

export interface SubjectInput {
  /** The record the reader proposed. */
  recordId: string
  voice: ClaimVoice
  speakerId: string | null
  /** The quote's sentences, in order. */
  quote: readonly LadderSentence[]
  /** The sentences before the quote that were sent, nearest first. */
  before: readonly LadderSentence[]
  typedPov: string | null
  isCharacter: (recordId: string) => boolean
  /**
   * P2b: a knows line's source when its how keeps one (told, overheard, read); when the quote is
   * that source's dialogue, its first person is the source's, not the learner's.
   */
  sourceId?: string | null
}

/** Most sentences back a pronoun's antecedent is looked for. */
export const ANTECEDENT_SENTENCES = 8

const THIRD =
  /(?<![\p{L}\p{N}'])(?:he|him|his|himself|she|her|hers|herself|they|them|their|theirs|themselves)(?![\p{L}\p{N}])/iu
const FIRST = /(?<![\p{L}\p{N}'])(?:I|me|my|mine|myself|we|us|our|ours|ourselves)(?![\p{L}\p{N}'])/u
const FIRST_FOLDED =
  /(?<![\p{L}\p{N}'])(?:Me|My|Mine|Myself|We|Us|Our|Ours|Ourselves)(?![\p{L}\p{N}'])/u

/** Whether a text uses a pronoun of the first or the third person (first person wins). */
export function pronounPerson(text: string): 'first' | 'third' | null {
  const straight = straightenQuotes(text)
  if (FIRST.test(straight) || FIRST_FOLDED.test(straight)) return 'first'
  return THIRD.test(straight) ? 'third' : null
}

/** Where a name stands in a sentence as written (case kept, whole words); null when it does not. */
export function nameInSentence(
  sentence: string,
  name: string
): { start: number; end: number } | null {
  const escaped = name
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
  if (escaped === '') return null
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u').exec(
    straightenQuotes(sentence)
  )
  return match === null ? null : { start: match.index, end: match.index + match[0].length }
}

/**
 * P2b-D8 (amended in review of P2b slice 2): a group a sentence names by its head noun, the last
 * word of one of its names, in any case, as a whole word ("By Sunday the whole regiment knew"
 * names "the regiment"; design §2.5's "the whole harbour knew"). The head noun as written in its
 * name, or null when none stands in the sentences; a head shorter than three letters never counts.
 */
export function groupHeadIn(names: readonly string[], sentences: readonly string[]): string | null {
  for (const name of names) {
    const head = /([\p{L}][\p{L}'’-]*)[^\p{L}]*$/u.exec(name.trim())?.[1]
    if (head === undefined || [...head].length < 3) continue
    const escaped = head.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu')
    if (sentences.some((sentence) => pattern.test(straightenQuotes(sentence)))) return head
  }
  return null
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)]

/** Settles who a proposed fact is about (see the module comment). */
export function resolveSubject(input: SubjectInput): SubjectResult {
  const names = input.quote.flatMap((sentence) =>
    sentence.names.map((name) => ({ name, text: sentence.text.slice(name.start, name.end) }))
  )
  const certain = names.find(
    (entry) => entry.name.recordId === input.recordId && !entry.name.ambiguous
  )
  if (certain !== undefined) return { kind: 'named', text: certain.text }

  // A shared alias here: the span's owners, grouped by where the span stands.
  const spans = new Map<string, { ids: string[]; text: string }>()
  for (const entry of names) {
    if (!entry.name.ambiguous) continue
    const key = `${entry.name.start}:${entry.name.end}:${entry.text}`
    const span = spans.get(key) ?? { ids: [], text: entry.text }
    span.ids.push(entry.name.recordId)
    spans.set(key, span)
  }
  for (const span of spans.values()) {
    if (span.ids.includes(input.recordId)) {
      return { kind: 'shared', candidates: unique(span.ids).sort(), text: span.text }
    }
  }

  const text = input.quote.map((sentence) => sentence.text).join(' ')
  const person = pronounPerson(text)
  // The source speaking to the learner: "I" is the source, and the learner is found in reach.
  const sourceSpeaks =
    input.voice === 'dialogue' &&
    input.sourceId != null &&
    input.speakerId === input.sourceId &&
    input.sourceId !== input.recordId
  if (person === 'first' && !sourceSpeaks) {
    const spoken = input.voice === 'dialogue' || input.voice === 'thought'
    if (spoken && input.speakerId === input.recordId) {
      return { kind: 'firstPerson', via: 'speaker', recordId: input.recordId }
    }
    if (!spoken && input.typedPov === input.recordId) {
      return { kind: 'firstPerson', via: 'pov', recordId: input.recordId }
    }
    return { kind: 'none' }
  }

  // A name the scan does not know, and no pronoun: the fact is that new name's (the twin rule).
  if (person === null && input.quote.some(unknownName)) return { kind: 'none' }

  // The characters a sentence names (and the proposed record, whatever its kind); never the
  // source whose words the quote is.
  const characters = (sentence: LadderSentence): string[] =>
    sentence.names
      .filter(
        (name) =>
          !name.ambiguous &&
          (input.isCharacter(name.recordId) || name.recordId === input.recordId) &&
          !(sourceSpeaks && name.recordId === input.sourceId)
      )
      .map((name) => name.recordId)
  const namedAt: Record<string, number> = {}
  const order: string[] = []
  let naming = -1
  for (const sentence of input.before.slice(0, ANTECEDENT_SENTENCES)) {
    const named = characters(sentence)
    if (named.length === 0) continue
    naming = sentence.position
    for (const id of named) {
      if (namedAt[id] !== undefined) continue
      namedAt[id] = sentence.position
      order.push(id)
    }
  }
  if (naming === -1) return { kind: 'none' }
  const candidates = unique([...order, ...input.quote.flatMap(characters)])
  const unnamed = candidates.includes(input.recordId) ? null : input.recordId
  return {
    kind: 'antecedent',
    candidates: unnamed === null ? candidates : [...candidates, unnamed],
    naming,
    namedAt,
    unnamed
  }
}

/**
 * Whether a sentence holds a capitalised name the scan did not find there (`nameSpans`): one
 * standing mid-sentence, or one of two words or more opening it ("Jem Falsire had green eyes").
 * A single capitalised word opening a sentence may be any word, and is not counted.
 */
export function unknownName(sentence: LadderSentence): boolean {
  return nameSpans(sentence.text).some(
    (span) =>
      (!span.sentenceStart || span.words.length >= 2) &&
      !sentence.names.some((name) => name.start < span.end && span.start < name.end)
  )
}

/*
 * The code gates added after the live planted-error run of 2026-10-14 (design §2.3: "Displayed
 * values use only words from the quote"; step 2: the subject is named or pointed to, never
 * guessed). Each runs before the checker, so a gullible verdict cannot let the fact in.
 */

/** Words a value may hold that the quote need not (articles, prepositions, possessives). */
const VALUE_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'of',
  'in',
  'at',
  'on',
  'to',
  'by',
  'for',
  'from',
  'with',
  'and',
  'or',
  'his',
  'her',
  'hers',
  'their',
  'its',
  'my',
  'our',
  'your',
  'is',
  'was',
  'were',
  'be',
  'been',
  'as',
  'that',
  'this'
])

const wordsOf = (text: string): string[] =>
  (
    straightenQuotes(text)
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) ?? []
  ).filter((word) => [...word].length > 1 || /\p{N}/u.test(word))

/** The shortest shared start that counts two words as one (proud, proudest; temper, tempered). */
const STEM_LETTERS = 4

const sameWord = (a: string, b: string): boolean => {
  if (a === b) return true
  const [short, long] = a.length <= b.length ? [a, b] : [b, a]
  return [...short].length >= STEM_LETTERS && long.startsWith(short)
}

/**
 * Slots whose value is not the quote's own words: alive (dead, alive, from "died", "came down to
 * breakfast"), kinship (a relation word, "son of" from "My father was"), and the knows and thread
 * lines (their value is the how or the step).
 */
const VALUE_FREE_SLOTS = new Set(['alive', 'kinship', 'knows', 'thread'])

/**
 * Whether every content word of a fact's value stands in its quote, as a word or a word sharing
 * its first four letters or more ("proud" in "the proudest"), case and quotes aside; true for the
 * slots whose value is not the quote's words (`VALUE_FREE_SLOTS`). "the road" from "Johanna
 * walked quickly" and "at the table" from "Mr. Harrow said nothing more" fail.
 */
export function valueStated(slot: string, value: string, quote: string): boolean {
  if (VALUE_FREE_SLOTS.has(slot)) return true
  // An age may be given in digits for words ("22" from "two-and-twenty").
  if (slot === 'age') {
    const years = ageYears(value)
    if (years !== null && ageYears(quote) === years) return true
  }
  const quoted = wordsOf(quote)
  return wordsOf(value)
    .filter((word) => !VALUE_STOPWORDS.has(word))
    .every((word) => quoted.some((other) => sameWord(word, other)))
}

const SINGULAR_THIRD =
  /(?<![\p{L}\p{N}'])(?:he|him|his|himself|she|her|hers|herself)(?![\p{L}\p{N}])/iu
const PLURAL_OR_IT = /(?<![\p{L}\p{N}'])(?:they|them|their|theirs|it|its)(?![\p{L}\p{N}])/iu

/** Singular nouns that name one person ("a single man", "the old woman", "his wife"). */
const PERSON_NOUNS = [
  'man',
  'woman',
  'gentleman',
  'lady',
  'girl',
  'boy',
  'child',
  'baby',
  'youth',
  'fellow',
  'wife',
  'husband',
  'widow',
  'widower',
  'mother',
  'father',
  'daughter',
  'son',
  'sister',
  'brother',
  'aunt',
  'uncle',
  'cousin',
  'niece',
  'nephew',
  'grandmother',
  'grandfather',
  'servant',
  'maid',
  'butler',
  'footman',
  'stranger',
  'visitor',
  'guest',
  'host',
  'hostess',
  'friend',
  'neighbour',
  'neighbor',
  'officer',
  'soldier',
  'sailor',
  'captain',
  'colonel',
  'doctor',
  'clergyman',
  'curate',
  'parson',
  'vicar',
  'priest',
  'master',
  'mistress',
  'heir',
  'heiress',
  'landlord',
  'landlady',
  'keeper',
  'king',
  'queen',
  'prince',
  'princess',
  'creature'
]
const EPITHET = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:a|an|the|this|that|one|his|her|their|my|our|your)\\s+(?:[\\p{L}'’-]+\\s+){0,3}(?:${PERSON_NOUNS.join('|')})(?![\\p{L}\\p{N}])`,
  'iu'
)

/** Slots whose quote may point at the body part rather than the person ("They were grey"). */
const PART_SLOTS = new Set(['eyes', 'hair'])

/**
 * Whether a fact whose subject the checker settles from the sentences before (an `antecedent`
 * subject) points at one person in its quote (design §2.3 step 2): a singular he or she ("his",
 * "herself"), or a description of one person ("a single man of large fortune", "his wife"); for
 * eyes and hair also a they or it standing for the part ("They were the colour of wet slate").
 * A quote that points at nobody ("How can you be so unfeeling") or only at several ("the sisters
 * walked to Callow Cross") never lets the checker pick one of them.
 */
export function pointsAtOne(slot: string, quote: string): boolean {
  const text = straightenQuotes(quote)
  if (SINGULAR_THIRD.test(text) || EPITHET.test(text)) return true
  return PART_SLOTS.has(slot) && PLURAL_OR_IT.test(text)
}

/** Whether a name stands in a text as whole words, any case ("The Captain's" holds "the Captain"). */
function nameIn(text: string, name: string): boolean {
  const escaped = straightenQuotes(name)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
  if (escaped === '') return false
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').test(
    straightenQuotes(text)
  )
}

/**
 * Whether a fact's quote itself points at its subject (live run 2026-10-14: the sentence named
 * Johanna, but the quote "talked of everything except Thornmere" and "the sisters walked to
 * Callow Cross" did not): one of the names its sentences call the subject by (`names`) stands in
 * the quote, or, for a first-person subject, an I or my does, or the quote points at one person
 * (`pointsAtOne`: a he or she, a description, a they for eyes). The quote is the fewest words that
 * state the fact, so a fact whose words leave the subject out is not proved about them.
 */
export function quotePointsAtSubject(input: {
  slot: string
  quote: string
  /** The names the quote's sentences call the subject by, as written. */
  names: readonly string[]
  firstPerson: boolean
}): boolean {
  if (input.names.some((name) => nameIn(input.quote, name))) return true
  if (input.firstPerson && pronounPerson(input.quote) === 'first') return true
  return pointsAtOne(input.slot, input.quote)
}

/** Want, wish, hope and plan words: what follows them is not so, only wanted. */
const WISH =
  /(?<![\p{L}\p{N}'])(?:wants?|wanted|wanting|wish|wishes|wished|wishing|hopes?|hoped|hoping|longed|longing|intends?|intended|intending|means? to|meant to|plans? to|planned|planning|needs? to|needed|desires?|desired|expects?|expected|would like|going to)(?![\p{L}\p{N}])/iu

/** Slots a wish may well describe as they are (an ambition is a trait; a plan made is history). */
const WISH_FREE_SLOTS = new Set(['traits', 'history', 'relation', 'knows', 'thread'])

/**
 * The want, wish, hope or plan word in a fact's quote that makes a state read as now unproved
 * ("Johanna wanted thread" is not thread carried; "I hope Mr. Ashby will like it" is no
 * occupation), or null. Only for a fact in mode now, and not for traits, history or relations.
 */
export function wishWord(slot: string, mode: string, quote: string): string | null {
  if (mode !== 'now' || WISH_FREE_SLOTS.has(slot)) return null
  return WISH.exec(straightenQuotes(quote))?.[0] ?? null
}

/*
 * The gates of the second live run of 2026-10-14 (`test-results/eval-memory/planted-2026-10-14.md`,
 * 19:20): facts the checker passed that the quote does not make true of their subject now. Each
 * runs before the checker, so a gullible verdict cannot let one in.
 */

/** Slots whose value may well hold a "not" (a trait, a past act, a relation, a death, an age). */
const NEGATION_FREE_SLOTS = new Set([
  'traits',
  'history',
  'relation',
  'alive',
  'kinship',
  'age',
  'knows',
  'thread'
])
const NEGATION =
  /(?<![\p{L}\p{N}'’])(?:not|never|no|nowhere|nobody|none|nothing|absent|missing|without)(?![\p{L}\p{N}])|n['’]t(?![\p{L}\p{N}])/iu

/**
 * The negation in a fact's value that makes it an absence ("not there", "nowhere", "no hat"), or
 * null: the text states no value by saying what is not (design §2.3: a negation states nothing;
 * an absence is never stored as a value). Not for traits, history, relations, alive, kinship or
 * an age ("not yet sixteen" is an age).
 */
export function absentValue(slot: string, value: string): string | null {
  if (NEGATION_FREE_SLOTS.has(slot)) return null
  return NEGATION.exec(straightenQuotes(value))?.[0] ?? null
}

/** The words an age may be written in beside its count ("about forty", "not yet sixteen"). */
const AGE_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'of',
  'his',
  'her',
  'their',
  'years',
  'year',
  'yrs',
  'old',
  'aged',
  'age',
  'months',
  'month',
  'weeks',
  'week',
  'days',
  'day',
  'about',
  'nearly',
  'almost',
  'past',
  'over',
  'under',
  'some',
  'just',
  'barely',
  'not',
  'yet',
  'quite',
  'full',
  'turned',
  'turning',
  'odd',
  'young',
  'younger',
  'youngest',
  'older',
  'oldest',
  'elderly',
  'middle',
  'grown',
  'adult',
  'teens',
  'twenties',
  'thirties',
  'forties',
  'fifties',
  'sixties',
  'seventies',
  'eighties',
  'nineties'
])

/** Feelings, acts and attention: no thing a person holds or carries (`objects`). */
const ABSTRACT_NOUNS = new Set([
  'attention',
  'attentions',
  'affection',
  'affections',
  'admiration',
  'regard',
  'esteem',
  'respect',
  'love',
  'hope',
  'hopes',
  'fear',
  'fears',
  'interest',
  'notice',
  'care',
  'cares',
  'thought',
  'thoughts',
  'idea',
  'ideas',
  'opinion',
  'opinions',
  'advice',
  'news',
  'time',
  'favour',
  'favours',
  'favor',
  'favors',
  'kindness',
  'civility',
  'civilities',
  'compliment',
  'compliments',
  'manners',
  'intention',
  'intentions',
  'feeling',
  'feelings',
  'spirits',
  'temper',
  'approval',
  'consent',
  'permission',
  'promise',
  'promises',
  'knowledge',
  'memory',
  'memories',
  'praise',
  'pity',
  'sympathy',
  'gratitude',
  'suspicion',
  'suspicions'
])

const tokensOf = (text: string): string[] =>
  straightenQuotes(text)
    .toLowerCase()
    .match(/[\p{L}\p{N}]+/gu) ?? []

/**
 * Whether a fact's value is of its slot's kind: an age is a count of years (or months) in digits
 * or words, with only the words an age is said in ("seven-and-twenty", "about forty", "not yet
 * sixteen"), never "four grown-up daughters"; an object is no feeling, act or attention
 * ("attentions", "his regard"). Every other slot: true.
 */
export function valueOfKind(slot: string, value: string): boolean {
  const words = tokensOf(value)
  if (slot === 'age') {
    return (
      words.some((word) => ageYears(word) !== null) &&
      words.every((word) => AGE_WORDS.has(word) || ageYears(word) !== null)
    )
  }
  if (slot === 'objects') {
    const head = words.find((word) => !VALUE_STOPWORDS.has(word))
    return head === undefined || !ABSTRACT_NOUNS.has(head)
  }
  return true
}

/** Words that put someone at, in, into or towards a place ("called at Wexley", "came up the stairs"). */
const PLACE_CUES = new Set([
  'at',
  'in',
  'on',
  'to',
  'into',
  'onto',
  'upon',
  'by',
  'near',
  'from',
  'towards',
  'toward',
  'inside',
  'outside',
  'beside',
  'behind',
  'before',
  'across',
  'along',
  'over',
  'under',
  'through',
  'up',
  'down',
  'within',
  'beyond',
  'past',
  'around',
  'round',
  'among',
  'amongst',
  'between',
  'off',
  'reached',
  'entered',
  'visited',
  'left',
  'crossed',
  'climbed',
  'passed',
  'reach',
  'enter',
  'visit'
])
/** A place said in one word, with no preposition ("she was abroad", "he stayed home"). */
const PLACE_ADVERBS = new Set([
  'abroad',
  'home',
  'upstairs',
  'downstairs',
  'overseas',
  'ashore',
  'aboard',
  'indoors',
  'outdoors',
  'away',
  'inside',
  'outside'
])

/** Where one sentence of a quote ends: a stop (not after a title, "Mr."), or a semicolon. */
const SENTENCE_BREAK = /(?<!(?:^|[^\p{L}])(?:Mr|Mrs|Ms|Dr|St|Capt|Col|Rev|Lt|Sgt))[.!?]+(?=\s|$)|;/u

/**
 * Whether a location's value is stated as where its subject is or goes (second live run: "the
 * road" from "The road was hard with frost, and the hedges were full of fieldfares. Johanna walked
 * quickly…"): the value's words stand in one sentence of the quote that also names or points at
 * the subject (`quotePointsAtSubject`), after a word that puts someone somewhere ("at", "to",
 * "up", "reached"…: the value's own first word or one of the three before it), or the value is a
 * place in one word ("abroad", "home"). A place merely described beside them is no location of
 * theirs; "here" and "there" alone name none.
 */
export function locationStated(input: {
  value: string
  quote: string
  names: readonly string[]
  firstPerson: boolean
}): boolean {
  const own = wordsOf(input.value).filter((word) => !VALUE_STOPWORDS.has(word))
  if (own.length === 0 || own.every((word) => word === 'here' || word === 'there')) return false
  const valueTokens = tokensOf(input.value)
  const first = own[0] ?? ''
  return straightenQuotes(input.quote)
    .split(SENTENCE_BREAK)
    .some((segment) => {
      const tokens = tokensOf(segment)
      if (!own.every((word) => tokens.some((token) => sameWord(word, token)))) return false
      const pointed = quotePointsAtSubject({
        slot: 'location',
        quote: segment,
        names: input.names,
        firstPerson: input.firstPerson
      })
      if (!pointed) return false
      if (valueTokens.length === 1 && PLACE_ADVERBS.has(valueTokens[0] ?? '')) return true
      if (PLACE_CUES.has(valueTokens[0] ?? '')) return true
      const at = tokens.findIndex((token) => sameWord(first, token))
      return tokens.slice(Math.max(0, at - 3), at).some((token) => PLACE_CUES.has(token))
    })
}

/** Slots that say how someone is now: at their death they are history ("died in his chair"). */
const STATE_SLOTS = new Set(['location', 'clothing', 'objects', 'injuries'])
const DEATH_WORDS =
  '(?:died|dies|perished|drowned|lay\\s+dead|(?:was|were)\\s+(?:killed|buried|drowned|found\\s+dead)|passed\\s+away)'

const escapeName = (name: string): string =>
  straightenQuotes(name)
    .trim()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')

/**
 * Whether a state fact's sentences tell its subject's death (second live run: Hobb's "in his
 * chair by the lodge fire" from "He died in the night, in his chair by the lodge fire"): the
 * subject's name, a he or she, or their I, then within three words died, drowned, was killed,
 * passed away. Where someone died, and what they wore or held then, is their history, never where
 * or how they are now. Only for location, clothing, objects and injuries; another's death in the
 * sentence ("for her father had died") does not count.
 */
export function diesInQuote(input: {
  slot: string
  sentences: readonly string[]
  names: readonly string[]
  firstPerson: boolean
}): boolean {
  if (!STATE_SLOTS.has(input.slot)) return false
  const pointers = [
    'he',
    'she',
    ...(input.firstPerson ? ['I'] : []),
    ...input.names.map(escapeName).filter((name) => name !== '')
  ]
  const death = new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${pointers.join('|')})\\s+(?:[\\p{L}'’-]+\\s+){0,3}?${DEATH_WORDS}(?![\\p{L}\\p{N}])`,
    'iu'
  )
  return input.sentences.some((sentence) => death.test(straightenQuotes(sentence)))
}

/**
 * Whether two quotes are one, or one stands inside the other, case and spacing aside (one claim,
 * one slot: the second live run proposed "violent against him" as both a relation and a trait).
 */
export function sameQuote(a: string, b: string): boolean {
  const x = normalizeForMatch(a).toLowerCase()
  const y = normalizeForMatch(b).toLowerCase()
  return x !== '' && y !== '' && (x.includes(y) || y.includes(x))
}

/** A person reached through someone: "my father", "her late husband's", "Mr. Harrow's daughters". */
const POSSESSED_PERSON = `(?:[\\p{L}'’-]+\\s+){0,2}?(?:${PERSON_NOUNS.join('|')})(?:s|es)?(?:['’]s|['’])?(?![\\p{L}\\p{N}])`
const POSSESSIVE_PHRASE = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:my|his|her|their|our|your)\\s+${POSSESSED_PERSON}`,
  'giu'
)

/** Slots in which a fact about a relative is the subject's own ("My father was a clergyman"). */
const POSSESSED_FREE_SLOTS = new Set(['kinship', 'relation', 'history', 'knows', 'thread'])

/**
 * Whether a fact's quote points at its subject only through another person reached by them
 * (second live run: Mr. Dunmore's occupation from "My father was a clergyman in Elsdale"): with
 * every "my father", "his wife", "Mr. Harrow's daughters" taken out, no name of the subject, no I
 * of theirs and no he or she is left in the quote, so it states the relative's fact, not theirs (a
 * description left, "a clergyman", is the relative's value, not a pointer at the subject). Not for
 * kinship, relation or history, where a relative's fact is the subject's own ("son of a
 * clergyman", "the Captain's father was a merchant"). The pipeline does not ask it for a subject
 * that is the relative itself ("his wife" as the wife, the ladder's `unnamed`).
 */
export function possessedOnly(input: {
  slot: string
  quote: string
  names: readonly string[]
  firstPerson: boolean
}): boolean {
  if (POSSESSED_FREE_SLOTS.has(input.slot)) return false
  const straight = straightenQuotes(input.quote)
  let stripped = straight.replace(POSSESSIVE_PHRASE, ' ')
  for (const name of input.names.map(escapeName)) {
    if (name === '') continue
    stripped = stripped.replace(
      new RegExp(`(?<![\\p{L}\\p{N}])${name}['’]s\\s+${POSSESSED_PERSON}`, 'giu'),
      ' '
    )
  }
  if (stripped === straight) return false
  const left =
    input.names.some((name) => nameIn(stripped, name)) ||
    (input.firstPerson && pronounPerson(stripped) === 'first') ||
    SINGULAR_THIRD.test(stripped) ||
    (PART_SLOTS.has(input.slot) && PLURAL_OR_IT.test(stripped))
  return !left
}
