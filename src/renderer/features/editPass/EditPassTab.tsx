import { FilePenLine } from 'lucide-react'
import { isFeatureAllowed } from '@shared/aiSettings'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { formatUsd } from '@renderer/features/ai/usageFormat'
import { useEditPassStore, runningPass } from './editPassStore'
import { useEditPassViewStore } from './editPassViewStore'
import { PASS_STATUS_LABEL, passCounts, passDate, passTitle } from './passFormat'

/**
 * The Edits tab of the sidebar (F-14.15): New edit pass opens the workspace in the main pane;
 * a running pass shows its progress here with Stop; and the Edit reports list holds every pass
 * of the project, newest first, each opening its report in the main pane. Reports live with
 * the project, outside the manuscript, so they are never compiled or exported as the book.
 */
export function EditPassTab(): React.JSX.Element {
  const ids = useEditPassStore((s) => s.ids)
  const byId = useEditPassStore((s) => s.byId)
  const loaded = useEditPassStore((s) => s.loaded)
  const running = useEditPassStore((s) => runningPass(s))
  const view = useEditPassViewStore((s) => s.view)
  const settings = useAiSettingsStore((s) => s.settings)
  const allowed = settings !== null && isFeatureAllowed(settings, 'editPass')

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-3">
        <button
          type="button"
          data-testid="edit-pass-new"
          onClick={() => useEditPassStore.getState().openWorkspace()}
          className="flex items-center justify-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover"
        >
          <FilePenLine size={15} aria-hidden="true" />
          New edit pass
        </button>
        {allowed ? null : (
          <p className="m-0 text-xs text-fg-muted" data-testid="edit-pass-off">
            Edit passes need Use AI on for this project (Settings, AI).
          </p>
        )}
        {running === null ? null : (
          <div className="flex flex-col gap-1 text-xs" data-testid="edit-pass-running">
            <span className="text-fg">{`${passTitle(running)}: ${running.doneNodeIds.length} of ${running.nodeIds.length} scenes`}</span>
            <progress
              className="h-1.5 w-full"
              max={running.nodeIds.length}
              value={running.doneNodeIds.length}
              aria-label="Edit pass progress"
            />
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-raised"
                onClick={() => useEditPassStore.getState().openWorkspace()}
              >
                Show progress
              </button>
              <button
                type="button"
                className="rounded-md border border-line px-2 py-0.5 hover:bg-surface-raised"
                onClick={() => void useEditPassStore.getState().cancel(running.id)}
              >
                Stop
              </button>
            </div>
          </div>
        )}
      </div>
      <h3 className="m-0 px-3 pb-1 pt-3 text-xs font-semibold uppercase tracking-wide text-fg-muted">
        Edit reports
      </h3>
      {loaded && ids.length === 0 ? (
        <p className="m-0 px-3 text-xs text-fg-muted" data-testid="edit-reports-empty">
          No reports yet. Each pass saves its report here.
        </p>
      ) : (
        <ul
          className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-0 pb-2"
          aria-label="Edit reports"
        >
          {ids.map((id) => {
            const pass = byId[id]
            if (pass === undefined) return null
            const open = view?.kind === 'report' && view.passId === id
            return (
              <li key={id}>
                <button
                  type="button"
                  data-testid="edit-report-row"
                  aria-current={open ? 'true' : undefined}
                  onClick={() => void useEditPassStore.getState().openReport(id)}
                  className={`flex w-full flex-col items-start gap-0.5 px-3 py-1.5 text-left hover:bg-surface-raised ${open ? 'bg-surface-raised' : ''}`}
                >
                  <span className="text-sm text-fg">{passTitle(pass)}</span>
                  <span className="text-xs text-fg-muted">
                    {`${PASS_STATUS_LABEL[pass.status]} · ${passDate(pass.createdAt)} · ${formatUsd(pass.costUsd)}`}
                  </span>
                  <span className="text-xs text-fg-muted">{passCounts(pass)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
