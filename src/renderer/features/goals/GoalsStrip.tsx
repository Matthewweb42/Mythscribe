import { Target } from 'lucide-react'
import { GoalBar } from './GoalBar'
import { useGoalsStore } from './goalsStore'

/**
 * The goals in the status bar (F-10.3): today's words against the daily target, the current
 * streak, and a thin bar toward the project target. A click opens the Goals dialog. Renders
 * nothing until the status has loaded.
 */
export function GoalsStrip(): React.JSX.Element | null {
  const status = useGoalsStore((s) => s.status)
  const show = useGoalsStore((s) => s.show)
  if (!status) return null
  const { goals, today, streak, manuscriptWords } = status
  return (
    <button
      type="button"
      onClick={show}
      data-testid="status-goals"
      title="Goals"
      className="flex items-center gap-2 rounded px-1 text-xs text-fg-muted hover:bg-surface-raised hover:text-fg"
    >
      <Target size={12} aria-hidden="true" />
      <span data-testid="status-goals-today">
        {goals.dailyTarget !== null
          ? `Today ${today.words.toLocaleString()} / ${goals.dailyTarget.toLocaleString()}`
          : `Today ${today.words.toLocaleString()}`}
      </span>
      {goals.dailyTarget !== null && streak.current > 0 ? (
        <span data-testid="status-goals-streak">{streak.current}-day streak</span>
      ) : null}
      {goals.projectTarget !== null ? (
        <GoalBar
          words={manuscriptWords}
          target={goals.projectTarget}
          label="Project progress"
          className="w-16"
        />
      ) : null}
    </button>
  )
}
