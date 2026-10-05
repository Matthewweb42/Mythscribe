import { z } from 'zod'
import { DraftChange, DraftDocDiff } from './drafts'

/**
 * Snapshots (F-8.6): frozen copies of document text at one moment, of one document or of the
 * project (every document in front matter, the manuscript, and end matter). Text only, like
 * drafts: the tree, titles, notes, metadata, and tags are not captured (backups, F-8.4, cover
 * the whole project). The text taken is the live text, i.e. the active draft's.
 *
 * Kinds: `manual` (the author took it), `milestone` (the author flagged it; never pruned), and
 * `auto` (a restore takes one of the documents it is about to overwrite, just before; only the
 * newest `SNAPSHOT_AUTO_KEEP` are kept).
 */

export const SNAPSHOT_NAME_MAX = 80
export const SNAPSHOT_NOTE_MAX = 2000
/** How many automatic (before-restore) snapshots are kept; older ones are pruned. */
export const SNAPSHOT_AUTO_KEEP = 20

export const SNAPSHOT_KINDS = ['manual', 'milestone', 'auto'] as const
export type SnapshotKind = (typeof SNAPSHOT_KINDS)[number]

/** `document`: one document (`nodeId`); `project`: several documents (every one, or a restore's). */
export const SNAPSHOT_SCOPES = ['document', 'project'] as const
export type SnapshotScope = (typeof SNAPSHOT_SCOPES)[number]

export const SnapshotName = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().min(1).max(SNAPSHOT_NAME_MAX))

export const SnapshotNote = z
  .string()
  .transform((s) => s.trim())
  .pipe(z.string().max(SNAPSHOT_NOTE_MAX))

export const SnapshotInfo = z.object({
  id: z.string(),
  name: z.string(),
  note: z.string(),
  kind: z.enum(SNAPSHOT_KINDS),
  scope: z.enum(SNAPSHOT_SCOPES),
  /** The document of a `document` snapshot; null for `project`. */
  nodeId: z.string().nullable(),
  /** That document's current title; null for `project`. */
  nodeTitle: z.string().nullable(),
  /** The draft that was active when it was taken; null when the project had no drafts yet. */
  draftName: z.string().nullable(),
  /** Documents it still holds (a document deleted since drops out). */
  docCount: z.number().int().nonnegative(),
  wordCount: z.number().int().nonnegative(),
  created: z.string()
})
export type SnapshotInfo = z.infer<typeof SnapshotInfo>

/** Every snapshot of the open project, newest first. */
export const SnapshotList = z.array(SnapshotInfo)
export type SnapshotList = z.infer<typeof SnapshotList>

export const TakeSnapshot = z.discriminatedUnion('scope', [
  z.object({
    scope: z.literal('document'),
    nodeId: z.string(),
    name: SnapshotName,
    note: SnapshotNote,
    milestone: z.boolean()
  }),
  z.object({
    scope: z.literal('project'),
    name: SnapshotName,
    note: SnapshotNote,
    milestone: z.boolean()
  })
])
export type TakeSnapshot = z.infer<typeof TakeSnapshot>

/**
 * Any field left out is unchanged. `milestone: true` flags it; `false` takes a milestone back to
 * `manual` (an `auto` stays `auto`).
 */
export const UpdateSnapshot = z.object({
  id: z.string(),
  name: SnapshotName.optional(),
  note: SnapshotNote.optional(),
  milestone: z.boolean().optional()
})
export type UpdateSnapshot = z.infer<typeof UpdateSnapshot>

/**
 * From the snapshot (`del` only in it) to `againstId`'s text, or to the current text when
 * `againstId` is null (`add` only there). Documents in either snapshot take part, in tree order;
 * a side with no copy of a document reads its current text. Unchanged documents are left out.
 */
export const SnapshotComparison = z.object({
  snapshotId: z.string(),
  againstId: z.string().nullable(),
  docs: z.array(DraftDocDiff),
  unchanged: z.number().int().nonnegative()
})
export type SnapshotComparison = z.infer<typeof SnapshotComparison>

/** After a restore: the list (with the new automatic snapshot, if any) and what was rewritten. */
export const SnapshotRestore = z.object({
  snapshots: SnapshotList,
  changed: DraftChange.shape.changed
})
export type SnapshotRestore = z.infer<typeof SnapshotRestore>

const pad = (n: number): string => String(n).padStart(2, '0')

/** "Snapshot 2026-10-05 14:30" in local time: the name field's default. */
export function defaultSnapshotName(date: Date): string {
  return `Snapshot ${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** The automatic snapshot's name before restoring `name` (kept within `SNAPSHOT_NAME_MAX`). */
export function autoSnapshotName(name: string): string {
  const prefix = 'Before restoring "'
  const room = SNAPSHOT_NAME_MAX - prefix.length - 1
  const shown = name.length > room ? `${name.slice(0, room - 1)}…` : name
  return `${prefix}${shown}"`
}
