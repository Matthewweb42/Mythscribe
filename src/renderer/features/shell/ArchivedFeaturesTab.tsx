import { ARCHIVABLE_FEATURES, ARCHIVABLE_FEATURE_LABEL, isArchived } from '@shared/archivedFeatures'
import { useEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { setArchived } from './archived'

/**
 * Settings › Archived features (notes redesign, 2026-10-15): one switch per archivable feature.
 * On (archived, the default) hides every way into the feature; off brings them back. Nothing is
 * deleted either way. Kept in this project's editor settings.
 */
export function ArchivedFeaturesTab(): React.JSX.Element {
  const settings = useEditorSettingsStore((s) => s.settings)
  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="m-0 text-xs text-fg-muted">
        These features are put away while the notes and Ms Scribe are redesigned. An archived
        feature is hidden everywhere; its settings and data are kept, and switching it off here
        brings it back.
      </p>
      <ul aria-label="Archived features" className="m-0 flex list-none flex-col gap-2 p-0">
        {ARCHIVABLE_FEATURES.map((feature) => {
          const archived = isArchived(feature, settings?.unarchived)
          return (
            <li key={feature}>
              <label className="flex items-center justify-between gap-3">
                <span>{ARCHIVABLE_FEATURE_LABEL[feature]}</span>
                <span className="flex items-center gap-2 text-xs text-fg-muted">
                  {archived ? 'Archived' : 'Shown'}
                  <input
                    type="checkbox"
                    role="switch"
                    aria-label={`Archive ${ARCHIVABLE_FEATURE_LABEL[feature]}`}
                    aria-checked={archived}
                    checked={archived}
                    disabled={settings === null}
                    onChange={(event) => setArchived(feature, event.target.checked)}
                  />
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
