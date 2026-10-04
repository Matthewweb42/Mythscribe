import { useState } from 'react'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { loadSummary } from './loadSummary'
import { useTagStore } from './tagStore'

const BUTTON =
  'shrink-0 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-raised disabled:opacity-50 disabled:hover:bg-transparent'

interface TagBankActionsProps {
  /** Whether select mode (F-4.9) is on; the toggle shows it pressed. */
  selecting: boolean
  onToggleSelect: () => void
  /** No tags at all: nothing to export or select. */
  empty: boolean
}

/**
 * The bank row of the Tags tab (F-4.9): import a tag bank file, export this bank to one, and
 * turn select mode on or off. The file pick is the confirmation: main's dialogs ask for the
 * path, a cancel does nothing, and a toast reports what was written or created.
 */
export function TagBankActions({
  selecting,
  onToggleSelect,
  empty
}: TagBankActionsProps): React.JSX.Element {
  const importBank = useTagStore((s) => s.importBank)
  const exportBank = useTagStore((s) => s.exportBank)
  const [busy, setBusy] = useState(false)

  const run = async (action: () => Promise<void>): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await action()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }

  const onImport = (): Promise<void> =>
    run(async () => {
      const result = await importBank()
      if (result === null) return
      const summary = loadSummary(result.created.length, result.skipped.length, 'Imported')
      if (result.created.length === 0) toast.info(summary)
      else toast.success(summary)
    })

  const onExport = (): Promise<void> =>
    run(async () => {
      const result = await exportBank()
      if (result === null) return
      const tags = result.count === 1 ? '1 tag' : `${result.count} tags`
      const name = result.path.split(/[\\/]/).pop() ?? result.path
      toast.success(`Exported ${tags} to ${name}`)
    })

  return (
    <div role="group" aria-label="Tag bank" className="flex shrink-0 flex-wrap gap-1.5 px-2 pt-2">
      <button type="button" onClick={() => void onImport()} disabled={busy} className={BUTTON}>
        Import…
      </button>
      <button
        type="button"
        onClick={() => void onExport()}
        disabled={busy || empty}
        className={BUTTON}
      >
        Export…
      </button>
      <button
        type="button"
        aria-pressed={selecting}
        onClick={onToggleSelect}
        disabled={empty && !selecting}
        className={`${BUTTON} ml-auto aria-pressed:border-accent aria-pressed:text-fg`}
      >
        Select
      </button>
    </div>
  )
}
