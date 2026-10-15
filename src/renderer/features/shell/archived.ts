import { isArchived, withArchived, type ArchivableFeature } from '@shared/archivedFeatures'
import type { EditorSettings } from '@shared/editorSettings'
import { useEditorSettingsStore } from '@renderer/features/editor/settingsStore'

/**
 * Archived features in the renderer (notes redesign, 2026-10-15): read from the open project's
 * editor settings (`unarchived`), which load as the project opens, before any of these entry
 * points can be reached. Until they are loaded nothing is hidden (decided by Claude: a store or
 * view without a project's settings, as in the features' own tests, behaves as before).
 */
const archivedIn = (settings: EditorSettings | null, feature: ArchivableFeature): boolean =>
  settings !== null && isArchived(feature, settings.unarchived)

/** Whether `feature`'s entry points are hidden, re-rendered when Settings › Archived features changes. */
export function useIsArchived(feature: ArchivableFeature): boolean {
  return useEditorSettingsStore((s) => archivedIn(s.settings, feature))
}

/** The same, read once (stores and actions). */
export function archivedNow(feature: ArchivableFeature): boolean {
  return archivedIn(useEditorSettingsStore.getState().settings, feature)
}

/** Archives `feature` (`archived` true) or switches it back on, through the editor settings' save. */
export function setArchived(feature: ArchivableFeature, archived: boolean): void {
  const settings = useEditorSettingsStore.getState().settings
  if (settings === null) return
  useEditorSettingsStore
    .getState()
    .update({ unarchived: withArchived(settings.unarchived, feature, archived) })
}
