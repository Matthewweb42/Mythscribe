import { z } from 'zod'
import type { StoryMemoryVersion } from './storyMemory'

/**
 * Archived features (notes redesign, `docs/research/notes-redesign-2026-10-15/plan.md`, the
 * author 2026-10-15): features hidden everywhere in the interface while their code stays, so they
 * may come back. Settings › Archived features switches one back on. Every one starts archived.
 */
export const ARCHIVABLE_FEATURES = [
  'writingPresets',
  'quickActions',
  'voiceProfile',
  'authorRules',
  'bannedPhrases',
  'editorsNotes',
  'proofread',
  'storyBible'
] as const
export const ArchivableFeature = z.enum(ARCHIVABLE_FEATURES)
export type ArchivableFeature = z.infer<typeof ArchivableFeature>

export const ARCHIVABLE_FEATURE_LABEL: Record<ArchivableFeature, string> = {
  writingPresets: 'Writing presets',
  quickActions: 'Quick actions',
  voiceProfile: 'Voice profile',
  authorRules: 'Author rules',
  bannedPhrases: 'Banned phrases',
  editorsNotes: "Editor's notes",
  proofread: 'Proofread',
  storyBible: 'Old story bible'
}

/**
 * Whether `feature` is archived, given the features the author switched back on (`unarchived`,
 * from the project's editor settings; absent on a row stored before the setting: all archived).
 */
export function isArchived(
  feature: ArchivableFeature,
  unarchived: readonly ArchivableFeature[] | undefined
): boolean {
  return !(unarchived ?? []).includes(feature)
}

/**
 * The old story bible (notes redesign, fresh start, the author 2026-10-15: "I kinda wanna restart
 * it all"): its sheets, categories, tags and Index, threads, the Library, To do, Changes, Organise,
 * the tags column and the quick reference. Archived, it is hidden and nothing reads or writes it;
 * its rows stay in the project file. It is story memory v1's: a v2 project (dormant, development
 * builds only) has its own records and is never affected (decided by Claude, unconfirmed).
 */
export function isStoryBibleArchived(
  unarchived: readonly ArchivableFeature[] | undefined,
  memory: StoryMemoryVersion
): boolean {
  return memory === 'v1' && isArchived('storyBible', unarchived)
}

/** The switched-back-on list after turning `feature` archived (`archived` true) or back on. */
export function withArchived(
  unarchived: readonly ArchivableFeature[] | undefined,
  feature: ArchivableFeature,
  archived: boolean
): ArchivableFeature[] {
  const on = new Set(unarchived ?? [])
  if (archived) on.delete(feature)
  else on.add(feature)
  return ARCHIVABLE_FEATURES.filter((id) => on.has(id))
}
