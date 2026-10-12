import { straightenQuotes } from '../critique'
import type { ClaimVoice } from './claims'
import type { LiteralName } from './literal'
import type { QuoteMissReason } from './quote'

/**
 * The verification ladder's subject step (F-16.17; design §2.3 step 2, plan P2a §2.4): who a
 * proposed fact is about, settled in code wherever the text allows and never guessed.
 *
 * - A name or nickname of the proposed record in the quote's sentences pins it (`named`); a name
 *   the scan could not settle (a shared alias with more than one owner here) makes it wait on
 *   those owners (`shared`), and the name scan attaches it once the span settles (P2a-D22).
 * - A third-person pronoun ("she", "his", "they"), or a description with no name ("a single man
 *   of large fortune"), is resolved by the checker from its antecedent span: the sentences back to
 *   the last one that names a character, whose characters (and the proposed record) are the
 *   candidates. More than one fitting makes it wait (`antecedent`).
 * - First person resolves to the speaker of a dialogue or thought fact, or to the typed POV, and
 *   then only when the card's verified POV agrees (the pipeline checks that after the checker).
 * - Anything else is refused: a fact whose sentence neither names its subject nor points to one.
 *
 * Pure: the pipeline passes each sentence with the names the scan found in it.
 */

/** Why the ladder refused an item (`reading.rejections`, counted by reason). */
export type LadderReject =
  | QuoteMissReason
  /** Not a slot of the closed list, or one P2a's reader may not propose (knows, thread). */
  | 'slot'
  /** The fact's record is not on the roster, or not a record at all. */
  | 'record'
  /** The text neither names nor points to the subject, or the checker named someone else. */
  | 'subject'
  /** The checker did not support it. */
  | 'unsupported'
  /** The checker supported it without confirming its subject, voice and mode. */
  | 'unconfirmed'
  /** A new name that is not a name the manuscript writes there, or one the author dismissed. */
  | 'name'
  /** An item of the reply that did not parse. */
  | 'shape'

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
  | { kind: 'antecedent'; candidates: string[]; naming: number }
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

  const characters = (sentence: LadderSentence): string[] =>
    sentence.names
      .filter((name) => !name.ambiguous && input.isCharacter(name.recordId))
      .map((name) => name.recordId)
  const inQuote = input.quote.flatMap(characters)
  const span: string[] = []
  for (const sentence of input.before.slice(0, ANTECEDENT_SENTENCES)) {
    const named = characters(sentence)
    span.push(...named)
    if (named.length > 0) {
      return {
        kind: 'antecedent',
        candidates: unique([input.recordId, ...span, ...inQuote]),
        naming: sentence.position
      }
    }
  }
  return { kind: 'none' }
}
