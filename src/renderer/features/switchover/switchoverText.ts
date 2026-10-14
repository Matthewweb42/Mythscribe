import { KEPT_BACKUP_LABEL, parseBackupFileName } from '@shared/backups'
import { CLOUD_PROVIDER_LABEL, type CloudProvider } from '@shared/cloudSync'
import {
  SWITCHOVER_NOTHING_CHANGED,
  type RebuildEstimate,
  type SwitchoverCounts,
  type SwitchoverFailure,
  type SwitchoverStep
} from '@shared/memory/switchover'
import { formatCount } from '@renderer/features/ai/usageFormat'
import { backupWhen } from '@renderer/features/backups/backupWhen'
import { aboutMinutes, rebuildCost } from '@renderer/features/memory/memoryView'

/**
 * The switch-over's words (F-16.15, F-16.31 part A, plan `Switchover.md` §3): the intro's list of
 * what changes, the failure block's step labels, and the final screen's lines. One owner, so the
 * dialog and its tests read the same text.
 */

/**
 * What changes, in plain words: the intro's one list (§3.2), as the dry run counts it (`model.ts`:
 * dismissals that still apply convert, old ones and sheets only the AI wrote are dropped). The
 * last line differs on a test copy, which gets no backup or dated copy of its own (SW-D4).
 */
export function whatChanges(onCopy: boolean): readonly string[] {
  return [
    'Tags become names and labels. Every character, place and thing you tagged becomes a record with its nicknames; tone, content and your own tags become labels you filter by.',
    'Inline tags in your scenes become plain words. You choose the words on the next screens.',
    'Everything you wrote stays: scenes, notes, sheets (as Pinned lines), Plan and Idea sheets (in Ideas), uploads, story years and what you dismissed that still applies.',
    'Sheet text the AI added to your sheets goes under “Filed by AI earlier: please check”, marked Not canon.',
    'What the AI made goes: summaries, AI facts and tags, sheets only the AI wrote, Changes, To do, consistency findings and old dismissals nothing reads any more. The AI reads your book again (Rebuild memory), and asks with its price first.',
    onCopy
      ? 'Snapshots are not changed. It runs once on this copy; the project it was made from stays as it is.'
      : 'Snapshots are not changed. A backup and a dated copy of the project are made first. It runs once; to go back, you restore the backup.'
  ]
}

/** The intro's recommendation of the copy, under the list. */
export const TRY_COPY_FIRST =
  'Try it on a copy first (recommended): a test copy is made beside this project and switched; this project stays as it is.'

/** The intro on a test copy that is already open. */
export const THIS_IS_A_COPY =
  'This is a test copy. Switching it leaves the project it was made from as it is.'

/** The cloud folder's name for the author ("Google Drive"), or null for a plain folder. */
export function cloudLabel(cloud: CloudProvider | null): string | null {
  return cloud === null ? null : CLOUD_PROVIDER_LABEL[cloud]
}

/** The safety step's progress line: where the copies are being made. */
export function safetyProgress(cloud: CloudProvider | null): string {
  const label = cloudLabel(cloud)
  return label === null
    ? 'Making a backup and a dated copy beside the project…'
    : `Making a backup and a dated copy in ${label}…`
}

/** The failure block's "What failed" label for a step (§3.5). */
export function stepLabel(step: SwitchoverStep, cloud: CloudProvider | null): string {
  switch (step) {
    case 'flush':
      return `Copying to ${cloudLabel(cloud) ?? 'the cloud folder'}`
    case 'backup':
      return 'The backup'
    case 'datedCopy':
      return 'The dated copy'
    case 'project':
      return 'The project'
    case 'convert':
      return 'The conversion'
  }
}

/**
 * A failure's message without the "Nothing was changed" sentence it ends with, which the block
 * shows on its own line; a message that says it differently (the project was already switched) is
 * kept whole and `nothingChanged` is null.
 */
export function failureLines(failure: SwitchoverFailure): {
  message: string
  nothingChanged: string | null
} {
  const { message } = failure
  if (!message.endsWith(SWITCHOVER_NOTHING_CHANGED)) return { message, nothingChanged: null }
  return {
    message: message.slice(0, -SWITCHOVER_NOTHING_CHANGED.length).trim(),
    nothingChanged: SWITCHOVER_NOTHING_CHANGED
  }
}

/** The counts the conversion wrote, as the final screen says them. */
export function countsLine(counts: SwitchoverCounts): string {
  return [
    formatCount(counts.records, 'record'),
    formatCount(counts.labels, 'label'),
    formatCount(counts.research, 'Research document'),
    `${formatCount(counts.tokens, 'inline tag')} as words`
  ].join(', ')
}

/** The last path segment of a file or folder. */
export function baseName(file: string): string {
  return (
    file
      .split(/[\\/]/)
      .filter((part) => part !== '')
      .pop() ?? file
  )
}

/**
 * How to go back (decision SW-D11): restore the kept backup, named the way Settings › Backups
 * lists it (its date, marked kept; the list shows no file names), or open the dated copy.
 */
export function goBackLine(backup: string): string {
  const made = parseBackupFileName(baseName(backup))
  const which =
    made === null
      ? `the backup marked (kept: ${KEPT_BACKUP_LABEL})`
      : `the backup from ${backupWhen(made.toISOString())} marked (kept: ${KEPT_BACKUP_LABEL})`
  return `To go back: in Settings › Backups choose Restore on ${which}. It opens as a new project beside this one, on the old story memory. You can also open the dated copy with File › Open project…. This project stays on the new story memory.`
}

/**
 * The dry run's rebuild line: what *Rebuild memory* will cost after the switch, and how long, in
 * the words the final screen and the rebuild dialog use (`rebuildCost`, in cents).
 */
export function rebuildLine(rebuild: RebuildEstimate): string {
  if (rebuild.scenes === 0) return 'Rebuild memory: nothing to read yet.'
  const line = `Rebuild memory: ${formatCount(rebuild.scenes, 'scene')}, ${rebuildCost(rebuild)}, ${aboutMinutes(rebuild.minutes)}.`
  return rebuild.source === 'local' ? line : `${line} It asks before it starts.`
}
