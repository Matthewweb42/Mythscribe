import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import {
  goalTargetError,
  isGoalDay,
  parseGoalTarget,
  wordsPerHour,
  type GoalsPatch,
  type GoalsStatus
} from '@shared/goals'
import { formatWords } from '@renderer/features/editor/wordFormat'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { GoalBar } from './GoalBar'
import { formatActiveTime, formatDays } from './goalFormat'
import { useGoalsStore } from './goalsStore'

const INPUT_CLASS =
  'w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-fg outline-none focus:border-accent'

/** The three fields of the form, as typed. */
interface Draft {
  projectTarget: string
  deadline: string
  dailyTarget: string
}

const draftOf = (status: GoalsStatus | null): Draft => ({
  projectTarget: status?.goals.projectTarget?.toString() ?? '',
  deadline: status?.goals.deadline ?? '',
  dailyTarget: status?.goals.dailyTarget?.toString() ?? ''
})

/** The patch the form asks for: only the fields that differ from what is stored. */
function patchOf(draft: Draft, status: GoalsStatus): GoalsPatch {
  const patch: GoalsPatch = {}
  const projectTarget =
    draft.projectTarget.trim() === '' ? null : parseGoalTarget(draft.projectTarget)
  const dailyTarget = draft.dailyTarget.trim() === '' ? null : parseGoalTarget(draft.dailyTarget)
  const deadline = draft.deadline === '' ? null : draft.deadline
  if (projectTarget !== status.goals.projectTarget) patch.projectTarget = projectTarget
  if (dailyTarget !== status.goals.dailyTarget) patch.dailyTarget = dailyTarget
  if (deadline !== status.goals.deadline) patch.deadline = deadline
  return patch
}

/** The pace line under the project bar. */
function paceLine(status: GoalsStatus): string | null {
  const { goals, daysLeft, perDayNeeded, manuscriptWords } = status
  if (goals.projectTarget === null || goals.deadline === null || daysLeft === null) return null
  if (manuscriptWords >= goals.projectTarget) return 'Target reached.'
  if (daysLeft === 0 || perDayNeeded === null) return 'The deadline has passed.'
  return `${formatDays(daysLeft)} left · ${formatWords(perDayNeeded)} a day`
}

/**
 * The Goals dialog (F-10.3): the project target and deadline with the manuscript's progress and
 * the pace still needed, the daily target with today's progress and the streaks, and the
 * session's active time, words, and words per hour. Saving writes only what changed; an empty
 * field clears its target. Opened from Tools › Goals… and the status strip; asks main for a
 * fresh status when it opens, so the session figures are current.
 */
export function GoalsDialog(): React.JSX.Element | null {
  const open = useGoalsStore((s) => s.open)
  if (!open) return null
  return <GoalsDialogBody />
}

function GoalsDialogBody(): React.JSX.Element {
  const titleId = useId()
  const status = useGoalsStore((s) => s.status)
  const close = useGoalsStore((s) => s.close)
  const [draft, setDraft] = useState<Draft>(() => draftOf(status))
  const [saving, setSaving] = useState(false)
  const first = useRef<HTMLInputElement>(null)
  const touched = useRef(false)

  useEffect(() => {
    first.current?.focus()
    useGoalsStore
      .getState()
      .load()
      .catch((err: unknown) => toast.error(describeError(err)))
  }, [])

  // The fields follow the loaded targets until the author types in one.
  useEffect(() => {
    if (!touched.current) setDraft(draftOf(status))
  }, [status])

  const edit = (field: keyof Draft, value: string): void => {
    touched.current = true
    setDraft((current) => ({ ...current, [field]: value }))
  }

  const projectError = goalTargetError(draft.projectTarget, true)
  const dailyError = goalTargetError(draft.dailyTarget, true)
  const deadlineError =
    draft.deadline !== '' && !isGoalDay(draft.deadline) ? 'Pick a valid date.' : null
  const invalid = projectError !== null || dailyError !== null || deadlineError !== null

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault()
    if (invalid || !status || saving) return
    const patch = patchOf(draft, status)
    if (Object.keys(patch).length === 0) {
      close()
      return
    }
    setSaving(true)
    const ok = await useGoalsStore.getState().set(patch)
    setSaving(false)
    if (ok) {
      touched.current = false
      toast.success('Goals saved.')
      close()
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    }
  }

  const pace = status ? paceLine(status) : null
  const perHour = status ? wordsPerHour(status.session.words, status.session.activeMs) : null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-testid="goals-dialog"
        onKeyDown={onKeyDown}
        className="flex max-h-[90vh] w-[440px] max-w-[92vw] flex-col overflow-y-auto rounded-lg border border-line bg-surface-raised px-5 py-4 shadow-panel"
      >
        <h2 id={titleId} className="m-0 mb-3 text-lg font-semibold">
          Goals
        </h2>
        <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4">
          <section aria-label="Project goal" className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Project</h3>
            <div className="flex gap-3">
              <label className="flex flex-1 flex-col gap-1 text-xs text-fg-muted">
                Project target (words)
                <input
                  ref={first}
                  inputMode="numeric"
                  value={draft.projectTarget}
                  placeholder="e.g. 80,000"
                  aria-invalid={projectError !== null}
                  onChange={(e) => edit('projectTarget', e.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
              <label className="flex flex-1 flex-col gap-1 text-xs text-fg-muted">
                Deadline
                <input
                  type="date"
                  value={draft.deadline}
                  aria-invalid={deadlineError !== null}
                  onChange={(e) => edit('deadline', e.target.value)}
                  className={INPUT_CLASS}
                />
              </label>
            </div>
            {(projectError ?? deadlineError) ? (
              <p role="alert" className="m-0 text-xs text-danger">
                {projectError ?? deadlineError}
              </p>
            ) : null}
            {status ? (
              <>
                <p className="m-0 text-sm" data-testid="goals-project-words">
                  {status.goals.projectTarget !== null
                    ? `${status.manuscriptWords.toLocaleString()} / ${formatWords(status.goals.projectTarget)}`
                    : `${formatWords(status.manuscriptWords)} in the manuscript`}
                </p>
                {status.goals.projectTarget !== null ? (
                  <GoalBar
                    words={status.manuscriptWords}
                    target={status.goals.projectTarget}
                    label="Project progress"
                  />
                ) : null}
                {pace ? <p className="m-0 text-xs text-fg-muted">{pace}</p> : null}
              </>
            ) : null}
          </section>

          <section aria-label="Daily goal" className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold">Today</h3>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Daily target (words)
              <input
                inputMode="numeric"
                value={draft.dailyTarget}
                placeholder="e.g. 500"
                aria-invalid={dailyError !== null}
                onChange={(e) => edit('dailyTarget', e.target.value)}
                className={INPUT_CLASS}
              />
            </label>
            {dailyError ? (
              <p role="alert" className="m-0 text-xs text-danger">
                {dailyError}
              </p>
            ) : null}
            {status ? (
              <>
                <p className="m-0 text-sm" data-testid="goals-today-words">
                  {status.goals.dailyTarget !== null
                    ? `${status.today.words.toLocaleString()} / ${formatWords(status.goals.dailyTarget)} today`
                    : `${formatWords(status.today.words)} today`}
                </p>
                {status.goals.dailyTarget !== null ? (
                  <>
                    <GoalBar
                      words={status.today.words}
                      target={status.goals.dailyTarget}
                      label="Today's progress"
                    />
                    <p className="m-0 text-xs text-fg-muted" data-testid="goals-streak">
                      Streak: {formatDays(status.streak.current)} · best{' '}
                      {formatDays(status.streak.best)}
                    </p>
                  </>
                ) : null}
              </>
            ) : null}
          </section>

          {status ? (
            <section aria-label="This session" className="flex flex-col gap-1">
              <h3 className="m-0 text-sm font-semibold">This session</h3>
              <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
                <dt className="text-fg-muted">Writing time</dt>
                <dd className="m-0" data-testid="goals-session-time">
                  {formatActiveTime(status.session.activeMs)}
                </dd>
                <dt className="text-fg-muted">Words</dt>
                <dd className="m-0" data-testid="goals-session-words">
                  {status.session.words.toLocaleString()}
                </dd>
                <dt className="text-fg-muted">Words per hour</dt>
                <dd className="m-0" data-testid="goals-session-pace">
                  {perHour === null ? '—' : perHour.toLocaleString()}
                </dd>
              </dl>
            </section>
          ) : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={close}
              className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:bg-surface hover:text-fg"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={invalid || saving || !status}
              className="rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-accent-fg hover:bg-accent-hover disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
