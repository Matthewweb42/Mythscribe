import { DEFAULT_HONESTY, HONESTY_LABEL, HONESTY_LEVELS, Honesty } from '@shared/critique'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'

/**
 * A panel's title row with the honesty setting beside it. One setting
 * (`AiSettings.critique.honesty`, F-14.4) drives both the editor's notes (F-14.8) and the beta
 * reader (F-14.11), so the control is shared rather than copied: whichever panel is open writes
 * the same project setting. `testId` keeps each panel's own hook for its tests. The select is
 * disabled until the settings load, so a click can never write a default over a stored choice.
 */
export function HonestySelect({
  title,
  testId
}: {
  title: string
  testId: string
}): React.JSX.Element {
  const honesty = useAiSettingsStore((s) => s.settings?.critique.honesty ?? DEFAULT_HONESTY)
  const loaded = useAiSettingsStore((s) => s.settings !== null)
  const update = useAiSettingsStore((s) => s.update)
  return (
    <div className="flex flex-wrap items-center gap-3">
      <span className="text-xs font-medium text-fg">{title}</span>
      <label className="ml-auto flex items-center gap-1 text-xs text-fg-muted">
        <span>Honesty</span>
        <select
          data-testid={testId}
          aria-label="Honesty"
          value={honesty}
          disabled={!loaded}
          onChange={(event) => update({ critique: { honesty: Honesty.parse(event.target.value) } })}
          className="rounded-md border border-line bg-bg px-1 py-0.5 text-xs text-fg"
        >
          {HONESTY_LEVELS.map((level) => (
            <option key={level} value={level}>
              {HONESTY_LABEL[level]}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
