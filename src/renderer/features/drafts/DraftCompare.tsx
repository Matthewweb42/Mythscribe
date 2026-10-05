import { useEffect, useId, useState } from 'react'
import type { DraftComparison, DraftInfo } from '@shared/drafts'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { dialogs } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { DocDiff } from './DocDiff'
import { useDraftStore } from './draftStore'

/** The answer for one request, keyed so an answer for other pickers reads as still loading. */
type LoadState =
  | { key: string; status: 'error'; message: string }
  | { key: string; status: 'ready'; comparison: DraftComparison }

const BUTTON =
  'rounded-md border border-line px-2.5 py-1 text-xs hover:bg-surface disabled:opacity-50 disabled:hover:bg-transparent'

const plural = (count: number, noun: string): string =>
  `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`

/**
 * Compare two drafts (F-8.5), inside the Drafts dialog: two pickers (From, the draft the author
 * chose; To, the active one), then every manuscript document whose text differs, in tree order,
 * as an inline word diff (removed text struck through, added text highlighted, long unchanged
 * stretches collapsed). When one side is the active draft, each scene can be reverted to the
 * other side's text, or all of them at once after a confirm. Pending saves are flushed before
 * each comparison so main compares what is on screen.
 */
export function DraftCompare({
  drafts,
  activeId,
  initialFromId,
  onBack
}: {
  drafts: readonly DraftInfo[]
  activeId: string
  initialFromId: string
  onBack: () => void
}): React.JSX.Element {
  const fromSelect = useId()
  const toSelect = useId()
  const [fromId, setFromId] = useState(initialFromId)
  const [toId, setToId] = useState(activeId)
  const [state, setState] = useState<LoadState | null>(null)
  /** Bumped after a revert so the comparison is asked for again. */
  const [round, setRound] = useState(0)
  const busy = useDraftStore((s) => s.busy)
  const revert = useDraftStore((s) => s.revert)
  const same = fromId === toId
  const key = `${fromId}:${toId}:${round}`

  useEffect(() => {
    if (same) return
    let cancelled = false
    const load = async (): Promise<void> => {
      // A failed save is reported by the autosave itself; the stored text is still worth comparing.
      await flushPendingSaves().catch(() => undefined)
      const comparison = await ipc().invoke('drafts:compare', { fromId, toId })
      if (!cancelled) setState({ key, status: 'ready', comparison })
    }
    load().catch((err: unknown) => {
      if (!cancelled) setState({ key, status: 'error', message: describeError(err) })
    })
    return () => {
      cancelled = true
    }
  }, [fromId, toId, same, key])

  // Reverting writes into the active draft, so it is offered only when one side is the active
  // draft; the text comes from the other side.
  const source = fromId === activeId ? toId : toId === activeId ? fromId : null
  const sourceName = drafts.find((d) => d.id === source)?.name ?? ''

  const revertDocs = async (nodeIds?: string[]): Promise<void> => {
    if (source === null || same) return
    if (!nodeIds) {
      const ok = await dialogs.confirm({
        title: `Revert every scene to "${sourceName}"?`,
        message:
          'The active draft takes that draft’s text in every scene that differs. Text found in no other draft is lost.',
        confirmLabel: 'Revert all',
        danger: true
      })
      if (!ok) return
    }
    if (await revert(source, nodeIds)) setRound((n) => n + 1)
  }

  let body: React.ReactNode
  if (same) body = <p className="m-0 text-sm text-fg-muted">Pick two different drafts.</p>
  else if (state?.key !== key) body = <p className="m-0 text-xs text-fg-muted">Comparing…</p>
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
        <p data-testid="draft-compare-summary" className="m-0 text-sm text-fg-muted">
          {docs.length === 0
            ? 'The two drafts read the same.'
            : `${plural(docs.length, 'scene')} ${docs.length === 1 ? 'differs' : 'differ'}, ${unchanged.toLocaleString()} ${unchanged === 1 ? 'reads' : 'read'} the same.`}
        </p>
        {docs.map((doc) => (
          <DocDiff
            key={doc.nodeId}
            doc={doc}
            actionLabel={source !== null ? `Revert this scene to "${sourceName}"` : null}
            busy={busy}
            onAction={() => void revertDocs([doc.nodeId])}
          />
        ))}
        {docs.length > 0 && source !== null ? (
          <div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void revertDocs()}
              className={BUTTON}
            >
              {`Revert all to "${sourceName}"…`}
            </button>
          </div>
        ) : null}
      </>
    )
  }

  return (
    <div data-testid="draft-compare" className="flex min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button type="button" onClick={onBack} className={BUTTON}>
          Back to drafts
        </button>
        <label htmlFor={fromSelect}>From</label>
        <select
          id={fromSelect}
          value={fromId}
          onChange={(event) => setFromId(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          {drafts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id === activeId ? `${d.name} (active)` : d.name}
            </option>
          ))}
        </select>
        <label htmlFor={toSelect}>To</label>
        <select
          id={toSelect}
          value={toId}
          onChange={(event) => setToId(event.target.value)}
          className="rounded-md border border-line bg-surface px-2 py-1"
        >
          {drafts.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id === activeId ? `${d.name} (active)` : d.name}
            </option>
          ))}
        </select>
      </div>
      {body}
    </div>
  )
}
