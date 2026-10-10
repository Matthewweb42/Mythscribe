/**
 * The pause before a sheet's two views are made true to each other (F-9.18): one timer per sheet,
 * restarted by every edit of that sheet, so the sync runs only once the author has left that sheet
 * alone for `delayMs` (30 s in the app), however long they keep typing. Editing another sheet does
 * not hold this one back. Pure over injected timers, so the tests drive it with fake ones; the
 * timers are unref'd, so a pending sync never holds the app (or a test) open.
 */
export interface SheetSyncScheduler {
  /** The sheet was edited: (re)start its pause. */
  touch(entityId: string): void
  /** Forget one sheet's pause (it was synced now, or deleted). */
  cancel(entityId: string): void
  /** The project closed: drop every pause. */
  clear(): void
  /** The sheets whose pause is still running. */
  waiting(): string[]
}

export interface SheetSyncSchedulerOptions {
  delayMs: number
  /** The pause of this sheet is over. */
  onDue: (entityId: string) => void
  setTimer?: (run: () => void, ms: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

function unref(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  return timer
}

export function createSheetSyncScheduler(options: SheetSyncSchedulerOptions): SheetSyncScheduler {
  const setTimer = options.setTimer ?? ((run, ms) => unref(setTimeout(run, ms)))
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer))
  const timers = new Map<string, ReturnType<typeof setTimeout>>()

  const cancel = (entityId: string): void => {
    const timer = timers.get(entityId)
    if (timer !== undefined) {
      clearTimer(timer)
      timers.delete(entityId)
    }
  }

  return {
    touch(entityId) {
      cancel(entityId)
      timers.set(
        entityId,
        setTimer(() => {
          timers.delete(entityId)
          options.onDue(entityId)
        }, options.delayMs)
      )
    },
    cancel,
    clear() {
      for (const timer of timers.values()) clearTimer(timer)
      timers.clear()
    },
    waiting() {
      return [...timers.keys()]
    }
  }
}
