import { useEffect, useState } from 'react'
import { combinedProgress, jobProgress } from './activityJobs'
import { useActivityStore } from './activityStore'

/** How often the estimated crawl is redrawn (the width eases between readings). */
const TICK_MS = 250

/** The clock, ticking while `on`; a still value otherwise. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    // The first reading may be stale by up to a tick; the crawl reads a negative time as 0.
    const timer = setInterval(() => setNow(Date.now()), TICK_MS)
    return () => clearInterval(timer)
  }, [on])
  return now
}

const percent = (value: number): number => Math.round(value * 100)

/**
 * The background activity bar (F-7.12): a hairline in the theme's accent drawn on the header's
 * bottom border (`placement="header"`, absolutely placed inside the header so nothing moves), or
 * along the top edge of the window in focus mode, where the header is hidden. Left is 0 %, right
 * 100 %: one combined bar for every long job running (the average of their progress), filled to
 * the end and faded out as the last one finishes. A pulse swims along it every few seconds
 * while anything runs (none with reduced motion). Hovering lists each job with its percentage.
 * Nothing renders while nothing runs.
 */
export function ActivityBar({
  placement
}: {
  placement: 'header' | 'window'
}): React.JSX.Element | null {
  const jobs = useActivityStore((s) => s.jobs)
  const timing = useActivityStore((s) => s.timing)
  const finishing = useActivityStore((s) => s.finishing)
  const now = useNow(jobs.length > 0)
  const [hover, setHover] = useState(false)
  if (jobs.length === 0 && finishing.length === 0) return null

  const rows = [
    ...jobs.map((job) => ({
      key: job.key,
      name: job.name,
      value: jobProgress(job, timing[job.key], now)
    })),
    ...finishing.map((job) => ({ key: job.key, name: job.name, value: 1 }))
  ]
  const running = jobs.length > 0
  const value = running ? combinedProgress(rows.map((row) => row.value)) : 1
  const label = rows.map((row) => `${row.name} ${percent(row.value)} %`).join(', ')

  return (
    <div
      data-testid="activity-bar"
      data-placement={placement}
      data-state={running ? 'running' : 'done'}
      className={`activity-bar ${placement === 'header' ? 'absolute inset-x-0 bottom-0 z-30' : 'fixed inset-x-0 top-0 z-50'}`}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div
        role="progressbar"
        aria-label={`Background work: ${label}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent(value)}
        className="activity-bar-track"
      >
        <div className="activity-bar-fill" style={{ width: `${value * 100}%` }}>
          {running ? <span className="activity-bar-pulse" aria-hidden="true" /> : null}
        </div>
      </div>
      {hover ? (
        <div
          role="tooltip"
          data-testid="activity-bar-tooltip"
          className="absolute top-full left-1/2 z-50 mt-1 -translate-x-1/2 rounded-md border border-line bg-surface-raised px-2 py-1 text-xs whitespace-nowrap shadow-panel"
        >
          {rows.map((row) => (
            <div key={row.key} className="flex justify-between gap-3">
              <span>{row.name}</span>
              <span className="text-fg-muted tabular-nums">{percent(row.value)} %</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
