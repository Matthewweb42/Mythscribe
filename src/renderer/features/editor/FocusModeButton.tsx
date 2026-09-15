import { Maximize2 } from 'lucide-react'
import { useFocusStore } from '@renderer/features/focus/focusStore'
import { APP_SHORTCUTS, formatShortcut } from '@renderer/features/shell/shortcuts'

const BUTTON =
  'rounded-md p-1.5 text-fg-muted hover:bg-surface-raised hover:text-fg aria-pressed:bg-surface-raised aria-pressed:text-accent'

/**
 * The toolbar toggle for focus mode (F-6.1); `aria-pressed` reflects the window's fullscreen
 * state. In focus mode the toolbar is hidden, so F11 and Escape are the way out until the
 * control bar (F-6.5) adds an Exit button.
 */
export function FocusModeButton(): React.JSX.Element {
  const active = useFocusStore((s) => s.active)
  const toggle = useFocusStore((s) => s.toggle)
  return (
    <button
      type="button"
      aria-label="Focus mode"
      title={`Focus mode (${formatShortcut(APP_SHORTCUTS.focusMode.chord)})`}
      aria-pressed={active}
      onClick={() => void toggle()}
      className={BUTTON}
    >
      <Maximize2 size={16} aria-hidden="true" />
    </button>
  )
}
