import { progressRatio } from '@shared/goals'

/**
 * A thin progress bar toward a word target (F-10.3): the dialog, the status strip, and the tree
 * rows all draw this one. A met target fills with the success color. The fill width is the one
 * dynamic inline style.
 */
export function GoalBar({
  words,
  target,
  label,
  className = ''
}: {
  words: number
  target: number
  /** The accessible name of the progressbar. */
  label: string
  className?: string
}): React.JSX.Element {
  const ratio = progressRatio(words, target)
  const met = words >= target
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={target}
      aria-valuenow={Math.min(Math.max(0, words), target)}
      data-met={met ? 'true' : undefined}
      className={`h-1.5 overflow-hidden rounded-full bg-line ${className}`}
    >
      <div
        className={`h-full rounded-full ${met ? 'bg-success' : 'bg-accent'}`}
        style={{ width: `${ratio * 100}%` }}
      />
    </div>
  )
}
