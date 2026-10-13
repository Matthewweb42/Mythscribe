import { straightenQuotes } from '../critique'
import type { ClaimVoice } from './claims'
import type { LiteralName } from './literal'
import { nameSpans } from './nameQuestions'
import type { QuoteMissReason } from './quote'

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
  if (person === 'first') {
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

  // The characters a sentence names (and the proposed record, whatever its kind).
  const characters = (sentence: LadderSentence): string[] =>
    sentence.names
      .filter(
        (name) =>
          !name.ambiguous && (input.isCharacter(name.recordId) || name.recordId === input.recordId)
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
