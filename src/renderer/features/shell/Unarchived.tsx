import type { ArchivableFeature } from '@shared/archivedFeatures'
import { useIsArchived } from './archived'

/**
 * Renders `children` only while `feature` is not archived (Settings › Archived features): the
 * one hide-guard an entry point of an archived feature is wrapped in.
 */
export function Unarchived({
  feature,
  children
}: {
  feature: ArchivableFeature
  children: React.ReactNode
}): React.JSX.Element | null {
  return useIsArchived(feature) ? null : <>{children}</>
}
