import { z } from 'zod'
import { straightenQuotes } from '../critique'
import type { Paragraph } from '../mentions'
import { findInRun, ReplaceSample, ReplaceWrittenDocument, type PositionEdit } from '../replace'
import { buildSnippet } from '../search'
import { SNAPSHOT_NAME_MAX } from '../snapshots'
import { dismissedKey } from './dismissed'
import { mentionPhrase, scanNames, type NameIndex, type NameScanContext } from './nameScan'
import { normName } from './names'
import { RecordName, StoryRecord, type CaseRule } from './records'

/**
 * Rename in book (F-16.13, story memory v2): one of a record's names (its own or a nickname) is
 * renamed where the book reads it as that record. The places are the name scan's (identity rules
 * 1–4, `scanNames`): a span that names the record for certain by exactly that name. So a longer
 * name holding it ("Mara Vell" for "Mara"), another record's name, a span that may be someone
 * else, a sentence start the scan does not count, and a phrase the author marked *Not a mention*
 * all stay as they are, and the preview says how many of each. The preview counts the places per
 * scene of the active draft (with samples) and in the inactive drafts; the apply takes an
 * automatic snapshot and rewrites the other scenes, the inactive drafts when the author ticks
 * them, the name itself and the Not a mention keys whose phrases the rewrite changed, in one main
 * transaction, and leaves the open scene to the editor (so its caret and history hold). Notes,
 * Research and sheets are not rewritten (decision P1-D10; Replace in project covers them).
 */

export const RenameRequest = z.object({
  recordId: z.string(),
  /** The name being renamed: the record's own or one of its nicknames. */
  aliasId: z.string(),
  to: RecordName
})
export type RenameRequest = z.infer<typeof RenameRequest>

/** How many samples a scene of the preview shows. */
export const RENAME_SAMPLES = 2

/** One scene of the active draft the rename rewrites, with how many places and the first few. */
export const RenameScene = z.object({
  nodeId: z.string(),
  title: z.string(),
  count: z.number().int().positive(),
  samples: z.array(ReplaceSample).max(RENAME_SAMPLES)
})
export type RenameScene = z.infer<typeof RenameScene>

/** The places of the active draft that write the name but stay, by why. */
export const RenameKept = z.object({
  /** Places the author marked *Not a mention* of this record. */
  notMention: z.number().int().nonnegative(),
  /** Places that may be this record or another (rule 4, or a dropped sentence opener). */
  unsure: z.number().int().nonnegative(),
  /**
   * Other places that write the name's words: inside a longer name, another record's, or a
   * sentence start the scan does not count as a name.
   */
  other: z.number().int().nonnegative()
})
export type RenameKept = z.infer<typeof RenameKept>

export const RenamePreview = z.object({
  from: z.string(),
  to: z.string(),
  /** The active draft's scenes the rename rewrites, in reading order. */
  scenes: z.array(RenameScene),
  /** Every place rewritten in the active draft. */
  total: z.number().int().nonnegative(),
  kept: RenameKept,
  /** Places in the inactive drafts' own texts, and how many of their scene texts hold one. */
  otherDrafts: z.object({
    matches: z.number().int().nonnegative(),
    scenes: z.number().int().nonnegative()
  })
})
export type RenamePreview = z.infer<typeof RenamePreview>

export const RenameApplyRequest = RenameRequest.extend({
  /**
   * The scene open in the editor, if any: main leaves its live text alone and answers the edits
   * the renderer applies through the editor. Its inactive drafts' texts are main's like any other.
   */
  openId: z.string().nullable(),
  /**
   * Whether the inactive drafts are rewritten too (off unless the author ticks it: no snapshot
   * holds their texts, so only this session's Undo can put them back).
   */
  otherDrafts: z.boolean()
})
export type RenameApplyRequest = z.infer<typeof RenameApplyRequest>

/** One place rewritten: a ProseMirror range of the stored scene, its words, and the new ones. */
export const RenameEdit = z.object({
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  text: z.string(),
  replacement: z.string()
})
export type RenameEdit = z.infer<typeof RenameEdit>

export const RenameApplyResult = z.object({
  record: StoryRecord,
  /** The active draft's documents main rewrote, each with its new word count and place count. */
  written: z.array(ReplaceWrittenDocument.extend({ count: z.number().int().positive() })),
  /** Places replaced in the inactive drafts (0 unless they were ticked). */
  drafts: z.number().int().nonnegative(),
  /**
   * The open scene main left for the editor to rewrite; null when none was open, it is not a
   * manuscript scene, or the rename has no place in it (then main had nothing to leave).
   */
  openId: z.string().nullable(),
  /** The places of the open scene, in its stored (just flushed) text: what the editor rewrites. */
  openEdits: z.array(RenameEdit)
})
export type RenameApplyResult = z.infer<typeof RenameApplyResult>

export const RenameUndoResult = z.object({
  /** The record as the undo left it; null when it no longer exists. */
  record: StoryRecord.nullable(),
  /** The documents put back. */
  restored: z.array(ReplaceWrittenDocument),
  /** The documents left alone because they changed since the rename (or went), by title. */
  skipped: z.array(z.object({ id: z.string(), title: z.string() })),
  /** How many inactive-draft texts were put back, and how many had changed and were left. */
  drafts: z.object({
    restored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative()
  }),
  /** False when the name was changed again since (or another record took the old one). */
  nameRestored: z.boolean()
})
export type RenameUndoResult = z.infer<typeof RenameUndoResult>

/** The new name as it is stored and written: NFC, trimmed, inner spaces collapsed. */
export function cleanRenameText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ')
}

const LETTER = /\p{L}/u
const letters = (text: string): string => text.replace(/[^\p{L}]/gu, '')
const allCaps = (text: string): boolean =>
  text.length > 1 && text === text.toUpperCase() && text !== text.toLowerCase()

/** `text` with its first letter in upper or lower case. */
function withFirstLetter(text: string, upper: boolean): string {
  const at = text.search(LETTER)
  if (at < 0) return text
  const first = text.charAt(at)
  return `${text.slice(0, at)}${upper ? first.toUpperCase() : first.toLowerCase()}${text.slice(at + 1)}`
}

/**
 * The new name as one place writes it: as typed, except that the place's case is kept where it
 * differs from the name's. An all-caps place ("HESK!") gets the new name in capitals, and a place
 * whose first letter is in the other case ("The captain" at a sentence start, for the nickname
 * "the captain") gets the new name's first letter in that case. The open scene and the stored
 * ones use the same edits, so they stay identical.
 */
export function renameReplacement(matched: string, name: string, to: string): string {
  const place = letters(matched)
  const own = letters(name)
  if (allCaps(place) && !allCaps(own)) return to.toUpperCase()
  const placeFirst = place.charAt(0)
  const ownFirst = own.charAt(0)
  if (
    placeFirst !== '' &&
    placeFirst !== ownFirst &&
    placeFirst.toLowerCase() === ownFirst.toLowerCase()
  ) {
    return withFirstLetter(to, placeFirst !== placeFirst.toLowerCase())
  }
  return to
}

/** The name being renamed, as the plan reads it. */
export interface RenameTarget {
  recordId: string
  /** The name as stored. */
  text: string
  norm: string
  caseRule: CaseRule
}

/** What a rename does to one text: the places it rewrites, and the ones that stay, by why. */
export interface RenamePlan {
  /** Whether the text writes the name's words at all (any case); false skips the scans. */
  writes: boolean
  edits: RenameEdit[]
  kept: RenameKept
}

export const NO_RENAME_KEPT: RenameKept = { notMention: 0, unsure: 0, other: 0 }

const NO_NOT_MENTION: ReadonlySet<string> = new Set()

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Whether a text writes every word of the name, in any case: the quick test before a scan. */
function writesWords(paragraphs: readonly Paragraph[], norm: string): boolean {
  const words = norm.split(' ').filter((word) => word.length > 0)
  if (words.length === 0) return false
  const text = straightenQuotes(paragraphs.map((paragraph) => paragraph.text).join('\n'))
    .normalize('NFC')
    .toLowerCase()
  return words.every((word) =>
    new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, 'u').test(text)
  )
}

/**
 * The places of one text (a scene's paragraphs, `passageParagraphs`) a rename rewrites: every
 * certain mention of the record whose whole span is the name (`normName` equal), each with the
 * new name in the place's case (`renameReplacement`). Counts the places that stay: a span that may
 * be someone else (`unsure`), a span the author marked Not a mention of the record, and any other
 * whole-word use of the name (in its case, or any case for an `any` name). Pure and local.
 */
export function planRename(
  paragraphs: readonly Paragraph[],
  index: NameIndex,
  ctx: NameScanContext,
  target: RenameTarget,
  to: string
): RenamePlan {
  const kept = { ...NO_RENAME_KEPT }
  const edits: RenameEdit[] = []
  if (!writesWords(paragraphs, target.norm)) return { writes: false, edits, kept }
  const mine = (mention: { recordId: string; text: string }): boolean =>
    mention.recordId === target.recordId && normName(mention.text) === target.norm
  /** Every range already accounted for, so `other` counts the rest only. */
  const taken: [number, number][] = []
  const unsure = new Set<string>()
  for (const mention of scanNames(paragraphs, index, ctx)) {
    if (!mine(mention)) continue
    taken.push([mention.from, mention.to])
    if (mention.ambiguous) {
      unsure.add(mention.spanKey)
      continue
    }
    edits.push({
      from: mention.from,
      to: mention.to,
      text: mention.text,
      replacement: renameReplacement(mention.text, target.text, to)
    })
  }
  kept.unsure = unsure.size
  if (ctx.notMention.size > 0) {
    const struck = new Set<string>()
    for (const mention of scanNames(paragraphs, index, { ...ctx, notMention: NO_NOT_MENTION })) {
      if (!mine(mention) || struck.has(mention.spanKey)) continue
      const paragraph = paragraphs[mention.para]
      if (paragraph === undefined) continue
      const phrase = mentionPhrase(
        paragraph.text,
        mention.from - paragraph.from,
        mention.to - paragraph.from
      )
      const key = dismissedKey({ kind: 'notMention', recordId: target.recordId, phrase })
      if (!ctx.notMention.has(key)) continue
      struck.add(mention.spanKey)
      taken.push([mention.from, mention.to])
    }
    kept.notMention = struck.size
  }
  const anyCase = target.caseRule === 'any' || !/[\p{Lu}\p{Lt}]/u.test(target.text)
  const options = { query: target.text, matchCase: !anyCase, wholeWord: true }
  for (const paragraph of paragraphs) {
    for (const [start, end] of findInRun(paragraph.text, options)) {
      const from = paragraph.from + start
      const to = paragraph.from + end
      if (!taken.some(([a, b]) => from < b && a < to)) kept.other += 1
    }
  }
  return { writes: true, edits, kept }
}

/**
 * The first `max` places in context, as Replace in project shows them: the paragraph cut around
 * the place, and the same line with the new words.
 */
export function renameSamples(
  paragraphs: readonly Paragraph[],
  edits: readonly RenameEdit[],
  max: number = RENAME_SAMPLES
): ReplaceSample[] {
  const samples: ReplaceSample[] = []
  for (const edit of edits) {
    if (samples.length >= max) break
    const paragraph = paragraphs.find((each) => each.from <= edit.from && edit.to <= each.to)
    if (paragraph === undefined) continue
    const snippet = buildSnippet(paragraph.text, [
      [edit.from - paragraph.from, edit.to - paragraph.from]
    ])
    const range = snippet.highlights[0]
    if (range === undefined) continue
    const [from, to] = range
    samples.push({
      before: { text: snippet.text, range },
      after: {
        text: `${snippet.text.slice(0, from)}${edit.replacement}${snippet.text.slice(to)}`,
        range: [from, from + edit.replacement.length]
      }
    })
  }
  return samples
}

/** A Not a mention key one text uses, before and after the rename's edits (equal when unchanged). */
export interface NotMentionMove {
  before: string
  after: string
  /** The phrase as the rewritten text writes it. */
  phrase: string
}

/** A paragraph's text with the edits inside it applied, and a map of its offsets. */
function editedParagraph(
  paragraph: Paragraph,
  edits: readonly PositionEdit[]
): { text: string; edits: { start: number; end: number; replacement: string }[] } {
  const local = edits
    .filter((edit) => paragraph.from <= edit.from && edit.to <= paragraph.to)
    .map((edit) => ({
      start: edit.from - paragraph.from,
      end: edit.to - paragraph.from,
      replacement: edit.replacement
    }))
    .sort((a, b) => a.start - b.start)
  let text = paragraph.text
  for (let i = local.length - 1; i >= 0; i--) {
    const edit = local[i]
    if (edit === undefined) continue
    text = `${text.slice(0, edit.start)}${edit.replacement}${text.slice(edit.end)}`
  }
  return { text, edits: local }
}

/** Where an offset of the paragraph lands once `edits` are applied (inside an edit: its start). */
function mapOffset(
  offset: number,
  edits: readonly { start: number; end: number; replacement: string }[]
): number {
  let shift = 0
  for (const edit of edits) {
    if (edit.end <= offset) shift += edit.replacement.length - (edit.end - edit.start)
    else if (edit.start < offset) return edit.start + shift
  }
  return offset + shift
}

/**
 * The Not a mention keys one text uses (any record's: every place the scan would read as a
 * mention but a Not a mention mark strikes), each before and after `edits` (the applied rename).
 * A key whose phrase holds a rewritten word moves with it, so the mark still holds in the
 * rewritten prose; one whose phrase the rename left alone answers itself.
 */
export function notMentionMoves(
  paragraphs: readonly Paragraph[],
  index: NameIndex,
  ctx: NameScanContext,
  edits: readonly PositionEdit[]
): NotMentionMove[] {
  if (ctx.notMention.size === 0) return []
  const moves: NotMentionMove[] = []
  const seen = new Set<string>()
  const edited = new Map<number, ReturnType<typeof editedParagraph>>()
  for (const mention of scanNames(paragraphs, index, { ...ctx, notMention: NO_NOT_MENTION })) {
    const paragraph = paragraphs[mention.para]
    if (paragraph === undefined) continue
    const start = mention.from - paragraph.from
    const end = mention.to - paragraph.from
    const before = dismissedKey({
      kind: 'notMention',
      recordId: mention.recordId,
      phrase: mentionPhrase(paragraph.text, start, end)
    })
    const seenKey = `${before}@${mention.from}`
    if (!ctx.notMention.has(before) || seen.has(seenKey)) continue
    seen.add(seenKey)
    let after = edited.get(mention.para)
    if (after === undefined) {
      after = editedParagraph(paragraph, edits)
      edited.set(mention.para, after)
    }
    const same = after.edits.find((edit) => edit.start === start && edit.end === end)
    const newStart = mapOffset(start, after.edits)
    const newEnd =
      same === undefined ? mapOffset(end, after.edits) : newStart + same.replacement.length
    const phrase = mentionPhrase(after.text, newStart, newEnd)
    moves.push({
      before,
      after: dismissedKey({ kind: 'notMention', recordId: mention.recordId, phrase }),
      phrase
    })
  }
  return moves
}

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString()} ${noun}${count === 1 ? '' : 'es'}`

const scenesWord = (count: number): string =>
  `${count.toLocaleString()} scene${count === 1 ? '' : 's'}`

/** "12 matches in 7 scenes (+3 in other drafts)": the preview's one line. */
export function describeRenamePreview(preview: RenamePreview): string {
  const main = `${plural(preview.total, 'match')} in ${scenesWord(preview.scenes.length)}`
  const extra = preview.otherDrafts.matches
  return extra === 0 ? main : `${main} (+${extra.toLocaleString()} in other drafts)`
}

/**
 * The places that stay, in one line ("Left as they are: 1 marked Not a mention · 2 that may be
 * someone else · 3 other uses of “Mara” (a longer name, another record's, or a sentence start)");
 * null when none stays.
 */
export function describeRenameKept(preview: RenamePreview): string | null {
  const { notMention, unsure, other } = preview.kept
  const parts: string[] = []
  if (notMention > 0) parts.push(`${notMention.toLocaleString()} marked Not a mention`)
  if (unsure > 0) parts.push(`${unsure.toLocaleString()} that may be someone else`)
  if (other > 0) {
    parts.push(
      `${other.toLocaleString()} other use${other === 1 ? '' : 's'} of “${preview.from}” (a longer name, another record's, or a sentence start)`
    )
  }
  return parts.length === 0 ? null : `Left as they are: ${parts.join(' · ')}.`
}

/** The automatic snapshot's name: `Before renaming "Hesk" to "Haskel"`, within the name cap. */
export function renameSnapshotName(from: string, to: string): string {
  const full = `Before renaming "${from}" to "${to}"`
  if (full.length <= SNAPSHOT_NAME_MAX) return full
  return `${full.slice(0, SNAPSHOT_NAME_MAX - 1)}…`
}
