import type { CloudProvider } from '@shared/cloudSync'
import type { SwitchoverFailure as Failure } from '@shared/memory/switchover'
import { failureLines, stepLabel } from './switchoverText'

const BUTTON =
  'rounded-md border border-line px-3 py-1.5 text-sm hover:bg-surface disabled:opacity-60'

/**
 * A switch-over step that failed (F-16.31 part A, plan `Switchover.md` §3.5): what failed, what
 * happened, that nothing was changed, the next step, and *Try again*, which runs the step again.
 * A changed project (`project`) is not tried again: its next step is to start over.
 */
export function SwitchoverFailure({
  failure,
  cloud,
  busy,
  onRetry
}: {
  failure: Failure
  cloud: CloudProvider | null
  busy: boolean
  onRetry: () => void
}): React.JSX.Element {
  const { message, nothingChanged } = failureLines(failure)
  return (
    <div
      role="alert"
      data-testid="switchover-failure"
      className="flex flex-col gap-1 rounded-md border border-danger px-3 py-2 text-sm"
    >
      <p className="m-0 font-semibold text-danger">What failed: {stepLabel(failure.step, cloud)}</p>
      <p className="m-0 break-words">{message}</p>
      {nothingChanged === null ? null : <p className="m-0">{nothingChanged}</p>}
      <p className="m-0">Next: {failure.nextStep}</p>
      {failure.step === 'project' ? null : (
        <div>
          <button type="button" className={BUTTON} disabled={busy} onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
    </div>
  )
}
