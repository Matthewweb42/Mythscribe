import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm'
import {
  HOSTED_DEFAULT_MODELS,
  OPENROUTER_DEFAULT_MODELS,
  aiFailure,
  type AiProviderId
} from '@shared/ai'
import { isFeatureAllowed, type AiSettings } from '@shared/aiSettings'
import type { PricingResult, CreditsResult } from '@shared/cloudApi'
import type { IndexQueueStatus, JobKind } from '@shared/jobs'
import type { CloudCapState } from '@shared/memory/cloudCap'
import { modelHealth, probeDue } from '@shared/memory/health'
import { SPOT_EVERY } from '@shared/memory/spot'
import type { RebuildEstimate } from '@shared/memory/switchover'
import type {
  MemoryHealthReport,
  MemoryNotice,
  MemoryNoticeAction,
  MemoryPause,
  MemoryStatus,
  ReadNowResult,
  RebuildAction,
  RebuildStartResult,
  RebuildSummary,
  SettleResult
} from '@shared/memory/views'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import {
  addCloudSpend,
  allowMore,
  capNoticeDue,
  capReached,
  cloudCapState,
  cloudLimit,
  markCapNotice,
  monthOf,
  reconcileTally,
  setCap,
  type MemoryCloudState
} from '../../ai/cloudTally'
import { assertFeatureAllowed } from '../../ai/dial'
import { registerInflight, releaseInflight } from '../../ai/inflight'
import { AiDisabledError, AiProviderError } from '../../ai/providers/types'
import type { AiRequestDeps } from '../../ai/request'
import { aiUsage, reading } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import { createIndexQueue, type JobRun } from '../../jobs/indexQueue'
import { deleteAllJobs, listJobs } from '../../jobs/jobStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptRootId } from '../../voice/voiceJob'
import { getRecord } from '../recordStore'
import {
  BACKFILL_UNASKED_PAGES,
  backfillPlan,
  noteLateNames,
  openBackfills,
  setBackfillState
} from './backfill'
import {
  BACKLOG_UNASKED,
  draftEverRead,
  dueScenes,
  priceReads,
  rebuildEstimate,
  type DueScene
} from './backlog'
import { gateScene, runReading, type ReadingOutcome } from './pipeline'
import { recentReadings } from './readingStore'
import {
  getAsked,
  getHealthChoices,
  getSpotState,
  keepReading,
  setAsked
} from './readerRows'
import {
  applyRebuildAction,
  rebuildSceneDone,
  rebuildSummary,
  startRebuild,
  stopRebuild
} from './rebuild'
import { markRebuilt, pickStrongDue, runSpotChecks } from './spotChecks'
import type { RebuildContext } from '../switchover/plan'

/**
 * The reader service (F-16.16, F-16.17, F-16.19; plan P2a §3, rule 8): the one owner of story
 * memory v2's reading, so `handlers.ts` only registers channels and calls it.
 *
 * - **One provider-backed queue** (`createIndexQueue`, kinds `read`, `rebuild`, `spotCheck`,
 *   `backfill`): serial, rate-limited, persisted in `index_job`, paused on a hard failure. In a v2
 *   project it owns `jobs:changed` and `jobs:status|cancel|resume` (the summary queue does in v1).
 * - **Triggers**: *Read now* (ahead of the queue, asked); `settle` (the renderer's leave and idle
 *   triggers: the gate first, then a background job); the **backlog** after a write outside the
 *   editor (2 s later) and on every open (up to 5 scenes queued, more asked with the price; a draft
 *   never read is priced like *Rebuild memory*); the **back-fill** of late names (up to 3 pages,
 *   more asked); *Rebuild memory*; the spot checks after a rebuild and every 5 strong ones due.
 * - **Gates, in order, before any request**: Use AI and the **Story memory reading** switch; a
 *   provider (the request path's); then, for work nobody asked for, a local cut-off pause, the
 *   health gate (one probe read per 10 due scenes while a model is paused) and the Cloud monthly
 *   cap. A blocked job stays queued and the queue pauses on it (one notice), never a retry loop.
 * - **Spend**: every Cloud reading's reported cost goes into the app-wide monthly tally, as
 *   background or asked (P2a-D9); `/credits` raises it, never lowers it (P2a-D10).
 * - **Pushes**: `memory:changed` after a reading, `memory:statusChanged` and
 *   `memory:noticesChanged` when they move, `jobs:changed` for the indicator.
 */

/** Where a project's requests go now, as the gates read it; null when none can answer. */
export interface ReaderProvider {
  id: AiProviderId
  fastModel: string
  strongModel: string
}

export interface ReaderServiceDeps {
  /** The open project's database, or null when none is open. */
  db: () => TreeDb | null
  /** The open project's story memory, or null when none is open. */
  memory: () => StoryMemoryVersion | null
  settings: (db: TreeDb) => AiSettings
  requestDeps: (db: TreeDb) => AiRequestDeps
  provider: (db: TreeDb) => ReaderProvider | null
  /** The hosted price table (Cloud prices), null until fetched. */
  pricing: () => PricingResult | null
  /** The app-wide Cloud tally (`app-state.json`'s `memoryCloud`). */
  cloud: {
    get: () => MemoryCloudState
    update: (fn: (state: MemoryCloudState) => MemoryCloudState) => MemoryCloudState
  }
  /** `/credits`, to reconcile the tally on Cloud now and then; absent without an account. */
  credits?: () => Promise<CreditsResult>
  /** Points the fast tier at DeepSeek V4 Flash (the health notice's *Switch*). */
  useFlash?: (provider: AiProviderId) => void
  cancelRequest: (requestId: string) => void
  now?: () => Date
  /** `memory:changed` for these scenes and records. */
  changed: (payload: { nodeIds: string[]; recordIds: string[] }) => void
  /** The name questions may have moved (facts waiting on a new name). */
  questions: () => void
  status: (status: MemoryStatus) => void
  notices: (notices: MemoryNotice[]) => void
  /** `jobs:changed` (only while a v2 project is open). */
  jobs: (status: IndexQueueStatus) => void
  /** The developer tools' log: a strong spot check's deletion (never the claim's text). */
  log?: (message: string) => void
  /** The queue's rate limit; tests pass 0. */
  minIntervalMs?: number
  /** The pause after a write outside the editor before the backlog check (2 s). */
  backlogDelayMs?: number
}

export interface SettleInput {
  nodeId: string
  reason: 'leave' | 'idle'
  caretPara: number | null
}

export interface ReaderService {
  readNow(nodeId: string, requestId: string): Promise<ReadNowResult>
  settle(input: SettleInput): SettleResult
  /** A write outside the editor (Replace, a revert, a draft switch, the chat's bulk tools). */
  bulkWritten(): void
  /** A v2 project opened: its leftover jobs, the backlog, the back-fills. */
  opened(): void
  /** The AI settings, the key or the source changed: a pause the change may have fixed lifts. */
  settingsChanged(): void
  /** A record was made, or given nicknames: the back-fill of scenes read before. */
  namesAdded(recordId: string, names: readonly string[]): void
  status(): MemoryStatus
  notices(): MemoryNotice[]
  answerNotice(id: string, action: MemoryNoticeAction): MemoryNotice[]
  health(): MemoryHealthReport
  rebuildEstimate(): RebuildEstimate
  rebuild(): RebuildStartResult
  rebuildSummary(): RebuildSummary | null
  rebuildAction(action: RebuildAction): { changed: number }
  cloudCap(): CloudCapState
  setCloudCap(capUsd: number): CloudCapState
  /** `/credits` answered: the tally is raised to the server's reading spend. */
  reconcileCloud(credits: CreditsResult): void
  queueStatus(): IndexQueueStatus
  cancelAll(): IndexQueueStatus
  resume(): IndexQueueStatus
  /** The project closed or changed: every timer, pause and notice of the one that left goes. */
  clear(): void
}

/** A job's work, as the queue hands it back. */
interface ReaderValue {
  outcome: ReadingOutcome | null
}

/** Background reading paused by a gate the author can lift (health, the Cloud cap, a cut-off). */
class ReadingPausedError extends AiDisabledError {
  constructor(
    readonly pause: Extract<MemoryPause, 'health' | 'cloudCap' | 'localCutoff'>,
    message: string
  ) {
    super(message)
  }
}

const READER_KINDS: readonly JobKind[] = ['read', 'rebuild', 'spotCheck', 'backfill']
/** How long after a write outside the editor the backlog is checked. */
export const BACKLOG_DELAY_MS = 2_000
/** How often, at most, the Cloud tally asks `/credits`. */
export const RECONCILE_EVERY_MS = 60 * 60 * 1000

const NO_STATUS: MemoryStatus = { lastRead: null, paused: null, todayUsd: 0, cloud: null }

/** The start of the local day of `now`, as an ISO string (the footer's "today"). */
function startOfDay(now: Date): string {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString()
}

export function createReaderService(deps: ReaderServiceDeps): ReaderService {
  const now = deps.now ?? ((): Date => new Date())
  const v2Db = (): TreeDb | null => (deps.memory() === 'v2' ? deps.db() : null)
  const requireDb = (): TreeDb => {
    const db = v2Db()
    if (db === null) throw new AppError('NO_PROJECT', 'No story memory v2 project is open')
    return db
  }

  /** Read now's scenes, asked and gated only by Use AI and the switch. */
  const askedNow = new Set<string>()
  /** Scenes the health gate let through as a probe. */
  const probes = new Set<string>()
  /** The idle trigger's caret paragraph per queued scene (P2a-D6). */
  const carets = new Map<string, number>()
  /** Due scenes skipped while the health gate pauses, toward the next probe. */
  let skipped = 0
  let localCutoff: string | null = null
  /** The stored notices (the health and Cloud cap ones are computed). */
  const stored = new Map<string, MemoryNotice>()
  /** The scenes a backlog or draft-unread notice offers to read. */
  let offered: DueScene[] = []
  /** Health notices closed this session, by model. */
  const closedHealth = new Set<string>()
  let backlogTimer: ReturnType<typeof setTimeout> | null = null
  let lastStatus: string | null = null
  let lastNotices: string | null = null
  let lastReconcile = 0
  let probeCounter = 0

  const queue = createIndexQueue<ReaderValue>({
    kind: READER_KINDS,
    db: v2Db,
    run: (job, requestId) => runJob(job.kind, job.nodeId, requestId),
    cancelRequest: deps.cancelRequest,
    now,
    // `jobs:changed` is the reader's only in a v2 project (the summary queue's in v1).
    onChange: (status) => {
      if (deps.memory() === 'v2') deps.jobs(status)
      publish()
    },
    debounceMs: 0,
    ...(deps.minIntervalMs === undefined ? {} : { minIntervalMs: deps.minIntervalMs }),
    requestIdFor: (n) => `reader-${n}`
  })

  // ---- Gates -------------------------------------------------------------------------------

  /** Use AI, the reading switch and a provider: whether reading may run at all. */
  const readingAllowed = (db: TreeDb): boolean => {
    const settings = deps.settings(db)
    return (
      isFeatureAllowed(settings, 'reader') &&
      isFeatureAllowed(settings, 'verify') &&
      deps.provider(db) !== null
    )
  }

  /** Whether the health gate pauses this model's background reading (and the author did not overrule it). */
  const healthPaused = (db: TreeDb, model: string): boolean => {
    if (model === '' || getHealthChoices(db).keep.includes(model)) return false
    return modelHealth(recentReadings(db, model).map((each) => each.yields)).paused
  }

  const month = (): string => monthOf(now())

  /** What holds unasked work back now, or null. */
  const backgroundBlock = (
    db: TreeDb
  ): Extract<MemoryPause, 'health' | 'cloudCap' | 'localCutoff'> | null => {
    if (localCutoff !== null) return 'localCutoff'
    const provider = deps.provider(db)
    if (provider === null) return null
    if (healthPaused(db, provider.fastModel)) return 'health'
    if (provider.id === 'cloud' && capReached(deps.cloud.get(), month())) return 'cloudCap'
    return null
  }

  /** The gates before a job's requests (see the module comment); throws to keep the job queued. */
  const gate = (db: TreeDb, asked: boolean, probe: boolean): void => {
    const settings = deps.settings(db)
    assertFeatureAllowed(settings, 'reader')
    assertFeatureAllowed(settings, 'verify')
    if (asked) return
    const block = backgroundBlock(db)
    if (block === null || (block === 'health' && probe)) return
    const message =
      block === 'health'
        ? 'Story memory paused: this model’s readings aren’t reliable enough.'
        : block === 'cloudCap'
          ? 'Background reading reached your Cloud cap for this month.'
          : 'Story memory paused: the local model stopped answering at its limit.'
    throw new ReadingPausedError(block, message)
  }

  // ---- Spend --------------------------------------------------------------------------------

  const isCloud = (db: TreeDb): boolean => deps.provider(db)?.id === 'cloud'

  /** A Cloud request's reported cost into the month's tally; now and then, `/credits` too. */
  const tally = (db: TreeDb, usd: number, asked: boolean): void => {
    if (!isCloud(db)) return
    if (usd > 0) deps.cloud.update((state) => addCloudSpend(state, { usd, asked }, month()))
    if (deps.credits !== undefined && now().getTime() - lastReconcile > RECONCILE_EVERY_MS) {
      lastReconcile = now().getTime()
      void deps
        .credits()
        .then((credits) => service.reconcileCloud(credits))
        .catch(() => undefined)
    }
  }

  // ---- Status and notices -------------------------------------------------------------------

  const pauseOf = (db: TreeDb): MemoryPause | null => {
    const settings = deps.settings(db)
    if (!isFeatureAllowed(settings, 'reader') || !isFeatureAllowed(settings, 'verify')) return 'off'
    if (deps.provider(db) === null) return 'noProvider'
    const queued = queue.status().paused
    if (queued !== null && queued.code !== 'DISABLED') {
      return queued.code === 'BUDGET' ? 'dailyCap' : 'noProvider'
    }
    return backgroundBlock(db)
  }

  const computeStatus = (): MemoryStatus => {
    const db = v2Db()
    if (db === null) return NO_STATUS
    const draftId = currentDraftId(db)
    const newest =
      draftId === null
        ? undefined
        : db
            .select({ nodeId: reading.nodeId, created: reading.created })
            .from(reading)
            .where(eq(reading.draftId, draftId))
            .orderBy(desc(reading.created), sql`rowid DESC`)
            .get()
    // Today's reading spend from the ledger: readings, their checks and the spot checks.
    const today = db
      .select({ usd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)` })
      .from(aiUsage)
      .where(
        and(gte(aiUsage.at, startOfDay(now())), inArray(aiUsage.feature, ['reader', 'verify']))
      )
      .get()
    const provider = deps.provider(db)
    const cloud = deps.cloud.get()
    return {
      lastRead: newest === undefined ? null : { nodeId: newest.nodeId, at: newest.created },
      paused: pauseOf(db),
      todayUsd: today?.usd ?? 0,
      cloud:
        provider?.id === 'cloud'
          ? {
              spentUsd: cloudCapState(cloud, month()).backgroundUsd,
              capUsd: cloudLimit(cloud, month())
            }
          : null
    }
  }

  const computeNotices = (): MemoryNotice[] => {
    const db = v2Db()
    if (db === null) return []
    const list = [...stored.values()]
    const provider = deps.provider(db)
    if (provider !== null && readingAllowed(db)) {
      const model = provider.fastModel
      if (healthPaused(db, model) && !closedHealth.has(model)) {
        const health = modelHealth(recentReadings(db, model).map((each) => each.yields))
        const flash =
          provider.id === 'openrouter'
            ? OPENROUTER_DEFAULT_MODELS.fast
            : provider.id === 'cloud'
              ? HOSTED_DEFAULT_MODELS.fast
              : null
        list.push({
          id: `health:${model}`,
          kind: 'health',
          model,
          quotes: health.quotes,
          verified: health.verified,
          switchable: flash !== null && flash !== model
        })
      }
      const cloud = deps.cloud.get()
      if (provider.id === 'cloud' && capReached(cloud, month()) && capNoticeDue(cloud, month())) {
        list.push({
          id: `cloudCap:${month()}`,
          kind: 'cloudCap',
          month: month(),
          capUsd: cloudLimit(cloud, month())
        })
      }
    }
    return list
  }

  /** Pushes the status and the notices when they moved (a v2 project only). */
  function publish(): void {
    if (v2Db() === null) return
    const status = computeStatus()
    const statusJson = JSON.stringify(status)
    if (statusJson !== lastStatus) {
      lastStatus = statusJson
      deps.status(status)
    }
    const notices = computeNotices()
    const noticesJson = JSON.stringify(notices)
    if (noticesJson !== lastNotices) {
      lastNotices = noticesJson
      deps.notices(notices)
    }
  }

  const rebuildContext = (db: TreeDb): RebuildContext => {
    const provider = deps.provider(db)
    return {
      source: deps.settings(db).source,
      fastModel: provider?.fastModel ?? '',
      strongModel: provider?.strongModel ?? '',
      pricing: deps.pricing()
    }
  }

  // ---- Queueing -----------------------------------------------------------------------------

  /**
   * Queues a scene's reading nobody asked for, unless a gate holds unasked work back: then the
   * scene stays unread (read when it is next left), and the health gate lets one in 10 through.
   */
  const queueBackground = (db: TreeDb, nodeId: string, caretPara: number | null): boolean => {
    const block = backgroundBlock(db)
    if (block === 'health') {
      if (!probeDue(skipped)) {
        skipped += 1
        return false
      }
      skipped = 0
      probes.add(nodeId)
      probeCounter += 1
      // Ahead of the paused queue; whatever it throws is the queue's to record.
      void queue.runNow('read', nodeId, `reader-probe-${probeCounter}`).catch(() => undefined)
      return true
    }
    if (block !== null) return false
    if (caretPara === null) carets.delete(nodeId)
    else carets.set(nodeId, caretPara)
    queue.indexAll('read', [nodeId])
    return true
  }

  /** Queues every scene of `scenes` as asked (a priced backlog the author confirmed). */
  const queueAsked = (db: TreeDb, nodeIds: readonly string[]): void => {
    const asked = getAsked(db)
    for (const id of nodeIds) asked.add(id)
    setAsked(db, asked)
    queue.indexAll('read', [...nodeIds])
  }

  const root = (db: TreeDb): string | null => manuscriptRootId(db)

  /** The backlog check (plan P2a §3.3): ≤5 scenes queued, more asked with the price. */
  const checkBacklog = (): void => {
    const db = v2Db()
    if (db === null || !readingAllowed(db)) return
    const waiting = new Set(
      listJobs(db, ['read', 'rebuild'])
        .filter((job) => job.status === 'queued')
        .map((job) => job.nodeId)
    )
    const due = dueScenes(db).filter((scene) => !waiting.has(scene.nodeId))
    stored.delete('backlog')
    stored.delete('draftUnread')
    offered = []
    if (due.length > BACKLOG_UNASKED) {
      offered = due
      const draftId = currentDraftId(db) ?? ''
      if (!draftEverRead(db, draftId)) {
        stored.set('draftUnread', {
          id: 'draftUnread',
          kind: 'draftUnread',
          draftId,
          scenes: due.length,
          priceUsd: rebuildEstimate(db, rebuildContext(db)).costUsd
        })
      } else {
        stored.set('backlog', {
          id: 'backlog',
          kind: 'backlog',
          scenes: due.length,
          priceUsd: priceReads(due, rebuildContext(db)).costUsd
        })
      }
    } else {
      for (const scene of due) queueBackground(db, scene.nodeId, null)
    }
    publish()
  }

  /** The back-fills: ≤3 pages queued, more asked with the price (plan P2a §3.4). */
  const checkBackfill = (): void => {
    const db = v2Db()
    if (db === null) return
    const open = openBackfills(db)
    const byRecord = new Map<string, { due: number; asked: boolean }>()
    for (const row of open) {
      const entry = byRecord.get(row.recordId) ?? { due: 0, asked: false }
      if (row.state === 'due') entry.due += row.pages
      else entry.asked = true
      byRecord.set(row.recordId, entry)
    }
    let queueIt = false
    for (const [recordId, entry] of byRecord) {
      const id = `backfill:${recordId}`
      if (entry.asked) queueIt = true
      if (entry.due === 0) {
        stored.delete(id)
        continue
      }
      if (entry.due <= BACKFILL_UNASKED_PAGES) {
        stored.delete(id)
        queueIt = true
        continue
      }
      stored.set(id, {
        id,
        kind: 'backfill',
        recordId,
        name: getRecord(db, recordId)?.name ?? '',
        pages: entry.due,
        priceUsd: priceReads(
          Array.from({ length: entry.due }, () => ({ read: 'window' as const, proseTokens: 0 })),
          rebuildContext(db)
        ).costUsd
      })
    }
    const at = root(db)
    if (queueIt && at !== null && readingAllowed(db)) queue.indexAll('backfill', [at])
    publish()
  }

  /** The backlog check, once a burst of writes (or an open) has settled. */
  function scheduleBacklog(): void {
    if (v2Db() === null) return
    if (backlogTimer !== null) clearTimeout(backlogTimer)
    backlogTimer = setTimeout(() => {
      backlogTimer = null
      checkBacklog()
    }, deps.backlogDelayMs ?? BACKLOG_DELAY_MS)
    if (typeof backlogTimer === 'object' && typeof backlogTimer.unref === 'function') {
      backlogTimer.unref()
    }
  }

  // ---- Runs ---------------------------------------------------------------------------------

  /** What follows a reading: the tally, the pushes, the health notice, the spot checks. */
  const afterReading = (
    db: TreeDb,
    nodeId: string,
    outcome: ReadingOutcome,
    asked: boolean
  ): void => {
    if (!outcome.read) {
      if (outcome.reason !== 'localCutoff') return
      tally(db, outcome.costUsd, asked)
      localCutoff = outcome.model
      stored.set('localCutoff', { id: 'localCutoff', kind: 'localCutoff', model: outcome.model })
      publish()
      if (!asked) {
        throw new ReadingPausedError(
          'localCutoff',
          'Story memory paused: the local model stopped answering at its limit.'
        )
      }
      return
    }
    tally(db, outcome.costUsd, asked)
    deps.changed({ nodeIds: [nodeId], recordIds: outcome.recordIds })
    if (outcome.names.length > 0) deps.questions()
    const at = root(db)
    if (pickStrongDue(db, outcome.inserted) && at !== null) queue.indexAll('spotCheck', [at])
    if (offered.some((scene) => scene.nodeId === nodeId)) {
      offered = offered.filter((scene) => scene.nodeId !== nodeId)
      const notice = stored.get('backlog')
      if (notice?.kind === 'backlog') {
        if (offered.length === 0) stored.delete('backlog')
        else {
          stored.set('backlog', {
            ...notice,
            scenes: offered.length,
            priceUsd: priceReads(offered, rebuildContext(db)).costUsd
          })
        }
      }
    }
    publish()
  }

  const withSignal = async <T>(
    requestId: string,
    work: (signal: AbortSignal) => Promise<T>
  ): Promise<T> => {
    const controller = registerInflight(requestId)
    try {
      return await work(controller.signal)
    } finally {
      releaseInflight(requestId)
    }
  }

  const requested = (outcome: ReadingOutcome): boolean => outcome.read || 'costUsd' in outcome

  async function runRead(db: TreeDb, nodeId: string, requestId: string): Promise<JobRun<ReaderValue>> {
    const askedRows = getAsked(db)
    const asked = askedNow.has(nodeId) || askedRows.has(nodeId)
    const probe = probes.has(nodeId)
    gate(db, asked, probe)
    const caretPara = asked ? null : (carets.get(nodeId) ?? null)
    const outcome = await withSignal(requestId, (signal) =>
      runReading(
        db,
        { ai: deps.requestDeps(db) },
        {
          nodeId,
          caretPara,
          requestId,
          signal,
          ...(probe ? { purpose: 'probe' as const } : {}),
          spotEvery: getSpotState(db).rebuiltAt === null ? null : SPOT_EVERY
        }
      )
    )
    carets.delete(nodeId)
    probes.delete(nodeId)
    if (askedRows.delete(nodeId)) setAsked(db, askedRows)
    afterReading(db, nodeId, outcome, asked)
    return { requested: requested(outcome), value: { outcome } }
  }

  async function runRebuildScene(
    db: TreeDb,
    nodeId: string,
    requestId: string
  ): Promise<JobRun<ReaderValue>> {
    gate(db, true, false)
    const outcome = await withSignal(requestId, (signal) =>
      runReading(
        db,
        { ai: deps.requestDeps(db) },
        { nodeId, caretPara: null, requestId, signal, purpose: 'rebuild' }
      )
    )
    afterReading(db, nodeId, outcome, true)
    const remaining = listJobs(db, 'rebuild').filter(
      (job) => job.status === 'queued' && job.nodeId !== nodeId
    ).length
    const at = root(db)
    if (rebuildSceneDone(db, now(), remaining) && at !== null) {
      // The rebuild's spot checks, then 1 in 20 from now on (P2a-D8).
      markRebuilt(db, now())
      queue.indexAll('spotCheck', [at])
    }
    publish()
    return { requested: requested(outcome), value: { outcome } }
  }

  async function runSpot(db: TreeDb, requestId: string): Promise<JobRun<ReaderValue>> {
    // A rebuild's checks were priced with it: spent as asked.
    const asked = getSpotState(db).rebuildPass
    gate(db, asked, false)
    const run = await withSignal(requestId, (signal) =>
      runSpotChecks(db, { ai: deps.requestDeps(db) }, { requestId, signal })
    )
    tally(db, run.costUsd, asked)
    if (run.deleted.length > 0) {
      deps.log?.(
        `Story memory spot check: the strong model refused ${run.deleted.length} claim(s); deleted.`
      )
    }
    if (run.deleted.length > 0) deps.changed({ nodeIds: run.nodeIds, recordIds: run.recordIds })
    publish()
    return { requested: run.requested, value: { outcome: null } }
  }

  async function runBackfill(db: TreeDb, requestId: string): Promise<JobRun<ReaderValue>> {
    let sent = false
    await withSignal(requestId, async (signal) => {
      let n = 0
      for (const row of openBackfills(db)) {
        const asked = row.state === 'asked'
        // Over 3 pages, a back-fill waits for the author's answer.
        if (!asked && row.pages > BACKFILL_UNASKED_PAGES) continue
        gate(db, asked, false)
        for (const scene of backfillPlan(db, row.recordId, row.norm)) {
          n += 1
          const outcome = await runReading(
            db,
            { ai: deps.requestDeps(db) },
            {
              nodeId: scene.nodeId,
              caretPara: null,
              requestId: `${requestId}:b${n}`,
              signal,
              purpose: 'backfill',
              paras: scene.paras
            }
          )
          sent ||= requested(outcome)
          afterReading(db, scene.nodeId, outcome, asked)
        }
        setBackfillState(db, row.recordId, 'done', now(), row.norm)
      }
    })
    publish()
    return { requested: sent, value: { outcome: null } }
  }

  async function runJob(
    kind: JobKind,
    nodeId: string,
    requestId: string
  ): Promise<JobRun<ReaderValue>> {
    const db = requireDb()
    switch (kind) {
      case 'read':
        return runRead(db, nodeId, requestId)
      case 'rebuild':
        return runRebuildScene(db, nodeId, requestId)
      case 'spotCheck':
        return runSpot(db, requestId)
      case 'backfill':
        return runBackfill(db, requestId)
      default:
        // Not the reader's: never queued here (the queue sees only its own kinds).
        return { requested: false, value: { outcome: null } }
    }
  }

  // ---- The service --------------------------------------------------------------------------

  const service: ReaderService = {
    async readNow(nodeId, requestId) {
      const db = requireDb()
      try {
        const settings = deps.settings(db)
        assertFeatureAllowed(settings, 'reader')
        assertFeatureAllowed(settings, 'verify')
      } catch (err) {
        if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
        throw err
      }
      askedNow.add(nodeId)
      try {
        const { outcome } = await queue.runNow('read', nodeId, requestId)
        if (outcome === null) {
          return { ok: true, read: false, reason: 'upToDate', readingId: null, costUsd: 0 }
        }
        if (!outcome.read) {
          const paused = outcome.reason === 'localCutoff'
          return {
            ok: true,
            read: false,
            reason: paused ? 'paused' : outcome.reason,
            readingId: null,
            costUsd: paused ? outcome.costUsd : 0
          }
        }
        return {
          ok: true,
          read: true,
          reason: null,
          readingId: outcome.readingId,
          costUsd: outcome.costUsd
        }
      } catch (err) {
        if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
        throw err
      } finally {
        askedNow.delete(nodeId)
      }
    },

    settle({ nodeId, reason, caretPara }) {
      const db = requireDb()
      if (!readingAllowed(db)) return { queued: false, reason: 'off' }
      const caret = reason === 'idle' ? caretPara : null
      const gated = gateScene(db, nodeId, caret)
      if (gated === null) return { queued: false, reason: 'notReadable' }
      if (gated.decision.read === 'nothing') return { queued: false, reason: gated.decision.reason }
      const queued = queueBackground(db, nodeId, caret)
      publish()
      return queued ? { queued: true, reason: null } : { queued: false, reason: 'paused' }
    },

    bulkWritten: () => scheduleBacklog(),

    opened() {
      if (v2Db() === null) return
      queue.load()
      // The backlog walks every scene: a moment after the open, so the window's first reads
      // come first (a scene left unread at the last close is read now, P2a-D4).
      scheduleBacklog()
      checkBackfill()
      publish()
    },

    settingsChanged() {
      const db = v2Db()
      if (db === null) return
      if (queue.status().paused !== null && readingAllowed(db)) queue.resume()
      publish()
    },

    namesAdded(recordId, names) {
      const db = v2Db()
      if (db === null) return
      if (noteLateNames(db, recordId, names, now()).length > 0) checkBackfill()
    },

    status: () => computeStatus(),
    notices: () => computeNotices(),

    answerNotice(id, action) {
      const db = requireDb()
      const health = id.startsWith('health:') ? id.slice('health:'.length) : null
      if (health !== null) {
        if (action === 'keepReading') keepReading(db, health)
        if (action === 'switchModel') {
          const provider = deps.provider(db)
          if (provider !== null) deps.useFlash?.(provider.id)
        }
        if (action === 'dismiss') closedHealth.add(health)
        if (action !== 'dismiss') queue.resume()
      } else if (id.startsWith('cloudCap:')) {
        if (action === 'allowMore') {
          deps.cloud.update((state) => markCapNotice(allowMore(state, month()), month()))
          queue.resume()
        } else if (action === 'dismiss') {
          deps.cloud.update((state) => markCapNotice(state, month()))
        }
      } else {
        const notice = stored.get(id)
        if (notice !== undefined) {
          if (notice.kind === 'localCutoff' && action === 'keepReading') {
            localCutoff = null
            stored.delete(id)
            queue.resume()
          } else if (notice.kind === 'backlog') {
            if (action === 'read') queueAsked(db, offered.map((scene) => scene.nodeId))
            stored.delete(id)
            offered = []
          } else if (notice.kind === 'draftUnread') {
            // A draft never read is read as *Rebuild memory* (its price is the rebuild's).
            if (action === 'read') service.rebuild()
            stored.delete(id)
            offered = []
          } else if (notice.kind === 'backfill') {
            if (action === 'read') {
              setBackfillState(db, notice.recordId, 'asked', now())
              const at = root(db)
              if (at !== null) queue.indexAll('backfill', [at])
            } else if (action === 'later') {
              setBackfillState(db, notice.recordId, 'declined', now())
            }
            stored.delete(id)
          } else if (action === 'dismiss') {
            stored.delete(id)
          }
        }
      }
      publish()
      return computeNotices()
    },

    health() {
      const db = v2Db()
      const empty: MemoryHealthReport = {
        models: [],
        spot: { fast: { checked: 0, agreed: 0 }, strong: { checked: 0, agreed: 0 } },
        cutRate: 0
      }
      if (db === null) return empty
      const recent = db
        .select({ model: reading.model, finishReason: reading.finishReason })
        .from(reading)
        .orderBy(desc(reading.created), sql`rowid DESC`)
        .limit(100)
        .all()
      const keep = getHealthChoices(db).keep
      const models = [...new Set(recent.map((row) => row.model).filter((model) => model !== ''))]
      const spots = db.all<{ tier: string; spot: string; n: number }>(
        sql`SELECT spot_tier AS tier, spot, count(*) AS n FROM claim WHERE spot IS NOT NULL GROUP BY spot_tier, spot`
      )
      const count = (tier: string): { checked: number; agreed: number } => ({
        checked: spots.filter((row) => row.tier === tier).reduce((sum, row) => sum + row.n, 0),
        agreed: spots
          .filter((row) => row.tier === tier && row.spot === 'agree')
          .reduce((sum, row) => sum + row.n, 0)
      })
      return {
        models: models.map((model) => {
          const health = modelHealth(recentReadings(db, model).map((each) => each.yields))
          return {
            model,
            judged: health.judged,
            readings: health.readings,
            items: health.items,
            quotes: health.quotes,
            verified: health.verified,
            paused: health.paused,
            keepReading: keep.includes(model)
          }
        }),
        spot: { fast: count('fast'), strong: count('strong') },
        cutRate:
          recent.length === 0
            ? 0
            : recent.filter((row) => row.finishReason === 'length').length / recent.length
      }
    },

    rebuildEstimate() {
      const db = requireDb()
      return rebuildEstimate(db, rebuildContext(db))
    },

    rebuild() {
      const db = requireDb()
      try {
        const settings = deps.settings(db)
        assertFeatureAllowed(settings, 'reader')
        assertFeatureAllowed(settings, 'verify')
      } catch (err) {
        if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
        throw err
      }
      if (deps.provider(db) === null) {
        return aiFailure('NO_KEY', 'Story memory needs an AI provider to rebuild.')
      }
      const estimate = rebuildEstimate(db, rebuildContext(db))
      const { nodeIds } = startRebuild(db, now())
      // The rebuild replaces scene by scene: leftover reads of those scenes are its to do.
      queue.indexAll('rebuild', nodeIds)
      if (queue.status().paused !== null) queue.resume()
      publish()
      return { ok: true, queued: nodeIds.length, estimate }
    },

    rebuildSummary() {
      return rebuildSummary(requireDb())
    },

    rebuildAction(action) {
      const db = requireDb()
      const result = applyRebuildAction(db, action, now())
      if (result.nodeIds.length > 0 || result.recordIds.length > 0) {
        deps.changed({ nodeIds: result.nodeIds, recordIds: result.recordIds })
      }
      if (result.names) deps.questions()
      return { changed: result.changed }
    },

    cloudCap() {
      return cloudCapState(deps.cloud.get(), month())
    },

    setCloudCap(capUsd) {
      const next = deps.cloud.update((state) => setCap(state, capUsd, month()))
      const db = v2Db()
      if (db !== null && !capReached(next, month()) && queue.status().paused !== null) {
        queue.resume()
      }
      publish()
      return cloudCapState(next, month())
    },

    reconcileCloud(credits) {
      deps.cloud.update((state) => reconcileTally(state, credits, now()))
      publish()
    },

    queueStatus: () => queue.status(),

    cancelAll() {
      const db = v2Db()
      if (db !== null) {
        setAsked(db, new Set())
        // A stopped rebuild ends where it stood: each scene old or new (P2a-D25).
        stopRebuild(db, now())
      }
      carets.clear()
      probes.clear()
      return queue.cancelAll()
    },

    resume() {
      localCutoff = null
      stored.delete('localCutoff')
      const status = queue.resume()
      publish()
      return status
    },

    clear() {
      if (backlogTimer !== null) clearTimeout(backlogTimer)
      backlogTimer = null
      queue.clear()
      askedNow.clear()
      probes.clear()
      carets.clear()
      stored.clear()
      closedHealth.clear()
      offered = []
      skipped = 0
      localCutoff = null
      lastStatus = null
      lastNotices = null
    }
  }
  return service
}

/** Drops the summary jobs a v2 project left from P1 (`summary.v5` is off in v2, plan P2a §3.7). */
export function dropSummaryJobs(db: TreeDb): void {
  deleteAllJobs(db, 'summary')
}
