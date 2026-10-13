import { holdsSlotCue, SLOT_QUESTION_CUES } from './askParse'
import type { NoteOwnerKind } from './findings'
import { kinWords, patternValue } from './literal'
import type { CaseRule } from './records'
import { splitSentences } from './sentences'
import { slotLabel, type Slot } from './slots'

/**
 * C6's note side (F-16.27; design §2.4, plan P4 §1.2, P4-D8), pure: which sentences of the author's
 * canon notes speak of a record's slot, and the value code can read from them. A note sentence is
 * paired with a claim only when it names the record (or sits on the record's own Pinned page) and
 * holds a cue for the slot; its value must be readable in code (a `Label: value` line, a dated
 * `Label (from 12.1 'Title'): value` line, or a slot's literal pattern), else it is never compared:
 * the judge sees only values code read. Notes are canon Pinned paragraphs and canon Research pages
 * (never Ideas, Not canon pages or paragraphs, scene notes or synopses: the caller reads only those).
 */

/** A canon note paragraph: a record's Pinned paragraph, or a Research page's. */
export interface NoteParagraph {
  ownerKind: NoteOwnerKind
  ownerId: string
  /** `pinned` for a record's page; null for a Research page. */
  page: 'pinned' | null
  para: number
  text: string
}

/** One sentence of a note paragraph, with its index in the paragraph. */
export interface NoteSentence {
  note: NoteParagraph
  sentence: number
  text: string
}

/** A note paragraph's sentences (`splitSentences`), empty ones left out. */
export function noteSentences(note: NoteParagraph): NoteSentence[] {
  return splitSentences(note.text)
    .map((span, sentence) => ({ note, sentence, text: span.text.trim() }))
    .filter((each) => each.text !== '')
}

/** One of a record's names as a note is read for it. */
export interface NoteName {
  text: string
  caseRule: CaseRule
  /** Several records answer to it (identity rule 4): it never names one record alone. */
  shared: boolean
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const straight = (text: string): string => text.replace(/[‘’]/g, "'")

/**
 * Where a record's names stand in a text: whole words, a possessive included, a name with a
 * capital letter as written (a name kept in any case, in any case); a shared name never counts.
 * The longest names first, so "Anne Fenwick" is one span, not "Anne".
 */
export function nameSpans(
  text: string,
  names: readonly NoteName[]
): { start: number; end: number }[] {
  const plain = straight(text)
  const spans: { start: number; end: number }[] = []
  const ordered = names
    .filter((name) => !name.shared && name.text.trim() !== '')
    .sort((a, b) => b.text.length - a.text.length)
  for (const name of ordered) {
    const anyCase = name.caseRule === 'any' || !/[\p{Lu}\p{Lt}]/u.test(name.text)
    const written = straight(name.text)
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(written)}(?:'s|')?(?![\\p{L}\\p{N}])`,
      anyCase ? 'giu' : 'gu'
    )
    // A sentence's first word may differ in its first letter only ("The Captain" for "the Captain").
    const first = written.slice(0, 1)
    const flipped =
      first === first.toLowerCase()
        ? first.toUpperCase() + written.slice(1)
        : first.toLowerCase() + written.slice(1)
    const opening = anyCase
      ? null
      : new RegExp(`^\\s*(${escapeRegExp(flipped)}(?:'s|')?)(?![\\p{L}\\p{N}])`, 'u').exec(plain)
    const found = [...plain.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length
    }))
    if (opening !== null) {
      const words = opening[1] ?? ''
      found.push({ start: opening[0].length - words.length, end: opening[0].length })
    }
    for (const { start, end } of found) {
      if (spans.some((span) => start < span.end && end > span.start)) continue
      spans.push({ start, end })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

/** Whether a text names a record (`nameSpans`). */
export const namesRecord = (text: string, names: readonly NoteName[]): boolean =>
  nameSpans(text, names).length > 0

/** The labels a `Label: value` line may use for a slot, besides its display name and its cues. */
const EXTRA_LABELS: Readonly<Partial<Record<Slot, readonly string[]>>> = {
  eyes: ['eye colour', 'eye color', 'eyes'],
  hair: ['hair colour', 'hair color'],
  born: ['birth', 'birth year', 'date of birth', 'year of birth'],
  location: ['location', 'whereabouts', 'place'],
  age: ['age'],
  kinship: ['family', 'kin']
}

/** Lower case, straight quotes, single spaces. */
const fold = (text: string): string => straight(text).toLowerCase().replace(/\s+/g, ' ').trim()

/** Every label a `Label: value` line about `slot` may carry, folded. */
export function slotLabels(slot: Slot): string[] {
  const cues = SLOT_QUESTION_CUES.find((row) => row.slot === slot)?.cues ?? []
  return [...new Set([slotLabel(slot), ...cues, ...(EXTRA_LABELS[slot] ?? [])].map(fold))]
}

/** A `Label: value` line, with the dated form's scene (`Label (from 12.1 'Title'): value`). */
export interface LabelLine {
  label: string
  scene: string | null
  value: string
}

const LABEL_LINE = /^\s*([^:()\n]{1,40}?)\s*(?:\(\s*from\s+([^)]*)\))?\s*:\s*(.+?)\s*$/iu

/** The label, dated scene and value of a `Label: value` line; null for any other sentence. */
export function labelLine(text: string): LabelLine | null {
  const match = LABEL_LINE.exec(text)
  if (match === null) return null
  const value = (match[3] ?? '').replace(/[.;]+$/u, '').trim()
  if (value === '') return null
  return { label: fold(match[1] ?? ''), scene: match[2]?.trim() ?? null, value }
}

/** The record a note is read for: its id and names. */
export interface NoteRecord {
  id: string
  names: readonly NoteName[]
}

/**
 * Whether a note sentence speaks of a record's slot (P4-D8): it names the record, or sits on the
 * record's own Pinned page; and it holds a cue for the slot (`holdsSlotCue`), or is a `Label:
 * value` line whose label is the slot's. Kinship's cue is a kin word.
 */
export function pairsWith(sentence: NoteSentence, record: NoteRecord, slot: Slot): boolean {
  const own =
    sentence.note.ownerKind === 'record' &&
    sentence.note.ownerId === record.id &&
    sentence.note.page === 'pinned'
  if (!own && !namesRecord(sentence.text, record.names)) return false
  const line = labelLine(sentence.text)
  if (line !== null && slotLabels(slot).includes(line.label)) return true
  if (slot === 'kinship') return kinWords(sentence.text).length > 0
  return holdsSlotCue(sentence.text, slot)
}

/** A value code read from a note sentence, with the dated line's scene as written. */
export interface NoteValue {
  value: string
  /** `12.1 'Title'` of a dated line; null otherwise. */
  scene: string | null
}

/** The sentence with the record's names masked as `§` and nothing else moved (same length). */
function masked(text: string, names: readonly NoteName[]): string {
  let out = straight(text)
  for (const span of nameSpans(out, names)) {
    // The possessive stays readable for the patterns ("§§§§'s eyes").
    const name = out.slice(span.start, span.end).replace(/'s?$/u, '')
    out = out.slice(0, span.start) + '§'.repeat(name.length) + out.slice(span.start + name.length)
  }
  return out
}

/**
 * The value a note sentence gives for a record's slot (P4-D8): a `Label: value` line whose label
 * is the slot's (with its dated scene, when it has one); else the slot's literal patterns over the
 * sentence with the record's names masked; else null (not compared).
 */
export function noteValue(
  sentence: NoteSentence,
  record: NoteRecord,
  slot: Slot
): NoteValue | null {
  const line = labelLine(sentence.text)
  if (line !== null && slotLabels(slot).includes(line.label)) {
    return { value: line.value, scene: line.scene }
  }
  const value = patternValue(slot, straight(sentence.text), masked(sentence.text, record.names))
  return value === null ? null : { value, scene: null }
}

/**
 * The kin word a note sentence gives for a record's kinship to `object` (P4-D8: the sentence must
 * name the object too): the kin word right after the object's possessive ("Anne is the Captain's
 * sister"), or one followed by "of" and then the object ("Anne, sister of the Captain"); a kin word
 * after the record's own possessive ("Anne's brother is the Captain") speaks of the other person and
 * is never read. Null when none is read.
 */
export function noteKinValue(
  sentence: NoteSentence,
  record: NoteRecord,
  object: NoteRecord
): string | null {
  const text = straight(sentence.text)
  const objects = nameSpans(text, object.names)
  if (objects.length === 0) return null
  const own =
    sentence.note.ownerKind === 'record' &&
    sentence.note.ownerId === record.id &&
    sentence.note.page === 'pinned'
  if (!own && nameSpans(text, record.names).length === 0) return null
  for (const kin of kinWords(text)) {
    const before = text.slice(0, kin.start).trimEnd()
    const afterObject = objects.some(
      (span) => before.length === span.end && /'s?$/u.test(text.slice(span.start, span.end))
    )
    const ofObject =
      /^\s+of\s+/iu.test(text.slice(kin.end)) && objects.some((span) => span.start > kin.end)
    if (afterObject || ofObject) return kin.word
  }
  return null
}

/** A readable scene a dated line may name: its node, its reference ("12.1") and title. */
export interface DatedScene {
  nodeId: string
  ref: string
  title: string
}

/**
 * The scene a dated line names (`12.1 'Title'`, `'Title'` or `12.1`): by its title when exactly one
 * scene has it, else by its number when exactly one has that; null when it is ambiguous or gone.
 */
export function datedScene(text: string, scenes: readonly DatedScene[]): string | null {
  const match = /^\s*(\d+(?:\.\d+)?)?\s*(?:['‘’"“”](.*)['‘’"“”])?\s*$/u.exec(text)
  if (match === null) return null
  const number = match[1] ?? null
  const title = match[2] === undefined ? null : fold(match[2])
  if (title !== null && title !== '') {
    const byTitle = scenes.filter((scene) => fold(scene.title) === title)
    if (byTitle.length === 1) return byTitle[0]?.nodeId ?? null
  }
  if (number !== null) {
    const byNumber = scenes.filter((scene) => scene.ref === number)
    if (byNumber.length === 1) return byNumber[0]?.nodeId ?? null
  }
  return null
}
