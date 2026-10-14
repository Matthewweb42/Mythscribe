import { straightenQuotes } from '../critique'
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
