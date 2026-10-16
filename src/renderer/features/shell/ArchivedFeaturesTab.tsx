import {
  ARCHIVABLE_FEATURES,
  ARCHIVABLE_FEATURE_LABEL,
  isArchived,
  type ArchivableFeature
} from '@shared/archivedFeatures'
import { useEditorSettingsStore } from '@renderer/features/editor/settingsStore'
import { setArchived } from './archived'

/** What the old story bible's switch puts away (notes redesign, fresh start, 2026-10-15). */
const STORY_BIBLE_HINT =
  'Characters, places and the other categories, the Index and tags, threads, the Library, To do, Changes, Organise and the quick reference. Nothing reads or changes them while archived; their data stays in the project.'

/** What the old views' switch puts away (the notes binder, 2026-10-16). */
const OLD_VIEWS_HINT =
  'The Outline (cork board, beats, threads) and Timeline (events) sections, which come back as tabs after Edits. Their cards and events are kept either way.'

/** The hint under a switch, or null. */
const HINT: Partial<Record<ArchivableFeature, string>> = {
  storyBible: STORY_BIBLE_HINT,
  oldViews: OLD_VIEWS_HINT
}

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
                <span className="flex flex-col">
                  {ARCHIVABLE_FEATURE_LABEL[feature]}
                  {HINT[feature] !== undefined ? (
                    <span className="text-xs text-fg-muted">{HINT[feature]}</span>
                  ) : null}
                </span>
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
