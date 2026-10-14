import { isFeatureAllowed } from '@shared/aiSettings'
import type { Entity } from '@shared/ipc/contract'
import { SHEET_SYNC_DELAY_MS, type SheetSyncStatus } from '@shared/sheetSync'
import type { EntityDb } from '../entity/entityStore'
import { createSheetSyncScheduler } from '../entity/sheetSyncScheduler'
import { AppError } from '../ipc/errors'
import { createIndexQueue, failureOf } from '../jobs/indexQueue'
import { getAiSettings, getSheetSyncDue, setSheetSyncDue } from '../project/settingsStore'
import { manuscriptRootId } from '../voice/voiceJob'
import { AiCancelledError } from './providers/types'
import type { AiRequestDeps } from './request'
import { runSheetSync, sheetNeedsSync } from './sheetSync'

/**
 * The sheet sync's scheduling (F-9.18): the 30-second pause per sheet (`sheetSyncScheduler`), the
 * due list (a settings row, so a quit resumes it), and the `sheetSync` job of the F-5.13 queue
 * (one per project, keyed to the manuscript root) that works the due sheets one by one, never
 * blocking typing. Nothing is scheduled while Use AI or the toggle is off or no provider is set
 * up: the sheet then shows it is out of date instead. Each sheet's status (waiting, running,
 * failed with its cause and next step) is held here and pushed whole on every move.
 */
export interface SheetSyncService {
  /** The author edited the sheet's fields or page: restart its pause. */
  touch(entityId: string): void
  /** Write up now / File now / Try again: skip the pause. False when there is nothing to do or AI is off. */
  runNow(entityId: string): boolean
  statuses(): SheetSyncStatus[]
  /** A project opened: take up the job it left behind. */
  load(): void
  /**
   * F-16.31: holds the sync through the switch-over (`IndexQueue.hold`): no sheet is written and a
   * sheet whose pause ends waits off the due list (a settings row) until `release`. Answers once
   * the run in flight, if any, has ended.
   */
  hold(): Promise<void>
  /** Lets a held sync go: the sheets whose pause ended meanwhile join the due list now. */
  release(): void
  /** The project closed: drop every pause, status, hold, and run. */
  clear(): void
}

export interface SheetSyncServiceOptions {
  db: () => EntityDb | null
  request: (db: EntityDb) => AiRequestDeps
  /** A provider is set up and the app may write (the trial). */
  ready: (db: EntityDb) => boolean
  cancelRequest: (requestId: string) => void
  onStatuses: (statuses: SheetSyncStatus[]) => void
  onEntity: (entity: Entity) => void
  onChangesLogged: () => void
  delayMs?: number
  now?: () => Date
}

export function createSheetSyncService(options: SheetSyncServiceOptions): SheetSyncService {
  const now = options.now ?? (() => new Date())
  const statuses = new Map<string, SheetSyncStatus>()
  const publish = (): void => options.onStatuses([...statuses.values()])
  const setStatus = (status: SheetSyncStatus): void => {
    statuses.set(status.entityId, status)
    publish()
  }
  const dropStatus = (entityId: string): void => {
    if (statuses.delete(entityId)) publish()
  }
  const allowed = (db: EntityDb): boolean =>
    isFeatureAllowed(getAiSettings(db), 'sheetSync') && options.ready(db)

  const queueDue = (db: EntityDb, entityId: string): void => {
    setSheetSyncDue(db, [...getSheetSyncDue(db).filter((id) => id !== entityId), entityId])
    const root = manuscriptRootId(db)
    if (root !== null) queue.touch('sheetSync', root)
  }

  /** `hold()`: the sheets whose pause ended while held, joined to the due list on `release`. */
  let held = false
  const heldDue = new Set<string>()

  const onDue = (entityId: string): void => {
    if (held) {
      heldDue.add(entityId)
      return
    }
    const db = options.db()
    if (db === null) return
    if (!allowed(db)) {
      dropStatus(entityId)
      return
    }
    queueDue(db, entityId)
  }

  const scheduler = createSheetSyncScheduler({
    delayMs: options.delayMs ?? SHEET_SYNC_DELAY_MS,
    onDue
  })

  /** Works the due list, oldest first, until it is empty; a cancel leaves the rest for the next run. */
  const runDue = async (requestId: string): Promise<{ requested: boolean; value: number }> => {
    let requested = false
    let done = 0
    for (;;) {
      const db = options.db()
      if (db === null) break
      const due = getSheetSyncDue(db)
      const entityId = due[0]
      if (entityId === undefined) break
      if (!allowed(db)) {
        // AI went off meanwhile: the sheets wait, out of date, until the author's next edit.
        setSheetSyncDue(db, [])
        for (const id of due) statuses.delete(id)
        publish()
        break
      }
      setStatus({ entityId, phase: 'running', failure: null })
      try {
        const result = await runSheetSync(db, options.request(db), { entityId, requestId })
        requested ||= result.requested
        if (result.entity !== null) options.onEntity(result.entity)
        if (result.logged) options.onChangesLogged()
        dropStatus(entityId)
      } catch (err) {
        if (err instanceof AiCancelledError) {
          dropStatus(entityId)
          throw err
        }
        if (err instanceof AppError && err.code === 'NOT_FOUND') dropStatus(entityId)
        else setStatus({ entityId, phase: 'failed', failure: failureOf(err) })
      }
      setSheetSyncDue(
        db,
        getSheetSyncDue(db).filter((id) => id !== entityId)
      )
      done++
    }
    return { requested, value: done }
  }

  const queue = createIndexQueue<number>({
    kind: 'sheetSync',
    db: options.db,
    run: (_job, requestId) => runDue(requestId),
    cancelRequest: options.cancelRequest,
    now,
    debounceMs: 0,
    minIntervalMs: 0
  })

  const runNow = (entityId: string): boolean => {
    const db = options.db()
    if (db === null || !allowed(db) || !sheetNeedsSync(db, entityId)) return false
    scheduler.cancel(entityId)
    setStatus({ entityId, phase: 'waiting', failure: null })
    queueDue(db, entityId)
    return true
  }

  return {
    touch(entityId) {
      const db = options.db()
      if (db === null || !allowed(db)) return
      scheduler.touch(entityId)
      setStatus({ entityId, phase: 'waiting', failure: null })
    },

    runNow,

    statuses() {
      return [...statuses.values()]
    },

    load() {
      queue.load()
    },

    hold() {
      held = true
      return queue.hold()
    },

    release() {
      if (!held) return
      held = false
      const due = [...heldDue]
      heldDue.clear()
      for (const entityId of due) onDue(entityId)
      queue.release()
    },

    clear() {
      held = false
      heldDue.clear()
      scheduler.clear()
      queue.clear()
      if (statuses.size > 0) {
        statuses.clear()
        publish()
      }
    }
  }
}
