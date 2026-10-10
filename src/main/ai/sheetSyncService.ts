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
import { applyHeldSheetSync, dismissHeldSheetSync, runSheetSync, sheetNeedsSync } from './sheetSync'

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
  /** Applies the held sync; a filing that leaves the page out of date queues its write-up. */
  apply(entityId: string): Entity
  dismiss(entityId: string): Entity
  statuses(): SheetSyncStatus[]
  /** A project opened: take up the job it left behind. */
  load(): void
  /** The project closed: drop every pause, status, and run. */
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

  const scheduler = createSheetSyncScheduler({
    delayMs: options.delayMs ?? SHEET_SYNC_DELAY_MS,
    onDue: (entityId) => {
      const db = options.db()
      if (db === null) return
      if (!allowed(db)) {
        dropStatus(entityId)
        return
      }
      queueDue(db, entityId)
    }
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

    apply(entityId) {
      const db = options.db()
      if (db === null) throw new AppError('NOT_FOUND', 'No project is open', { id: entityId })
      let applied: ReturnType<typeof applyHeldSheetSync>
      try {
        applied = applyHeldSheetSync(db, entityId, now())
      } catch (err) {
        // The sheet moved since the held sync was made: bring it up to date again.
        if (err instanceof AppError && err.code === 'VALIDATION') runNow(entityId)
        throw err
      }
      options.onChangesLogged()
      if (applied.pageStaleAfter) runNow(entityId)
      return applied.entity
    },

    dismiss(entityId) {
      const db = options.db()
      if (db === null) throw new AppError('NOT_FOUND', 'No project is open', { id: entityId })
      return dismissHeldSheetSync(db, entityId)
    },

    statuses() {
      return [...statuses.values()]
    },

    load() {
      queue.load()
    },

    clear() {
      scheduler.clear()
      queue.clear()
      if (statuses.size > 0) {
        statuses.clear()
        publish()
      }
    }
  }
}
