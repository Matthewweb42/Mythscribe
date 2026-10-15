import { z } from 'zod'

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
  'proofread'
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
  proofread: 'Proofread'
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
