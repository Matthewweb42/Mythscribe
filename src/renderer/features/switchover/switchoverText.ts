import { CLOUD_PROVIDER_LABEL, type CloudProvider } from '@shared/cloudSync'
import {
  SWITCHOVER_NOTHING_CHANGED,
  type RebuildEstimate,
  type SwitchoverCounts,
  type SwitchoverFailure,
  type SwitchoverStep
} from '@shared/memory/switchover'
import { formatCount, formatUsd } from '@renderer/features/ai/usageFormat'

/**
 * The switch-over's words (F-16.15, F-16.31 part A, plan `Switchover.md` §3): the intro's list of
 * what changes, the failure block's step labels, and the final screen's lines. One owner, so the
 * dialog and its tests read the same text.
 */

/** What changes, in plain words: the intro's one list (§3.2). */
export const WHAT_CHANGES: readonly string[] = [
  'Tags become names and labels. Every character, place and thing you tagged becomes a record with its nicknames; tone, content and your own tags become labels you filter by.',
  'Inline tags in your scenes become plain words. You choose the words on the next screens.',
  'Everything you wrote stays: scenes, notes, sheets (as Pinned lines), Plan and Idea sheets (in Ideas), uploads, story years and what you dismissed.',
  'Sheet text the AI wrote goes under “Filed by AI earlier: please check”, marked Not canon.',
  'What the AI made goes: summaries, AI facts and tags, Changes, To do and consistency findings. The AI reads your book again (Rebuild memory), and asks with its price first.',
  'Snapshots are not changed. A backup and a dated copy of the project are made first. It runs once; to go back, you restore the backup.'
]

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

/** The last path segment of a file or folder, for "pick <name>" in the way back. */
export function baseName(file: string): string {
  return file.split(/[\\/]/).filter((part) => part !== '').pop() ?? file
}

/** How to go back (decision SW-D11): restore the kept backup, or open the dated copy. */
export function goBackLine(backup: string): string {
  return `To go back: in Settings › Backups choose Restore and pick “${baseName(backup)}”. It opens as a new project beside this one, on the old story memory. You can also open the dated copy with File › Open project…. This project stays on the new story memory.`
}

/** The rebuild's line: what *Rebuild memory* will cost after the switch, and how long. */
export function rebuildLine(rebuild: RebuildEstimate): string {
  if (rebuild.scenes === 0) return 'Rebuild memory: nothing to read yet.'
  const scenes = formatCount(rebuild.scenes, 'scene')
  const time = `about ${formatCount(rebuild.minutes, 'minute')}`
  if (rebuild.source === 'local')
    return `Rebuild memory: ${scenes}, free on your local model, ${time}.`
  const cost = rebuild.priced
    ? `about ${formatUsd(rebuild.costUsd)}`
    : 'a cost not yet known (a model is not in the price table)'
  const where =
    rebuild.source === 'cloud' ? 'from your MythScribe Cloud balance' : 'on your own key'
  return `Rebuild memory: ${scenes}, ${cost} ${where}, ${time}. It asks before it starts.`
}
