import { useEffect, useId, useState } from 'react'
import type { SnapshotComparison, SnapshotInfo } from '@shared/snapshots'
import { DocDiff } from '@renderer/features/drafts/DocDiff'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useSnapshotStore } from './snapshotStore'

/** The answer for one request, keyed so an answer for other pickers reads as still loading. */
type LoadState =
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; comparison: SnapshotComparison }

/** The against picker's value for the current text. */
const CURRENT = ''

const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`

const optionLabel = (s: SnapshotInfo): string =>
  `${s.name} (${new Date(s.created).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })})`

/**
 * Compare a snapshot (F-8.6), inside the Snapshots dialog: a snapshot picker and an against picker
 * (the current text by default, or another snapshot), then every document whose text differs,
 * in tree order, as the same inline word diff as drafts (`DocDiff`). Against the current text,
 * each document can be restored to the snapshot's text, or all of them at once after a confirm;
 * the comparison is asked for again after a restore. Pending saves are flushed before each
 * comparison so main compares what is on screen.
 */
export function SnapshotCompare({
  snapshots,
  initialId,
  onBack
}: {
  snapshots: readonly SnapshotInfo[]
  initialId: string
  onBack: () => void
}): React.JSX.Element {
  const snapshotSelect = useId()
  const againstSelect = useId()
  const [id, setId] = useState(initialId)
  const [againstId, setAgainstId] = useState(CURRENT)
  const [state, setState] = useState<LoadState | null>(null)
  /** Bumped after a restore so the comparison is asked for again. */
  const [round, setRound] = useState(0)
  const busy = useSnapshotStore((s) => s.busy)
  const restore = useSnapshotStore((s) => s.restore)
  const againstCurrent = againstId === CURRENT
  const key = `${id}:${againstId}:${round}`
  const name = snapshots.find((s) => s.id === id)?.name ?? ''

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored text is still worth comparing.
      await flushPendingSaves().catch(() => undefined)
      const comparison = await ipc().invoke(
        'snapshots:compare',
        againstId === CURRENT ? { id } : { id, againstId }
      )
      if (!cancelled) setState({ key, status: 'ready', comparison })
    }
    load().catch((err: unknown) => {
      if (!cancelled) setState({ key, status: 'error', message: describeError(err) })
    })
    return () => {
      cancelled = true
    }
  }, [id, againstId, key])

  const restoreDocs = async (nodeIds?: string[]): Promise<void> => {
    if (!againstCurrent) return
    if (!nodeIds) {
      const ok = await dialogs.confirm({
        title: `Restore every document to "${name}"?`,
        message:
          'Every document that differs takes the snapshot’s text. The text they have now is kept first as an automatic snapshot.',
        confirmLabel: 'Restore all',
        danger: true
      })
      if (!ok) return
    }
    if (await restore(id, nodeIds)) setRound((n) => n + 1)
  }

  let body: React.ReactNode
  if (state?.key !== key) body = <p className="m-0 text-xs text-fg-muted">Comparing…</p>
  else if (state.status === 'error')
    body = (
      <p role="alert" className="m-0 text-sm text-danger">
        {state.message}
      </p>
    )
  else {
    const { docs, unchanged } = state.comparison
    body = (
      <>
        <p data-testid="snapshot-compare-summary" className="m-0 text-sm text-fg-muted">
          {docs.length === 0
            ? againstCurrent
              ? 'The snapshot reads the same as the current text.'
              : 'The two snapshots read the same.'
            : `${plural(docs.length, 'document')} ${docs.length === 1 ? 'differs' : 'differ'}, ${unchanged.toLocaleString()} ${unchanged === 1 ? 'reads' : 'read'} the same.`}
        </p>
        {docs.map((doc) => (
          <DocDiff
            key={doc.nodeId}
            doc={doc}
            actionLabel={againstCurrent ? 'Restore this document' : null}
            busy={busy}
            onAction={() => void restoreDocs([doc.nodeId])}
          />
        ))}
        {docs.length > 0 && againstCurrent ? (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void restoreDocs()}
              className={BUTTON}
            >
              Restore all…
            </button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div data-testid="snapshot-compare" className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={onBack} className={BUTTON}>
          Back to snapshots
        </button>
        <label htmlFor={snapshotSelect}>Snapshot</label>
        <select
          id={snapshotSelect}
          value={id}
          onChange={(event) => {
            const next = event.target.value
            setId(next)
            if (next === againstId) setAgainstId(CURRENT)
          }}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          {snapshots.map((s) => (
            <option key={s.id} value={s.id}>
              {optionLabel(s)}
            </option>
          ))}
        </select>
        <label htmlFor={againstSelect}>Against</label>
        <select
          id={againstSelect}
          value={againstId}
          onChange={(event) => setAgainstId(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          <option value={CURRENT}>Current text</option>
          {snapshots
            .filter((s) => s.id !== id)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {optionLabel(s)}
              </option>
            ))}
        </select>
      </div>
      {body}
    </div>
  )
}
