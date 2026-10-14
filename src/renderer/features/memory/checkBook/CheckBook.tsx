import { useEffect, useId, useState, type KeyboardEvent } from 'react'
import { CHECK_NOT_COVERED, type CheckEstimate } from '@shared/memory/views'
import { AI_WAIT_CLASS } from '@renderer/features/ai/aiWaitPhrases'
import { useIndexingStore } from '@renderer/features/ai/indexingStore'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { useMemoryStore } from '@renderer/features/memory/memoryStore'
import { useNow } from '@renderer/features/memory/useNow'
import { CheckReportView } from './CheckReport'
import {
  CHECK_COVERS,
  checkPriceLine,
  checkProgressLine,
  checkSkipsLine,
  checkWorkLine,
  lastCheckedLine
} from './checkView'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'
const SMALL =
  'rounded px-1.5 py-0.5 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg disabled:opacity-40'
const HEADING = 'm-0 mt-3 mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase'

/**
 * The Book tab's *Check the book* (F-16.30; design §2.7): what it does, "Last checked 2 days ago ·
 * 2 found" (or the run's progress), *Check the book…* (the dialog, price first) and *See the
 * report*. The report is read when this shows and it was not read yet.
 */
export function CheckTheBook(): React.JSX.Element {
  const headingId = useId()
  const report = useMemoryStore((s) => s.check.report)
  const progress = useMemoryStore((s) => s.status?.check ?? null)
  const setOpen = useMemoryStore((s) => s.setCheckOpen)
  const now = useNow()
  const running = progress !== null && progress.finishedAt === null
  useEffect(() => {
    const store = useMemoryStore.getState()
    if (store.check.report === null) store.loadCheckReport().catch(() => undefined)
  }, [])
  return (
    <section aria-labelledby={headingId} data-testid="check-the-book">
      <h3 id={headingId} className={HEADING}>
        Contradictions
      </h3>
      <p className="m-0 text-xs text-fg-muted">
        Check the book looks through the whole book and your notes for places that may not fit,
        judged twice by AI and the clearest confirmed by a stronger read. Priced first.
      </p>
      <p className="m-0 mt-1 text-xs text-fg-muted" data-testid="check-last">
        {running ? checkProgressLine(progress) : lastCheckedLine(report, now)}
        {!running && report !== null ? (
          <button type="button" className={`${SMALL} ml-1`} onClick={() => setOpen('report')}>
            See the report
          </button>
        ) : null}
      </p>
      <button
        type="button"
        className={`${SMALL} mt-1 border border-line`}
        onClick={() => setOpen(running ? 'report' : 'start')}
      >
        {running ? 'Check progress…' : 'Check the book…'}
      </button>
    </section>
  )
}

type Stage =
  | { kind: 'estimating' }
  | { kind: 'confirm'; estimate: CheckEstimate }
  | { kind: 'starting'; estimate: CheckEstimate }
  | { kind: 'failed'; message: string }
  /** Started: its progress, then its report once one newer than `past` (the last one's time) lands. */
  | { kind: 'watching'; past: string | null }
  /** Opened on the report (or the run's progress). */
  | { kind: 'report' }

/**
 * The *Check the book* dialog (F-16.30; plan P4 §4): the price first (`memory:checkEstimate`,
 * nothing sent: "About 3¢, at most 5¢", "Nothing changed since your last check: free", on Cloud
 * "from your Balance"), what it checks and what it does not, *Check* / *Cancel*; then its progress
 * (also in the activity bar) with *Stop* (the queue's Stop: what was judged stays); then the
 * report. Opened on the report alone from the Book tab, the activity bar's Open and the chat's
 * link. Mounted in the project screen (v2); open while the memory store says so.
 */
export function CheckBookDialog(): React.JSX.Element | null {
  const open = useMemoryStore((s) => s.checkOpen)
  if (open === null) return null
  return <Dialog start={open === 'start'} />
}

function Dialog({ start }: { start: boolean }): React.JSX.Element {
  const titleId = useId()
  const progress = useMemoryStore((s) => s.status?.check ?? null)
  const report = useMemoryStore((s) => s.check.report)
  const [stage, setStage] = useState<Stage>(start ? { kind: 'estimating' } : { kind: 'report' })
  const close = (): void => useMemoryStore.getState().setCheckOpen(null)
  const running = progress !== null && progress.finishedAt === null

  useEffect(() => {
    if (!start) {
      const store = useMemoryStore.getState()
      if (store.check.report === null) store.loadCheckReport().catch(() => undefined)
      return
    }
    let live = true
    void useMemoryStore
      .getState()
      .estimateCheck()
      .then((estimate) => {
        if (!live) return
        setStage(
          estimate === null
            ? { kind: 'failed', message: 'The price could not be worked out.' }
            : { kind: 'confirm', estimate }
        )
      })
    return () => {
      live = false
    }
  }, [start])

  const confirm = async (estimate: CheckEstimate): Promise<void> => {
    setStage({ kind: 'starting', estimate })
    const nodeId = useActiveEditorStore.getState().active?.id ?? null
    const result = await useMemoryStore.getState().startCheck(nodeId)
    if (result === null) {
      setStage({ kind: 'confirm', estimate })
      return
    }
    if (!result.ok) {
      setStage({ kind: 'failed', message: `${result.message} ${result.nextStep}`.trim() })
      return
    }
    setStage({ kind: 'watching', past: useMemoryStore.getState().check.report?.at ?? null })
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    close()
  }

  const pricing = stage.kind === 'confirm' || stage.kind === 'starting'
  // Started, and neither its progress nor its report has landed yet.
  const waiting = stage.kind === 'watching' && !running && (report?.at ?? null) === stage.past
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        data-testid="check-dialog"
        className="flex max-h-[80vh] w-[560px] max-w-[90vw] flex-col rounded-lg border border-line bg-surface-raised p-5 shadow-panel"
      >
        <h2 id={titleId} className="m-0 text-base font-semibold">
          Check the book
        </h2>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto text-sm">
          {stage.kind === 'estimating' ? (
            <p className={`m-0 ${AI_WAIT_CLASS}`} role="status">
              Working out what a check would cost…
            </p>
          ) : pricing ? (
            <>
              <p className="m-0 font-medium tabular-nums" data-testid="check-price">
                {checkPriceLine(stage.estimate)}
              </p>
              <p className="m-0 mt-1 text-xs text-fg-muted">{checkWorkLine(stage.estimate)}</p>
              <p className="m-0 mt-2">{CHECK_COVERS}</p>
              <p className="m-0 mt-2 text-fg-muted">
                {checkSkipsLine(CHECK_NOT_COVERED, stage.estimate.unreadScenes)}
              </p>
              {stage.estimate.hidden > 0 ? (
                <p className="m-0 mt-1 text-xs text-fg-muted">
                  {stage.estimate.hidden} possible{' '}
                  {stage.estimate.hidden === 1 ? 'contradiction is' : 'contradictions are'} set
                  aside because a scene looks like a flashback; the report lists them.
                </p>
              ) : null}
            </>
          ) : stage.kind === 'failed' ? (
            <p role="alert" className="m-0 text-danger">
              {stage.message}
            </p>
          ) : running || waiting ? (
            <p className={`m-0 ${AI_WAIT_CLASS}`} role="status" data-testid="check-progress">
              {running ? checkProgressLine(progress) : 'Checking…'}
            </p>
          ) : report === null ? (
            <p className="m-0 text-fg-muted">The book has not been checked yet.</p>
          ) : (
            <CheckReportView report={report} />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          {pricing ? (
            <button
              type="button"
              className={BUTTON}
              disabled={stage.kind === 'starting'}
              onClick={() => void confirm(stage.estimate)}
            >
              Check
            </button>
          ) : null}
          {running ? (
            <button
              type="button"
              className={BUTTON}
              onClick={() => void useIndexingStore.getState().cancel()}
            >
              Stop
            </button>
          ) : null}
          <button type="button" className={BUTTON} onClick={close}>
            {pricing ? 'Cancel' : 'Close'}
          </button>
        </div>
      </div>
    </div>
  )
}
