import { z } from 'zod'
import { ReplaceWrittenDocument, type ReplaceOptions } from '../replace'
import { SNAPSHOT_NAME_MAX } from '../snapshots'
import { normName } from './names'
import { RecordName, StoryRecord, type CaseRule } from './records'

/**
 * Rename in book (F-16.13, story memory v2): one of a record's names (its own or a nickname) is
 * renamed everywhere the manuscript writes it. The preview counts the matches per scene of the
 * active draft and in the inactive drafts; the apply takes an automatic snapshot, rewrites the
 * other scenes, the inactive drafts, the name itself and the Dismissed keys that hold it in one
 * main transaction, and leaves the open scene to the editor (so its caret and history hold).
 * Notes, Research and sheets are not rewritten (decision P1-D10; Replace in project covers them).
 */

export const RenameRequest = z.object({
  recordId: z.string(),
  /** The name being renamed: the record's own or one of its nicknames. */
  aliasId: z.string(),
  to: RecordName
})
export type RenameRequest = z.infer<typeof RenameRequest>

/** One scene of the active draft that writes the name, with how often. */
export const RenameScene = z.object({
  nodeId: z.string(),
  title: z.string(),
  count: z.number().int().positive()
})
export type RenameScene = z.infer<typeof RenameScene>

export const RenamePreview = z.object({
  from: z.string(),
  to: z.string(),
  /** The active draft's scenes that write the name, in reading order. */
  scenes: z.array(RenameScene),
  /** Every match in the active draft. */
  total: z.number().int().nonnegative(),
  /** Matches in the inactive drafts' own texts, and how many of their scene texts hold one. */
  otherDrafts: z.object({
    matches: z.number().int().nonnegative(),
    scenes: z.number().int().nonnegative()
  })
})
export type RenamePreview = z.infer<typeof RenamePreview>

export const RenameApplyRequest = RenameRequest.extend({
  /**
   * The scene open in the editor, if any: main leaves its live text alone and the renderer applies
   * `match` to it through the editor. Its inactive drafts' texts are main's like any other.
   */
  openId: z.string().nullable()
})
export type RenameApplyRequest = z.infer<typeof RenameApplyRequest>

export const RenameMatch = z.object({
  query: z.string(),
  replacement: z.string(),
  matchCase: z.boolean(),
  wholeWord: z.boolean()
})

export const RenameApplyResult = z.object({
  record: StoryRecord,
  /** What the editor replaces in the open scene: exactly what main replaced elsewhere. */
  match: RenameMatch,
  /** The active draft's documents main rewrote, each with its new word count and match count. */
  written: z.array(ReplaceWrittenDocument.extend({ count: z.number().int().positive() })),
  /** Matches replaced in the inactive drafts. */
  drafts: z.number().int().nonnegative(),
  /**
   * The open scene main left for the editor to rewrite; null when none was open, it is not a
   * manuscript scene, or it does not write the name (then main had nothing to leave).
   */
  openId: z.string().nullable()
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

/**
 * How a name is matched in the prose when it is renamed: whole words only (a possessive counts,
 * since the apostrophe is no word character), in its exact case unless the author typed it to
 * match any case (`any`). The replacement is the new name as typed.
 */
export function renameMatch(
  from: { text: string; caseRule: CaseRule },
  to: string
): ReplaceOptions {
  return {
    query: from.text,
    replacement: cleanRenameText(to),
    matchCase: from.caseRule !== 'any',
    wholeWord: true
  }
}

/** The new name as it is stored and written: NFC, trimmed, inner spaces collapsed. */
export function cleanRenameText(text: string): string {
  return text.normalize('NFC').trim().replace(/\s+/g, ' ')
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

/** The automatic snapshot's name: `Before renaming "Hesk" to "Haskel"`, within the name cap. */
export function renameSnapshotName(from: string, to: string): string {
  const full = `Before renaming "${from}" to "${to}"`
  if (full.length <= SNAPSHOT_NAME_MAX) return full
  return `${full.slice(0, SNAPSHOT_NAME_MAX - 1)}…`
}

/** A word character of any script: what a whole word in a norm may not touch. */
const WORD = '[\\p{L}\\p{M}\\p{N}_]'

/**
 * A Not a mention key (`recordId|norm(phrase)`) with the renamed name's norm replaced as a whole
 * word, so the phrase still matches the rewritten prose; null when the phrase does not hold it.
 */
export function renamedPhraseKey(key: string, fromNorm: string, toNorm: string): string | null {
  const bar = key.indexOf('|')
  if (bar < 0 || fromNorm === '') return null
  const phrase = key.slice(bar + 1)
  const escaped = fromNorm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`(?<!${WORD})${escaped}(?!${WORD})`, 'gu')
  if (!pattern.test(phrase)) return null
  pattern.lastIndex = 0
  return `${key.slice(0, bar + 1)}${normName(phrase.replace(pattern, toNorm))}`
}
