import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import {
  cloudUnpriced,
  cloudUnpricedRefusal,
  type RebuildEstimate
} from '@shared/memory/switchover'
import type { RebuildAction, RebuildSummary } from '@shared/memory/views'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { useIndexingStore } from '@renderer/features/ai/indexingStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { useDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useMemoryStore } from './memoryStore'
import { CLOUD_REBUILD_CAPS, estimateLine, shortDate } from './memoryView'
import { findingRuleLine } from './needsALook/findingView'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'
const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'

/**
 * The Book tab's *Rebuild memory* (F-16.19; design §2.7): what it does, the last rebuild's state
 * ("Reading 3 of 12 scenes", or when it finished, with *See what changed*), and the button that
 * opens the dialog, price first.
 */
export function RebuildMemory(): React.JSX.Element {
  const headingId = useId()
  const rebuild = useMemoryStore((s) => s.status?.rebuild ?? null)
  const open = useMemoryStore((s) => s.setRebuildOpen)
  const running = rebuild !== null && rebuild.finishedAt === null
  return (
    <section aria-labelledby={headingId} data-testid="rebuild-memory">
      <h3 id={headingId} className={HEADING}>
        Memory
      </h3>
      <p className="m-0 text-xs text-fg-muted">
        Rebuild reads the whole book once and keeps what your prose states, each line with its
        quote. Your text, Pinned, Ideas and Dismissed stay as they are.
      </p>
      {rebuild === null ? null : (
        <p className="m-0 mt-1 text-xs text-fg-muted" data-testid="rebuild-state">
          {running
            ? `Rebuilding: ${rebuild.done} of ${rebuild.total} scenes read`
            : `Last rebuilt on ${shortDate(new Date(rebuild.finishedAt ?? rebuild.startedAt))}`}
          {running ? null : (
            <button type="button" className={`${SMALL} ml-1`} onClick={() => open('summary')}>
              See what changed
            </button>
          )}
        </p>
      )}
      <button
        type="button"
        className={`${SMALL} mt-1 border border-line`}
        onClick={() => open(running ? 'summary' : 'start')}
      >
        {running ? 'Rebuild progress…' : 'Rebuild memory…'}
      </button>
    </section>
  )
}

type Stage =
  | { kind: 'estimating' }
  | { kind: 'confirm'; estimate: RebuildEstimate }
  | { kind: 'starting'; estimate: RebuildEstimate }
  | { kind: 'failed'; message: string }
  | { kind: 'watching' }

/**
 * The *Rebuild memory* dialog (F-16.19): the price first (`memory:rebuildEstimate`, nothing sent),
 * then, confirmed, the rebuild (`memory:rebuild`) with its progress and *Stop* (the queue's Stop),
 * then one summary grouped by sheet with its bulk actions: *Not right* for a sheet's new lines,
 * *Not right* for the new secrets and threads (F-16.22: each goes to Dismissed as *Not a secret*
 * would), *Not names* for the names whose lines wait, and (F-16.29) *Not a problem* for the
 * possible contradictions the rebuild's sweep opened. Mounted in the project screen (v2); open while the
 * memory store says so.
 */
export function RebuildDialog(): React.JSX.Element | null {
  const open = useMemoryStore((s) => s.rebuildOpen)
  if (open === null) return null
  return <Dialog start={open === 'start'} />
}

function Dialog({ start }: { start: boolean }): React.JSX.Element {
  const titleId = useId()
  const rebuild = useMemoryStore((s) => s.status?.rebuild ?? null)
  const [stage, setStage] = useState<Stage>(start ? { kind: 'estimating' } : { kind: 'watching' })
  const close = (): void => useMemoryStore.getState().setRebuildOpen(null)

  useEffect(() => {
    if (!start) return
    let live = true
    ipc()
      .invoke('memory:rebuildEstimate', undefined)
      .then((estimate) => {
        if (live) setStage({ kind: 'confirm', estimate })
      })
      .catch((err: unknown) => {
        if (live) setStage({ kind: 'failed', message: describeError(err) })
      })
    return () => {
      live = false
    }
  }, [start])

  const confirm = async (estimate: RebuildEstimate): Promise<void> => {
    setStage({ kind: 'starting', estimate })
    try {
      const result = await ipc().invoke('memory:rebuild', undefined)
      if (!result.ok) {
        setStage({ kind: 'failed', message: `${result.message} ${result.nextStep}`.trim() })
        return
      }
      // The pushed status carries the run from here.
      await useMemoryStore.getState().load()
      setStage({ kind: 'watching' })
    } catch (err) {
      setStage({ kind: 'failed', message: describeError(err) })
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  const running = rebuild !== null && rebuild.finishedAt === null
  // SW-D9: on MythScribe Cloud a rebuild without its price is never offered (main refuses it too).
  const priced =
    (stage.kind === 'confirm' || stage.kind === 'starting') && !cloudUnpriced(stage.estimate)
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        data-testid="rebuild-dialog"
        className="flex max-h-[80vh] w-[520px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          Rebuild memory
        </h2>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto text-sm">
          {stage.kind === 'estimating' ? (
            <p className={`m-0 ${AI_WAIT_CLASS}`} role="status">
              Working out what a rebuild would cost…
            </p>
          ) : stage.kind === 'confirm' || stage.kind === 'starting' ? (
            <>
              <p className="m-0">
                The AI reads every scene of this draft once and keeps what the prose states, each
                line proved by a quote. It replaces what it read before, scene by scene. Your text,
                Pinned, Ideas and Dismissed stay as they are.
              </p>
              <EstimateLines estimate={stage.estimate} />
            </>
          ) : stage.kind === 'failed' ? (
            <p role="alert" className="m-0 text-danger">
              {stage.message}
            </p>
          ) : running ? (
            <p className={`m-0 ${AI_WAIT_CLASS}`} role="status" data-testid="rebuild-progress">
              Reading {rebuild.done} of {rebuild.total} scenes…
            </p>
          ) : (
            <Summary />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {priced && (stage.kind === 'confirm' || stage.kind === 'starting') ? (
            <button
              type="button"
              className={BUTTON}
              disabled={stage.kind === 'starting'}
              onClick={() => void confirm(stage.estimate)}
            >
              Rebuild
            </button>
          ) : null}
          {stage.kind === 'watching' && running ? (
            <button
              type="button"
              className={BUTTON}
              onClick={() => void useIndexingStore.getState().cancel()}
            >
              Stop
            </button>
          ) : null}
          <button type="button" className={BUTTON} onClick={close}>
            {stage.kind === 'confirm' && priced ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The price before the author confirms: the estimate, and on MythScribe Cloud where it is paid
 * from and which caps apply (decision SW-D9, the final screen's words). Cloud without its price
 * says why the rebuild does not start and what to do (main's refusal), with no price at all.
 */
function EstimateLines({ estimate }: { estimate: RebuildEstimate }): React.JSX.Element {
  if (cloudUnpriced(estimate)) {
    const refusal = cloudUnpricedRefusal(estimate)
    return (
      <p role="alert" className="mt-2 mb-0 text-danger" data-testid="rebuild-unpriced">
        {refusal.message} {refusal.nextStep}
      </p>
    )
  }
  return (
    <>
      <p className="mt-2 mb-0 text-fg-muted tabular-nums" data-testid="rebuild-estimate">
        {estimateLine(estimate)}
      </p>
      {estimate.source === 'cloud' ? (
        <p className="mt-1 mb-0 text-fg-muted" data-testid="rebuild-cloud">
          Paid from your MythScribe Cloud balance. {CLOUD_REBUILD_CAPS}
        </p>
      ) : null}
    </>
  )
}

/** What the last rebuild changed, grouped by sheet, with the bulk actions. */
function Summary(): React.JSX.Element {
  const [summary, setSummary] = useState<RebuildSummary | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const read = async (): Promise<void> => {
    setSummary(await ipc().invoke('memory:rebuildSummary', undefined))
  }
  useEffect(() => {
    let live = true
    ipc()
      .invoke('memory:rebuildSummary', undefined)
      .then((answer) => {
        if (live) setSummary(answer)
      })
      .catch((err: unknown) => toast.error(describeError(err)))
    return () => {
      live = false
    }
  }, [])
  const act = async (action: RebuildAction): Promise<void> => {
    setBusy(true)
    try {
      await runAction(action)
      await read()
    } catch (err) {
      toast.error(describeError(err))
    } finally {
      setBusy(false)
    }
  }
  if (summary === undefined) return <p className="m-0 text-fg-muted">Reading…</p>
  if (summary === null) return <p className="m-0 text-fg-muted">No rebuild has run yet.</p>
  const { progress } = summary
  return (
    <div data-testid="rebuild-summary">
      <p className="m-0">
        Read {progress.done} of {progress.total} scenes.
        {summary.sheets.length === 0 &&
        summary.waiting.length === 0 &&
        summary.topics.length === 0 &&
        summary.findings.length === 0
          ? ' Nothing new: the memory already held what the book states.'
          : ''}
      </p>
      {summary.sheets.length === 0 ? null : (
        <ul className="m-0 mt-2 list-none p-0" aria-label="New lines by sheet">
          {summary.sheets.map((sheet) => (
            <li key={sheet.recordId} className="flex items-center gap-2 border-b border-line py-1">
              <span className="min-w-0 flex-1">
                {sheet.name}: {sheet.lines} new line{sheet.lines === 1 ? '' : 's'}
              </span>
              <button
                type="button"
                className={SMALL}
                aria-label={`Not right: ${sheet.name}’s new lines`}
                disabled={busy}
                onClick={() => void act({ action: 'notRightAll', recordId: sheet.recordId })}
              >
                Not right
              </button>
            </li>
          ))}
        </ul>
      )}
      {summary.topics.length === 0 ? null : (
        <div className="mt-2" role="group" aria-label="New secrets and threads">
          <p className="m-0 text-fg-muted">New secrets and threads ({summary.topics.length}):</p>
          <ul className="m-0 list-none p-0">
            {summary.topics.map((topic) => (
              <li key={topic.recordId}>
                {topic.label} <span className="text-fg-muted">({topic.kind})</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={SMALL}
            aria-label="Not right: the new secrets and threads"
            disabled={busy}
            onClick={() => void act({ action: 'notTopics' })}
          >
            Not right
          </button>
        </div>
      )}
      {summary.findings.length === 0 ? null : (
        <div className="mt-2" role="group" aria-label="Possible contradictions">
          <p className="m-0 text-fg-muted">Possible contradictions ({summary.findings.length}):</p>
          <ul className="m-0 list-none p-0">
            {summary.findings.map((finding) => (
              <li key={finding.id}>{findingRuleLine(finding)}</li>
            ))}
          </ul>
          <button
            type="button"
            className={SMALL}
            aria-label="Not a problem: the possible contradictions"
            disabled={busy}
            onClick={() => void act({ action: 'notProblems' })}
          >
            Not a problem
          </button>
        </div>
      )}
      {summary.waiting.length === 0 ? null : (
        <div className="mt-2" role="group" aria-label="Names to answer">
          <p className="m-0 text-fg-muted">Lines waiting on whether these are names:</p>
          <ul className="m-0 list-none p-0">
            {summary.waiting.map((name) => (
              <li key={name.norm}>
                {name.text}: {name.lines} line{name.lines === 1 ? '' : 's'}
              </li>
            ))}
          </ul>
          <button
            type="button"
            className={SMALL}
            disabled={busy}
            onClick={() => void act({ action: 'notNames' })}
          >
            Not names
          </button>
        </div>
      )}
    </div>
  )
}

async function runAction(action: RebuildAction): Promise<void> {
  await ipc().invoke('memory:rebuildAction', action)
  // *Not right*, *Not names* and *Not a problem* wrote Dismissed rows.
  await useDismissedStore.getState().load()
}
