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

/** One name's patterns: anywhere as written (or in any case), and a sentence opener's flip. */
interface CompiledName {
  pattern: RegExp
  opening: RegExp | null
}

/** Names compiled once per names list (a record's list is one object for a whole recompute). */
const compiledNames = new WeakMap<readonly NoteName[], CompiledName[]>()

function compileNames(names: readonly NoteName[]): CompiledName[] {
  const known = compiledNames.get(names)
  if (known !== undefined) return known
  const compiled = names
    .filter((name) => !name.shared && name.text.trim() !== '')
    .sort((a, b) => b.text.length - a.text.length)
    .map((name) => {
      const anyCase = name.caseRule === 'any' || !/[\p{Lu}\p{Lt}]/u.test(name.text)
      const written = straight(name.text)
      // A sentence's first word may differ in its first letter only ("The Captain" for "the Captain").
      const first = written.slice(0, 1)
      const flipped =
        first === first.toLowerCase()
          ? first.toUpperCase() + written.slice(1)
          : first.toLowerCase() + written.slice(1)
      return {
        pattern: new RegExp(
          `(?<![\\p{L}\\p{N}])${escapeRegExp(written)}(?:'s|')?(?![\\p{L}\\p{N}])`,
          anyCase ? 'giu' : 'gu'
        ),
        opening: anyCase
          ? null
          : new RegExp(`^\\s*(${escapeRegExp(flipped)}(?:'s|')?)(?![\\p{L}\\p{N}])`, 'u')
      }
    })
  compiledNames.set(names, compiled)
  return compiled
}

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
  for (const { pattern, opening } of compileNames(names)) {
    const found = [...plain.matchAll(pattern)].map((match) => ({
      start: match.index,
      end: match.index + match[0].length
    }))
    const opener = opening?.exec(plain) ?? null
    if (opener !== null) {
      const words = opener[1] ?? ''
      found.push({ start: opener[0].length - words.length, end: opener[0].length })
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

const labelsBySlot = new Map<Slot, string[]>()

/** Every label a `Label: value` line about `slot` may carry, folded. */
export function slotLabels(slot: Slot): string[] {
  const known = labelsBySlot.get(slot)
  if (known !== undefined) return known
  const cues = SLOT_QUESTION_CUES.find((row) => row.slot === slot)?.cues ?? []
  const labels = [...new Set([slotLabel(slot), ...cues, ...(EXTRA_LABELS[slot] ?? [])].map(fold))]
  labelsBySlot.set(slot, labels)
  return labels
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

/** Whether a note sentence sits on the record's own Pinned page. */
export const onOwnPage = (sentence: NoteSentence, record: NoteRecord): boolean =>
  sentence.note.ownerKind === 'record' &&
  sentence.note.ownerId === record.id &&
  sentence.note.page === 'pinned'

/**
 * Whether a note sentence holds a cue for a slot: a cue word (`holdsSlotCue`), or a `Label: value`
 * line whose label is the slot's. Kinship's cue is a kin word.
 */
export function holdsSlot(sentence: NoteSentence, slot: Slot): boolean {
  const line = labelLine(sentence.text)
  if (line !== null && slotLabels(slot).includes(line.label)) return true
  if (slot === 'kinship') return kinWords(sentence.text).length > 0
  return holdsSlotCue(sentence.text, slot)
}

/**
 * Whether a note sentence speaks of a record's slot (P4-D8): it names the record, or sits on the
 * record's own Pinned page; and it holds a cue for the slot (`holdsSlot`).
 */
export function pairsWith(sentence: NoteSentence, record: NoteRecord, slot: Slot): boolean {
  if (!onOwnPage(sentence, record) && !namesRecord(sentence.text, record.names)) return false
  return holdsSlot(sentence, slot)
}

/**
 * The canon notes indexed once for a set of records (C6 runs after every change, over notes that
 * may hold a long Research upload): a paragraph is split into sentences only when it sits on one of
 * their Pinned pages or folds to text holding one of their names; then each record's sentences
 * (its own page's, and those naming it, `nameSpans`) are found once, in note order.
 */
export function noteIndex(
  notes: readonly NoteParagraph[],
  records: readonly NoteRecord[]
): (record: NoteRecord) => NoteSentence[] {
  const keysOf = (record: NoteRecord): string[] =>
    record.names
      .filter((name) => !name.shared && name.text.trim() !== '')
      .map((name) => fold(name.text))
  const keys = [...new Set(records.flatMap(keysOf))].sort((a, b) => b.length - a.length)
  const owners = new Set(records.map((record) => record.id))
  // Any of the names in any case, curly or straight apostrophes, any run of spaces: a loose sieve
  // run once over each paragraph as written (`nameSpans` then decides, per sentence).
  const anyName =
    keys.length === 0
      ? null
      : new RegExp(
          keys
            .map((key) => escapeRegExp(key).replace(/'/g, "['‘’]").replace(/ /g, '\\s+'))
            .join('|'),
          'iu'
        )
  const sentences = notes
    .filter(
      (note) =>
        (note.ownerKind === 'record' && note.page === 'pinned' && owners.has(note.ownerId)) ||
        (anyName?.test(note.text) ?? false)
    )
    .flatMap(noteSentences)
  const folded = sentences.map((sentence) => fold(sentence.text))
  const found = new Map<string, NoteSentence[]>()
  return (record) => {
    const known = found.get(record.id)
    if (known !== undefined) return known
    const mine = keysOf(record)
    const naming = sentences.filter(
      (sentence, i) =>
        onOwnPage(sentence, record) ||
        (mine.some((key) => folded[i]?.includes(key) === true) &&
          namesRecord(sentence.text, record.names))
    )
    found.set(record.id, naming)
    return naming
  }
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

/** Whether "of", an optional article, then one of the object's names follow `at` directly ("sister of the Captain"). */
function objectFollowsOf(
  text: string,
  at: number,
  objects: readonly { start: number; end: number }[]
): boolean {
  const of = /^\s+of\s+/iu.exec(text.slice(at))
  if (of === null) return false
  const from = at + of[0].length
  const article = /^(?:the|a|an)\s+/iu.exec(text.slice(from))
  const named = article === null ? null : from + article[0].length
  return objects.some((span) => span.start === from || span.start === named)
}

/**
 * The kin word a note sentence gives for a record's kinship to `object` (P4-D8: the sentence must
 * name the object too): the kin word right after the object's possessive ("Anne is the Captain's
 * sister"), or one followed directly by "of" and the object ("Anne, sister of the Captain"; never
 * "cousin of Mary and sister of the Captain" for the cousin); a kin word
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
  if (!onOwnPage(sentence, record) && nameSpans(text, record.names).length === 0) return null
  for (const kin of kinWords(text)) {
    const before = text.slice(0, kin.start).trimEnd()
    const afterObject = objects.some(
      (span) => before.length === span.end && /'s?$/u.test(text.slice(span.start, span.end))
    )
    if (afterObject || objectFollowsOf(text, kin.end, objects)) return kin.word
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

/**
 * *Update my note*'s proposal for one sentence (F-16.29, P4-D18), in code: the note's value words
 * (`noteValue`, as code read them) replaced by the book's value, whole words, in any case ("Eyes:
 * green" → "Eyes: grey"; "Orrin's green eyes" → "Orrin's grey eyes"); for a `Label: value` line
 * whose value is not found as written, everything after the colon. Null when neither applies (the
 * proposal is not offered).
 */
export function patchNoteSentence(
  sentence: string,
  noteValue: string,
  bookValue: string
): string | null {
  const value = noteValue.trim()
  if (value !== '') {
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(value).replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`,
      'iu'
    )
    const found = pattern.exec(sentence)
    if (found !== null) {
      return (
        sentence.slice(0, found.index) + bookValue + sentence.slice(found.index + found[0].length)
      )
    }
  }
  if (labelLine(sentence) === null) return null
  const line = /^(\s*[^:\n]+?:\s*)(.+?)([.;]*\s*)$/u.exec(sentence)
  return line === null ? null : `${line[1] ?? ''}${bookValue}${line[3] ?? ''}`
}

/**
 * A note paragraph with its sentence `index` (`splitSentences`' numbering, as a finding's note side
 * keeps it) patched (`patchNoteSentence`); null when that sentence is gone or cannot be patched.
 */
export function patchNoteParagraph(
  paragraph: string,
  index: number,
  noteValue: string,
  bookValue: string
): { sentence: string; after: string } | null {
  const span = splitSentences(paragraph)[index]
  if (span === undefined) return null
  const sentence = paragraph.slice(span.start, span.end)
  const patched = patchNoteSentence(sentence, noteValue, bookValue)
  if (patched === null || patched === sentence) return null
  return {
    sentence,
    after: paragraph.slice(0, span.start) + patched + paragraph.slice(span.end)
  }
}
