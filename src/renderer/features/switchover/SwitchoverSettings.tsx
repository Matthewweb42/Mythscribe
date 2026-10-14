import { useId } from 'react'
import { useShellDialogStore } from '@renderer/features/shell/shellDialogStore'
import { useSwitchoverStore } from './switchoverStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'

/**
 * Settings › AI › **Story memory** for a project on the old story memory (F-16.31 part A, plan
 * `Switchover.md` §3.1, decision SW-D1): one line on what the new one is, and *Switch to the new
 * story memory…*, which closes Settings and starts the flow on its intro (the same as Help's
 * item). Every build; never offered on its own when a project opens. The v2 form is
 * `MemorySettings`.
 */
export function SwitchoverSettings(): React.JSX.Element {
  const headingId = useId()
  const start = (): void => {
    useShellDialogStore.getState().close()
    void useSwitchoverStore.getState().open()
  }
  return (
    <section
      aria-labelledby={headingId}
      data-testid="switchover-settings"
      className="flex min-w-0 flex-col gap-1.5"
    >
      <h3 id={headingId} className="m-0 text-sm font-medium">
        Story memory
      </h3>
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs text-fg-muted">
          This project uses the old story memory: tags and the story bible. The new one reads your
          book and keeps your names, notes and labels.
        </span>
        <button type="button" className={BUTTON} onClick={start}>
          Switch to the new story memory…
        </button>
      </div>
    </section>
  )
}
