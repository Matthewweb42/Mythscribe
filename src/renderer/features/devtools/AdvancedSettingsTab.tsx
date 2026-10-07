import { DEVTOOLS_CHORD } from '@shared/devtools'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { formatShortcut } from '@renderer/features/shell/shortcuts'
import { useDevToolsStore } from './devToolsStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-sm hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

/**
 * The Advanced tab of the Settings dialog (2026-10-07): the developer tools switch. App-wide and
 * off on every install; while it is off nothing extra is recorded. While on, Help › Developer
 * tools and the shortcut open the panel, and Help › Chromium DevTools opens the window's DevTools.
 */
export function AdvancedSettingsTab(): React.JSX.Element {
  const enabled = useDevToolsStore((s) => s.enabled)
  const busy = useDevToolsStore((s) => s.busy)
  const error = useDevToolsStore((s) => s.error)
  const setEnabled = useDevToolsStore((s) => s.setEnabled)
  const chord = formatShortcut(DEVTOOLS_CHORD)

  return (
    <div className="flex flex-col gap-4 text-sm">
      <section aria-label="Developer tools" className="flex flex-col gap-2">
        <h3 className="m-0 text-sm font-medium">Developer tools</h3>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            data-testid="devtools-enabled"
            checked={enabled}
            disabled={busy}
            onChange={(event) => void setEnabled(event.target.checked)}
          />
          <span>Turn on developer tools</span>
        </label>
        <p className="m-0 text-xs text-fg-muted">
          For finding out why something does not work. While on, MythScribe keeps a live log of
          errors and warnings and a record of every AI request (timings, tokens, cost, and why
          VibeWrite did or did not ask), in memory only: nothing is written to disk or sent
          anywhere, and it is all dropped when you turn this off. Prompt and answer text shows only
          when you ask for it. Open the panel from Help › Developer tools or with {chord}.
        </p>
        {enabled ? (
          <div>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                useShellDialogStore.getState().close()
                useDevToolsStore.getState().openPanel()
              }}
            >
              Open developer tools
            </button>
          </div>
        ) : null}
      </section>
      {error === null ? null : (
        <p role="alert" className="m-0 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  )
}
