/**
 * The one timer seam in main: services take a `Schedule` instead of calling `setTimeout`, so
 * their tests run the callbacks themselves and no test waits on a clock. The account poll
 * (F-15.2) and the update check (F-15.7) both use it.
 */

/** Starts a timer and answers its canceller; injectable so tests run the callbacks themselves. */
export type Schedule = (run: () => void, ms: number) => () => void

export const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  // A pending run must never hold the app (or a test) open.
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  return () => clearTimeout(timer)
}
