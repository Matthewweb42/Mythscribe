import { z } from 'zod'
import { SheetPatch, TagPatch } from './organise'

/**
 * The Changes log (F-9.13, decision D12): every change the background reading of the manuscript
 * applied on its own (an AI fact, a sheet it made, a tag it made, a tag it put on a scene), with
 * the scene and the passage behind it and one Undo each. A run is one reading of one scene; "Undo
 * this run" takes back all of it. Summaries are never logged (noise), and a fact that left with
 * its quote (the author changed the text) is not either: there is nothing to take back.
 */

/**
 * F-9.15: the log also holds what Organise, the context library's Apply, and the chat agent changed
 * in the story bible: a sheet's text (`sheetEdit`), a tag (`tagEdit`), and the changes they make that
 * cannot be taken back here (`merge`, `delete`, `category`), listed so the log is whole.
 */
export const CHANGE_KINDS = [
  'fact',
  'record',
  'tag',
  'tagLink',
  'sheetEdit',
  'tagEdit',
  'merge',
  'delete',
  'category'
] as const
export const ChangeKind = z.enum(CHANGE_KINDS)
export type ChangeKind = z.infer<typeof ChangeKind>

export const CHANGE_STATUSES = ['applied', 'undone'] as const
export const ChangeStatus = z.enum(CHANGE_STATUSES)
export type ChangeStatus = z.infer<typeof ChangeStatus>

/**
 * F-9.15: who made a run. `reading` is the background reading of a scene (main logs it); the
 * others write their runs through `changes:record` (Organise, the chat) or in main (`library`).
 * The source is the prefix of the run id (`organise:<key>`), so the stored log needs no new
 * column; a run id without a known prefix is a reading's.
 */
export const CHANGE_SOURCES = ['reading', 'organise', 'library', 'chat'] as const
export const ChangeSource = z.enum(CHANGE_SOURCES)
export type ChangeSource = z.infer<typeof ChangeSource>

/** The sources whose runs the renderer records (`changes:record`). */
export const RecordedChangeSource = z.enum(['organise', 'chat'])
export type RecordedChangeSource = z.infer<typeof RecordedChangeSource>

/** A run id for a source: `organise:<key>`. */
export function changeRunId(source: Exclude<ChangeSource, 'reading'>, key: string): string {
  return `${source}:${key}`
}

/** The source a run id names (its prefix); a reading's ids are plain UUIDs. */
export function changeSourceOf(runId: string): ChangeSource {
  const prefix = runId.slice(0, Math.max(0, runId.indexOf(':')))
  const parsed = ChangeSource.safeParse(prefix)
  return parsed.success ? parsed.data : 'reading'
}

export const CHANGE_SOURCE_LABEL: Readonly<Record<ChangeSource, string>> = {
  reading: 'Reading',
  organise: 'Organise',
  library: 'Library upload',
  chat: 'Chat'
}

/** The log keeps this many rows; older ones are pruned when a run is logged. */
export const CHANGES_MAX = 5000
/** Rows per `changes:list` page. */
export const CHANGES_PAGE = 100
export const CHANGES_PAGE_MAX = 500

/**
 * How main takes a change back, stored with the row (`knowledge_change.undo`), always through an
 * existing tombstone so the next reading does not redo it: a fact is hidden, a sheet deleted (its
 * name is remembered), a tag deleted (its name is remembered), a scene's tag removed (the pair is
 * remembered).
 */
export const ChangeUndo = z.discriminatedUnion('type', [
  z.object({ type: z.literal('hideFact'), factId: z.string() }),
  z.object({ type: z.literal('deleteRecord'), entityId: z.string() }),
  z.object({ type: z.literal('deleteTag'), tagId: z.string() }),
  z.object({ type: z.literal('unlinkTag'), nodeId: z.string(), tagId: z.string() }),
  /**
   * F-9.15: a sheet's parts put back as they were (`before`), only while they still read as the
   * change left them (`after`); otherwise the author has edited them since and the undo refuses.
   */
  z.object({
    type: z.literal('restoreSheet'),
    entityId: z.string(),
    before: SheetPatch,
    after: SheetPatch
  }),
  /** F-9.15: a tag's parts put back, under the same rule as `restoreSheet`. */
  z.object({ type: z.literal('restoreTag'), tagId: z.string(), before: TagPatch, after: TagPatch }),
  /**
   * F-9.15: a sheet made by Organise or an upload deleted, with the tag it made (`tagId`), if any;
   * refused once the sheet's `modified` stamp moved (the author has written in it since).
   */
  z.object({
    type: z.literal('deleteSheet'),
    entityId: z.string(),
    tagId: z.string().nullable(),
    modified: z.string().optional()
  }),
  /** F-9.15: a tag the chat took off a scene put back on it. */
  z.object({ type: z.literal('linkTag'), nodeId: z.string(), tagId: z.string() }),
  /** F-9.15: a change that cannot be taken back here (a merge, a deletion); the undo refuses with `reason`. */
  z.object({ type: z.literal('none'), reason: z.string().min(1).max(300) })
])
export type ChangeUndo = z.infer<typeof ChangeUndo>

/** Which inverse each recorded kind may carry; `changes:record` refuses any other pairing. */
export const RECORDED_UNDO_OF: Readonly<Record<ChangeKind, readonly ChangeUndo['type'][]>> = {
  fact: [],
  record: ['deleteSheet'],
  tag: [],
  tagLink: ['unlinkTag', 'linkTag'],
  sheetEdit: ['restoreSheet'],
  tagEdit: ['restoreTag'],
  merge: ['none'],
  delete: ['none'],
  category: ['none']
}

export const CHANGE_LABEL_MAX = 300

/** A log line cut to fit `CHANGE_LABEL_MAX`. */
export function changeLabel(text: string): string {
  return text.length <= CHANGE_LABEL_MAX ? text : `${text.slice(0, CHANGE_LABEL_MAX - 1)}…`
}

/**
 * F-9.15: why the log cannot take a change back. Merges and deletions keep Organise's rule
 * (`canUndo`): they always ask first, and nothing undoes them.
 */
export const NO_UNDO_REASON = {
  merge: 'A merge cannot be undone. Split the sheets or tags by hand if you need them apart again.',
  delete: 'A deletion cannot be undone.',
  category:
    'A new category cannot be undone here. Once it is empty it waits under Show unused sections.'
} as const satisfies Readonly<Record<'merge' | 'delete' | 'category', string>>

/** One change as the renderer hands it to `changes:record`; main derives the ids it is about from `undo`. */
export const RecordedChange = z.object({
  kind: ChangeKind,
  label: z.string().min(1).max(CHANGE_LABEL_MAX),
  undo: ChangeUndo,
  /** What a `none` change is about (the kept tag or sheet of a merge, the deleted one's id). */
  targetId: z.string().min(1).max(200).optional()
})
export type RecordedChange = z.infer<typeof RecordedChange>

export const RecordChangesInput = z.object({
  source: RecordedChangeSource,
  /** The run's key (an Organise plan, a chat turn); the run id is `source:key`. */
  run: z.string().min(1).max(100),
  changes: z.array(RecordedChange).min(1).max(100)
})
export type RecordChangesInput = z.infer<typeof RecordChangesInput>

/** One row of the log as the Changes section lists it. */
export const ChangeEntry = z.object({
  id: z.string(),
  runId: z.string(),
  createdAt: z.string(),
  /** The scene the change was read from; null once that scene is deleted. */
  nodeId: z.string().nullable(),
  /** The words of the scene behind it, when there are any (a fact). */
  quote: z.string().nullable(),
  kind: ChangeKind,
  /** The record it is about; null once that record is deleted. */
  entityId: z.string().nullable(),
  /** One line: "Kael · Personality: Watchful", "New sheet: Kael", "#stormbound on the scene". */
  label: z.string(),
  status: ChangeStatus,
  /** F-9.15: who made the run (from the run id). */
  source: ChangeSource,
  /** F-9.15: false for a change the log lists but cannot take back (a merge, a deletion). */
  undoable: z.boolean()
})
export type ChangeEntry = z.infer<typeof ChangeEntry>

export const ChangePage = z.object({
  entries: z.array(ChangeEntry),
  /** Whether older rows exist past this page. */
  more: z.boolean()
})
export type ChangePage = z.infer<typeof ChangePage>

/** What an undo did, so the windows can drop what went and refetch what moved. */
export const ChangeUndoResult = z.object({
  /** The rows now marked undone (one for `changes:undo`, the run's for `changes:undoRun`). */
  entries: z.array(ChangeEntry),
  removedEntityIds: z.array(z.string()),
  removedTagIds: z.array(z.string()),
  /** Records whose facts moved (a fact was hidden). */
  entityIds: z.array(z.string()),
  /** Scenes whose tag links moved. */
  nodeIds: z.array(z.string())
})
export type ChangeUndoResult = z.infer<typeof ChangeUndoResult>

export const CHANGE_KIND_LABEL: Readonly<Record<ChangeKind, string>> = {
  fact: 'Fact',
  record: 'New sheet',
  tag: 'New tag',
  tagLink: 'Tag on a scene',
  sheetEdit: 'Sheet',
  tagEdit: 'Tag',
  merge: 'Merge',
  delete: 'Deleted',
  category: 'New category'
}
