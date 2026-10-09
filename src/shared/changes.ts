import { z } from 'zod'

/**
 * The Changes log (F-9.13, decision D12): every change the background reading of the manuscript
 * applied on its own (an AI fact, a sheet it made, a tag it made, a tag it put on a scene), with
 * the scene and the passage behind it and one Undo each. A run is one reading of one scene; "Undo
 * this run" takes back all of it. Summaries are never logged (noise), and a fact that left with
 * its quote (the author changed the text) is not either: there is nothing to take back.
 */

export const CHANGE_KINDS = ['fact', 'record', 'tag', 'tagLink'] as const
export const ChangeKind = z.enum(CHANGE_KINDS)
export type ChangeKind = z.infer<typeof ChangeKind>

export const CHANGE_STATUSES = ['applied', 'undone'] as const
export const ChangeStatus = z.enum(CHANGE_STATUSES)
export type ChangeStatus = z.infer<typeof ChangeStatus>

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
  z.object({ type: z.literal('unlinkTag'), nodeId: z.string(), tagId: z.string() })
])
export type ChangeUndo = z.infer<typeof ChangeUndo>

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
  status: ChangeStatus
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
  tagLink: 'Tag on a scene'
}
