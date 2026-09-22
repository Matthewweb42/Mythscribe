import { Sparkles } from 'lucide-react'
import { AI_DATA_SHARING, AI_DIAL_LABEL, isFeatureAllowed } from '@shared/aiSettings'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'

const BUTTON =
  'flex shrink-0 items-center gap-1 rounded-md whitespace-nowrap px-1.5 py-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-muted aria-pressed:bg-surface-raised aria-pressed:text-accent'

/**
 * The VibeWrite toggle in the single-document toolbar (F-5.3): `aria-pressed` is the mode's
 * effective state (on, and allowed by the dial). Below Suggest, or with the feature toggled
 * off in Settings, it is disabled and its title says what to change; while on, the title
 * carries the last subtle failure (rate limit, network, ...) so a silent pause has a reason.
 * Mouse-down is swallowed so the editor keeps its caret and the author can keep typing.
 */
export function VibeWriteToggle({ error }: { error: string | null }): React.JSX.Element | null {
  const settings = useAiSettingsStore((s) => s.settings)
  const update = useAiSettingsStore((s) => s.update)
  if (settings === null) return null
  const allowed = isFeatureAllowed(settings, 'ghostText')
  const { minDial } = AI_DATA_SHARING.ghostText
  const on = settings.ghostText.enabled && allowed
  let title = 'VibeWrite: ghost-text continuations while you write'
  if (settings.dial < minDial) {
    title = `VibeWrite needs the AI dial at ${AI_DIAL_LABEL[minDial]} or higher (Settings, AI tab)`
  } else if (!allowed) {
    title = 'Ghost text is turned off for this project (Settings, AI tab)'
  } else if (on && error) {
    title = `VibeWrite paused: ${error}`
  }
  return (
    <button
      type="button"
      aria-pressed={on}
      disabled={!allowed}
      title={title}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() =>
        update({ ghostText: { ...settings.ghostText, enabled: !settings.ghostText.enabled } })
      }
      className={BUTTON}
    >
      <Sparkles size={14} aria-hidden="true" />
      VibeWrite
    </button>
  )
}
