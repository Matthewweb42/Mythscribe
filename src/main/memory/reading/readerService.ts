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
  CheckEstimate,
  CheckReport,
  CheckStartResult,
  MemoryHealthReport,
  MemoryNotice,
  MemoryNoticeAction,
  MemoryPause,
  MemoryStatus,
  NotRightChoice,
  NotRightResult,
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
  MEMORY_CLOUD_FEATURES,
  monthOf,
  reconcileTally,
  setCap,
  type MemoryCloudState
} from '../../ai/cloudTally'
import { dayOf } from '../../ai/dailyCap'
import { assertFeatureAllowed } from '../../ai/dial'
import { registerInflight, releaseInflight } from '../../ai/inflight'
import { AiCancelledError, AiProviderError } from '../../ai/providers/types'
import type { AiRequestDeps } from '../../ai/request'
import { aiUsage, reading } from '../../db/schema'
import { currentDraftId } from '../../draft/draftStore'
import { AppError } from '../../ipc/errors'
import { createIndexQueue, JobSkippedError, type JobRun } from '../../jobs/indexQueue'
import { deleteAllJobs, listJobs } from '../../jobs/jobStore'
import type { TreeDb } from '../../tree/treeStore'
import { manuscriptRootId } from '../../voice/voiceJob'
import { getRecord } from '../recordStore'
import {
  backfillPlan,
  backfillsByRecord,
  noteLateNames,
  openBackfills,
  setBackfillState,
  type OpenBackfill
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
  getRebuild,
  getSpotState,
  keepReading,
  setAsked
} from './readerRows'
import {
  applyRebuildAction,
  rebuildSceneDone,
  rebuildSummary,
  startRebuild,
  stopRebuild,
  noteRebuildDone,
  rebuildDoneNotice,
  reviewRebuild
} from './rebuild'
import { linkPlansAfterReading } from './planLinks'
import { markRebuilt, pickStrongDue, runSpotChecks } from './spotChecks'
import { detailConflicts, keepMine } from './detailConflicts'
import { notAbout, wrongValue } from './notRight'
import { checkReport, estimateCheck, priceWaiting } from '../findings/checkBook'
import {
  HOLD as HOLD_FINDINGS,
  createFindingsService,
  sweepCalls
} from '../findings/findingsService'
import { findingCounts, type FindingCounts } from '../findings/findingsJob'
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
 *   provider (the request path's); the health gate for the bulk work the author asked for
 *   (*Rebuild memory*, a priced backlog or back-fill; *Read now* of one scene passes); then, for
 *   work nobody asked for, a local cut-off pause, the Cloud monthly cap and the health gate (one
 *   probe read per 10 due scenes while a model is paused). A job such a gate holds back is dropped
 *   quietly (`JobSkippedError`): the queue never pauses for it, so asked work behind it runs, and
 *   the scene stays unread until the hold lifts, when the backlog and the back-fills are checked
 *   again. The notices (computed) say why.
 * - **Spend**: every Cloud request's reported cost goes into the app-wide monthly tally as it
 *   returns, as background or asked (P2a-D9), so a run that fails part-way still counts;
 *   `/credits` raises it, never lowers it (P2a-D10).
 * - **Pushes**: `memory:changed` after a reading (and `record:changed` for the secrets and
 *   threads it made, merged into or pruned, P2b), `memory:statusChanged` and
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
  /**
   * P2b: `record:changed` for the secrets and threads a reading made, merged a reveal into,
   * revived or pruned, so the sidebar's lists update (no roster change: topics are not names).
   */
  recordsChanged?: (recordIds: string[]) => void
  /** The name questions may have moved (facts waiting on a new name). */
  questions: () => void
  /** F-16.21: the automatic plan links moved after a reading (`planLinks:changed`). */
  planLinksChanged: () => void
  status: (status: MemoryStatus) => void
  notices: (notices: MemoryNotice[]) => void
  /** `jobs:changed` (only while a v2 project is open). */
  jobs: (status: IndexQueueStatus) => void
  /** F-16.27: `memory:findingsChanged` after the contradiction judge stored verdicts. */
  findingsChanged?: (counts: FindingCounts) => void
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
  /** A write outside the editor (Replace, a revert, a draft switch, the chat's new scenes). */
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
  /** F-16.30: *Check the book*'s price now (local; nothing is sent). */
  checkEstimate(): CheckEstimate
  /**
   * F-16.30: *Check the book*, confirmed with its price: one `checkBook` job (stopped with the
   * queue's Stop); `openNodeId` is the open scene, whose findings the stronger check takes first.
   * AI failures (the switch or Use AI off, no provider, the daily cap) as data.
   */
  checkBook(openNodeId: string | null): CheckStartResult
  /** F-16.30: the last check's report; null before any. */
  checkReport(): CheckReport | null
  rebuildSummary(): RebuildSummary | null
  rebuildAction(action: RebuildAction): { changed: number }
  /** *Not right* on an AI line (F-16.18): *Wrong value*, or *Not about* with one check. */
  notRight(claimId: string, choice: NotRightChoice, requestId: string): Promise<NotRightResult>
  /** Typed details were saved: the typed-detail conflicts are looked at again. */
  detailsChanged(): void
  cloudCap(): CloudCapState
  setCloudCap(capUsd: number): CloudCapState
  /** `/credits` answered: the tally is raised to the server's reading spend. */
  reconcileCloud(credits: CreditsResult): void
  /**
   * F-16.27: queues a background `judge` run when unjudged pairs wait and the gates allow (the
   * `findings` job asks after every recompute).
   */
  queueJudge(): void
  /** F-16.27: whether a `judge` or `checkBook` job is queued or running. */
  judging(): boolean
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

/**
 * Which gates a job passes (see the module comment): `switch` only Use AI and the reading switch
 * (*Read now*; a rebuild's spot checks, priced with it); `health` the health gate too (the bulk
 * work the author asked for); `all` every gate (work nobody asked for).
 */
type GateLevel = 'switch' | 'health' | 'all'

type Hold = Extract<MemoryPause, 'health' | 'cloudCap' | 'localCutoff'>

const HOLD_MESSAGE: Record<Hold, string> = {
  health: 'Story memory paused: this model’s readings aren’t reliable enough.',
  cloudCap: 'Background reading reached your Cloud cap for this month.',
  localCutoff: 'Story memory paused: the local model stopped answering at its limit.'
}

/** What the author can do about a health pause before asked bulk work (`memory:rebuild`). */
const HEALTH_NEXT_STEP =
  'Switch the fast model, or choose Keep reading anyway on the story memory notice.'

const READER_KINDS: readonly JobKind[] = [
  'read',
  'rebuild',
  'spotCheck',
  'backfill',
  // F-16.27, F-16.30: the contradiction judge's runs (`findingsService.ts`).
  'judge',
  'checkBook'
]
const JUDGE_KINDS: readonly JobKind[] = ['judge', 'checkBook']
/** How long after a write outside the editor the backlog is checked. */
export const BACKLOG_DELAY_MS = 2_000
/** How often, at most, the Cloud tally asks `/credits`. */
export const RECONCILE_EVERY_MS = 60 * 60 * 1000

const NO_STATUS: MemoryStatus = {
  lastRead: null,
  paused: null,
  todayUsd: 0,
  cloud: null,
  rebuild: null,
  check: null
}

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
  /** Whether unasked work was held back at the last look (its lifting re-checks the backlog). */
  let heldBack = false
  let localCutoff: string | null = null
  /** The stored notices (the health and Cloud cap ones are computed). */
  const stored = new Map<string, MemoryNotice>()
  /** The scenes a backlog or draft-unread notice offers to read. */
  let offered: DueScene[] = []
  /** Health notices closed this session, by model. */
  const closedHealth = new Set<string>()
  /** F-16.27: `findingsWaiting` notices closed this session, by day. */
  const closedWaiting = new Set<string>()
  let backlogTimer: ReturnType<typeof setTimeout> | null = null
  let lastStatus: string | null = null
  let lastNotices: string | null = null
  let lastReconcile = 0

  /** A judge or check job is running (the queue's status leaves them out of its counts). */
  let judgeRunning = false

  const queue = createIndexQueue<ReaderValue>({
    kind: READER_KINDS,
    // F-16.27: judging is not reading; the indicator counts scenes only.
    uncounted: JUDGE_KINDS,
    db: v2Db,
    run: (job, requestId) => runJob(job.kind, job.nodeId, requestId),
    cancelRequest: deps.cancelRequest,
    now,
    // `jobs:changed` is the reader's only in a v2 project (the summary queue's in v1).
    onChange: (status) => {
      if (deps.memory() === 'v2') deps.jobs(status)
      const db = v2Db()
      if (db !== null) closeRebuild(db, status)
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

  /**
   * What holds unasked work back now, or null. The cap before the health gate: a probe the health
   * gate lets through must not spend past the cap.
   */
  const backgroundBlock = (db: TreeDb): Hold | null => {
    if (localCutoff !== null) return 'localCutoff'
    const provider = deps.provider(db)
    if (provider === null) return null
    if (provider.id === 'cloud' && capReached(deps.cloud.get(), month())) return 'cloudCap'
    if (healthPaused(db, provider.fastModel)) return 'health'
    return null
  }

  /** What holds the bulk work the author asked for back now: the health gate only, or null. */
  const askedBlock = (db: TreeDb): 'health' | null => {
    const provider = deps.provider(db)
    return provider !== null && healthPaused(db, provider.fastModel) ? 'health' : null
  }

  /**
   * The gates before a job's requests (see the module comment). Use AI or the switch off throws
   * `AiDisabledError` (the queue pauses: nothing runs until it is on); a hold throws
   * `JobSkippedError` (the job goes quietly; the queue keeps working).
   */
  const gate = (db: TreeDb, level: GateLevel, probe: boolean): void => {
    const settings = deps.settings(db)
    assertFeatureAllowed(settings, 'reader')
    assertFeatureAllowed(settings, 'verify')
    if (level === 'switch') return
    const block = level === 'health' ? askedBlock(db) : backgroundBlock(db)
    if (block === null || (block === 'health' && probe)) return
    throw new JobSkippedError(HOLD_MESSAGE[block])
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
    // Today's memory spend from the ledger: readings, their checks, the spot checks and (F-16.27)
    // the contradiction judge.
    const today = db
      .select({ usd: sql<number>`coalesce(sum(${aiUsage.costUsd}), 0)` })
      .from(aiUsage)
      .where(
        and(
          gte(aiUsage.at, startOfDay(now())),
          inArray(aiUsage.feature, [...MEMORY_CLOUD_FEATURES])
        )
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
          : null,
      rebuild: getRebuild(db),
      check: findings.progress()
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
    // Decision 4: the cards already read disagree with typed details (local; AI off too).
    list.push(...detailConflicts(db))
    // F-16.29: the last rebuild's review, and pairs the background left for Check the book.
    const findingsOn = deps.settings(db).features.judge
    const done = rebuildDoneNotice(db, findingsOn)
    if (done !== null) list.push(done)
    const waiting = findings.waiting(db)
    const waitingId = `findingsWaiting:${dayOf(now())}`
    if (waiting > 0 && !closedWaiting.has(waitingId)) {
      list.push({
        id: waitingId,
        kind: 'findingsWaiting',
        pairs: waiting,
        priceUsd: priceWaiting(waiting, rebuildContext(db))
      })
    }
    return list
  }

  /**
   * Pushes the status and the notices when they moved (a v2 project only). A hold on unasked work
   * that has lifted since the last look (the cap allowed or raised, a new month, the health gate
   * passed or overruled, a cut-off lifted) re-checks the backlog and the back-fills, so the
   * scenes left unread meanwhile are read (≤5) or asked about with the price.
   */
  function publish(): void {
    const db = v2Db()
    if (db === null) return
    if (readingAllowed(db)) {
      const held = backgroundBlock(db) !== null
      if (heldBack && !held) {
        heldBack = false
        scheduleBacklog()
        checkBackfill()
        return
      }
      heldBack = held
    }
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

  /** *Rebuild memory*'s price, its contradiction sweep included with the switch on (F-16.27). */
  const priceRebuild = (db: TreeDb): RebuildEstimate =>
    rebuildEstimate(
      db,
      rebuildContext(db),
      isFeatureAllowed(deps.settings(db), 'judge') ? sweepCalls : undefined
    )

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
   * scene stays unread (the backlog check finds it once the hold lifts), and the health gate lets
   * one in 10 through as a probe. A scene being read right now is read once more after (an edit
   * saved while it was read).
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
    } else if (block !== null) return false
    if (caretPara === null) carets.delete(nodeId)
    else carets.set(nodeId, caretPara)
    queue.indexAll('read', [nodeId], { afterRunning: true })
    return true
  }

  /** The queue was stopped by a hard failure (no key, over budget): the author's ask retries it. */
  const resumeIfPaused = (): void => {
    if (queue.status().paused !== null) queue.resume()
  }

  /** Queues every scene of `scenes` as asked (a priced backlog the author confirmed). */
  const queueAsked = (db: TreeDb, nodeIds: readonly string[]): void => {
    const asked = getAsked(db)
    for (const id of nodeIds) asked.add(id)
    setAsked(db, asked)
    queue.indexAll('read', [...nodeIds])
    resumeIfPaused()
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
          priceUsd: priceRebuild(db).costUsd
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

  /**
   * The back-fill notices: one per record whose due pages come to more than 3 (all its names
   * together), with the price; a record with nothing left to ask about loses its notice. Answers
   * whether any back-fill may run now (asked rows, or a record at 3 pages or fewer).
   */
  function backfillNotices(db: TreeDb): boolean {
    const records = backfillsByRecord(openBackfills(db))
    const asking = new Set(records.filter((entry) => entry.ask).map((entry) => entry.recordId))
    for (const id of [...stored.keys()]) {
      if (id.startsWith('backfill:') && !asking.has(id.slice('backfill:'.length))) stored.delete(id)
    }
    let queueIt = false
    for (const entry of records) {
      if (entry.asked.length > 0 || (entry.due.length > 0 && !entry.ask)) queueIt = true
      if (!entry.ask) continue
      const id = `backfill:${entry.recordId}`
      stored.set(id, {
        id,
        kind: 'backfill',
        recordId: entry.recordId,
        name: getRecord(db, entry.recordId)?.name ?? '',
        pages: entry.duePages,
        priceUsd: priceReads(
          Array.from({ length: entry.duePages }, () => ({
            read: 'window' as const,
            proseTokens: 0
          })),
          rebuildContext(db)
        ).costUsd
      })
    }
    return queueIt
  }

  /**
   * The back-fills (plan P2a §3.4): the notices, and the job when any may run. A back-fill job
   * running now runs once more after (it read the rows as they were when it started).
   */
  function checkBackfill(): void {
    const db = v2Db()
    if (db === null) return
    const at = root(db)
    if (backfillNotices(db) && at !== null && readingAllowed(db)) {
      queue.indexAll('backfill', [at], { afterRunning: true })
    }
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

  /** What follows a reading: the pushes, the health notice, the spot checks, the backlog's count. */
  const afterReading = (db: TreeDb, nodeId: string, outcome: ReadingOutcome): void => {
    if (!outcome.read) {
      if (outcome.reason !== 'localCutoff') return
      // Unasked reading stops here (the gate holds it back); asked work goes on.
      localCutoff = outcome.model
      stored.set('localCutoff', { id: 'localCutoff', kind: 'localCutoff', model: outcome.model })
      publish()
      return
    }
    // F-16.27: the scene just read has its findings judged first.
    findings.read(nodeId)
    // The secrets and threads the reading made, merged into, revived, gave up or pruned are named
    // too (plan P2b §2.4 step 7), so their views refresh even when no claim on them changed.
    deps.changed({
      nodeIds: [nodeId],
      recordIds: [...new Set([...outcome.recordIds, ...outcome.topicIds])].sort()
    })
    if (outcome.topicIds.length > 0) deps.recordsChanged?.(outcome.topicIds)
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

  /**
   * F-16.21: plan links after a reading that wrote (code first, `planLinks.v2` at most once), in
   * the reading's own job, so a Stop ends it. The pick is never part of what the author asked or
   * was priced (Read now, a rebuild, a priced backlog or back-fill price readings only), so its
   * cost is tallied as background spend and, past the Cloud cap, it is not asked at all: code
   * still links (P2a-D9). Nothing here fails the reading.
   */
  const linkPlans = async (
    db: TreeDb,
    nodeId: string,
    outcome: ReadingOutcome,
    requestId: string,
    signal: AbortSignal
  ): Promise<void> => {
    if (!outcome.read) return
    try {
      const result = await linkPlansAfterReading(db, deps.requestDeps(db), {
        settings: deps.settings(db),
        readingId: outcome.readingId,
        nodeId,
        lineMoved: outcome.lineMoved,
        requestId,
        signal,
        askAi: !(isCloud(db) && capReached(deps.cloud.get(), month())),
        onSpend: spender(db, false)
      })
      if (result.changed) deps.planLinksChanged()
    } catch (err) {
      // A Stop while the plan-link pick was out: the reading stands, no link is made.
      if (!(err instanceof AiCancelledError)) throw err
    }
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

  /** Each request's cost into the Cloud tally as it returns (a run that fails part-way counts). */
  const spender = (db: TreeDb, asked: boolean) => (usd: number) => tally(db, usd, asked)

  /** F-16.27, F-16.30: the contradiction judge's runs, dispatched from this queue. */
  const findings = createFindingsService({
    settings: deps.settings,
    provider: deps.provider,
    requestDeps: deps.requestDeps,
    cloudCapped: (db) => isCloud(db) && capReached(deps.cloud.get(), month()),
    rebuilding: (db) => getRebuild(db)?.finishedAt === null,
    spend: (db, usd, asked) => tally(db, usd, asked),
    changed: deps.changed,
    ...(deps.findingsChanged === undefined ? {} : { findingsChanged: deps.findingsChanged }),
    // F-16.30: Check the book's progress is the status the activity bar reads.
    progressed: () => publish(),
    now
  })

  /** Queues a background judge run when one is wanted (and none waits already). */
  function queueJudge(): void {
    const db = v2Db()
    if (db === null) return
    const at = root(db)
    if (findings.wanted(db) && at !== null) queue.indexAll('judge', [at], { afterRunning: true })
    // The findings moved: the notice of pairs left for Check the book follows.
    publish()
  }

  async function runRead(
    db: TreeDb,
    nodeId: string,
    requestId: string
  ): Promise<JobRun<ReaderValue>> {
    const clicked = askedNow.has(nodeId)
    const listed = getAsked(db).has(nodeId)
    const confirmed = !clicked && listed
    const asked = clicked || confirmed
    const probe = probes.has(nodeId)
    const caret = carets.get(nodeId)
    let settled = false
    try {
      try {
        gate(db, clicked ? 'switch' : confirmed ? 'health' : 'all', probe)
      } catch (err) {
        settled = err instanceof JobSkippedError
        throw err
      }
      const outcome = await withSignal(requestId, (signal) =>
        runReading(
          db,
          { ai: deps.requestDeps(db) },
          {
            nodeId,
            caretPara: asked ? null : (caret ?? null),
            requestId,
            signal,
            ...(probe ? { purpose: 'probe' as const } : {}),
            spotEvery: getSpotState(db).rebuiltAt === null ? null : SPOT_EVERY,
            onSpend: spender(db, asked)
          }
        )
      )
      settled = true
      afterReading(db, nodeId, outcome)
      await withSignal(requestId, (signal) => linkPlans(db, nodeId, outcome, requestId, signal))
      return { requested: requested(outcome), value: { outcome } }
    } finally {
      // A caret a later idle pause set while this ran is that run's (the job runs once more).
      if (carets.get(nodeId) === caret) carets.delete(nodeId)
      probes.delete(nodeId)
      // A confirmed scene stays asked through a retry; read, or held back, it is asked no more.
      if (listed && settled) {
        const rows = getAsked(db)
        if (rows.delete(nodeId)) setAsked(db, rows)
      }
    }
  }

  async function runRebuildScene(
    db: TreeDb,
    nodeId: string,
    requestId: string
  ): Promise<JobRun<ReaderValue>> {
    // Asked and priced: past the Cloud cap, never past the health gate (P2a-D25 replaces claims).
    gate(db, 'health', false)
    const outcome = await withSignal(requestId, (signal) =>
      runReading(
        db,
        { ai: deps.requestDeps(db) },
        {
          nodeId,
          caretPara: null,
          requestId,
          signal,
          purpose: 'rebuild',
          onSpend: spender(db, true)
        }
      )
    )
    afterReading(db, nodeId, outcome)
    await withSignal(requestId, (signal) => linkPlans(db, nodeId, outcome, requestId, signal))
    // Counted; the rebuild closes once its last scene job ends, however it ends (`closeRebuild`).
    rebuildSceneDone(db)
    return { requested: requested(outcome), value: { outcome } }
  }

  /**
   * A rebuild whose scene jobs have all ended (read, failed for good, or held back) closes, and,
   * when it read any scene, its spot checks follow, then 1 in 20 from now on (P2a-D8). Called on
   * every queue change; a stopped rebuild (`cancelAll`) was closed already, with no checks.
   */
  function closeRebuild(db: TreeDb, status: IndexQueueStatus): void {
    if (status.running?.kind === 'rebuild') return
    const progress = getRebuild(db)
    if (progress?.finishedAt !== null) return
    if (listJobs(db, 'rebuild').some((job) => job.status === 'queued')) return
    stopRebuild(db, now())
    const at = root(db)
    if (progress.done > 0 && at !== null) {
      markRebuilt(db, now())
      queue.indexAll('spotCheck', [at])
      // F-16.27, F-16.29: its contradiction sweep (asked, priced with it) and its review notice.
      if (isFeatureAllowed(deps.settings(db), 'judge')) findings.sweepDue(db, progress.startedAt)
      noteRebuildDone(db, progress.startedAt)
    }
    // F-16.27: background judging waited for the rebuild (the sweep runs first when due).
    queueJudge()
  }

  async function runSpot(db: TreeDb, requestId: string): Promise<JobRun<ReaderValue>> {
    // A rebuild's checks were priced with it: spent as asked, past the cap and the health gate.
    const asked = getSpotState(db).rebuildPass
    gate(db, asked ? 'switch' : 'all', false)
    const run = await withSignal(requestId, (signal) =>
      runSpotChecks(
        db,
        { ai: deps.requestDeps(db) },
        { requestId, signal, onSpend: spender(db, asked) }
      )
    )
    if (run.deleted.length > 0) {
      deps.log?.(
        `Story memory spot check: the strong model refused ${run.deleted.length} claim(s); deleted.`
      )
    }
    if (run.deleted.length > 0) deps.changed({ nodeIds: run.nodeIds, recordIds: run.recordIds })
    publish()
    return { requested: run.requested, value: { outcome: null } }
  }

  /**
   * The back-fills, record by record: the rows the author asked for (gated as asked bulk work),
   * then the due rows of a record whose names come to 3 pages or fewer together (gated as
   * unasked work); a record over 3 waits for its notice. One record's names are read together, a
   * paragraph naming it twice once. A group a gate holds back stays open for when the hold lifts.
   */
  async function runBackfill(db: TreeDb, requestId: string): Promise<JobRun<ReaderValue>> {
    let sent = false
    await withSignal(requestId, async (signal) => {
      let n = 0
      for (const record of backfillsByRecord(openBackfills(db))) {
        const groups: { rows: OpenBackfill[]; asked: boolean }[] = [
          { rows: record.asked, asked: true },
          { rows: record.ask ? [] : record.due, asked: false }
        ]
        for (const group of groups) {
          if (group.rows.length === 0) continue
          try {
            gate(db, group.asked ? 'health' : 'all', false)
          } catch (err) {
            if (err instanceof JobSkippedError) continue
            throw err
          }
          const plan = backfillPlan(
            db,
            record.recordId,
            group.rows.map((row) => row.norm)
          )
          for (const scene of plan) {
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
                paras: scene.paras,
                onSpend: spender(db, group.asked)
              }
            )
            sent ||= requested(outcome)
            afterReading(db, scene.nodeId, outcome)
            await linkPlans(db, scene.nodeId, outcome, `${requestId}:b${n}`, signal)
          }
          for (const row of group.rows) {
            setBackfillState(db, record.recordId, 'done', now(), row.norm)
          }
        }
      }
    })
    // The notices of records read through go. Nothing is queued from here: what a hold refused
    // waits for the hold to lift (`publish`), never a loop of runs.
    backfillNotices(db)
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
      case 'judge':
      case 'checkBook': {
        // F-16.27, F-16.30: the findings service owns both; a background run queues itself again.
        judgeRunning = true
        try {
          const result =
            kind === 'judge'
              ? await findings.judge(db, requestId)
              : await findings.checkBook(db, requestId)
          if (result.again) queue.indexAll('judge', [nodeId], { afterRunning: true })
          return { requested: result.requested, value: { outcome: null } }
        } finally {
          judgeRunning = false
        }
      }
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
      queueJudge()
      publish()
    },

    settingsChanged() {
      const db = v2Db()
      if (db === null) return
      if (queue.status().paused !== null && readingAllowed(db)) queue.resume()
      // F-16.27: the Contradiction check switched on (or a provider set up): judging resumes, and
      // the counts follow the switch (off, none are shown).
      queueJudge()
      deps.findingsChanged?.(findingCounts(db, deps.settings(db).features.judge))
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
      } else if (id.startsWith('detail:')) {
        // Decision 4: *Keep mine* (and closing it) leaves the typed value and never asks again;
        // *Update my detail* is the renderer's write through `sceneDetail:set`.
        const conflict = detailConflicts(db).find((each) => each.id === id)
        if (conflict !== undefined && (action === 'keepMine' || action === 'dismiss')) {
          keepMine(db, conflict, now())
        }
      } else if (id.startsWith('rebuildDone:')) {
        // F-16.29: *Done* (or closing it): the review is not shown again for this rebuild.
        if (action === 'dismiss') reviewRebuild(db, id.slice('rebuildDone:'.length))
      } else if (id.startsWith('findingsWaiting:')) {
        if (action === 'dismiss') closedWaiting.add(id)
      } else if (id.startsWith('cloudCap:')) {
        if (action === 'allowMore') {
          deps.cloud.update((state) => markCapNotice(allowMore(state, month()), month()))
        } else if (action === 'dismiss') {
          deps.cloud.update((state) => markCapNotice(state, month()))
        }
      } else {
        const notice = stored.get(id)
        if (notice !== undefined) {
          // Asked bulk work waits while the health gate pauses the model: the notice stays, beside
          // the health notice that says why (its Keep reading anyway or Switch lifts it).
          const held = action === 'read' && askedBlock(db) !== null
          if (notice.kind === 'localCutoff' && action === 'keepReading') {
            localCutoff = null
            stored.delete(id)
          } else if (held) {
            // Nothing is queued; the notice stays.
          } else if (notice.kind === 'backlog') {
            if (action === 'read') {
              queueAsked(
                db,
                offered.map((scene) => scene.nodeId)
              )
            }
            stored.delete(id)
            offered = []
          } else if (notice.kind === 'draftUnread') {
            // A draft never read is read as *Rebuild memory* (its price is the rebuild's); a
            // rebuild that cannot start (no provider) leaves the notice.
            if (action !== 'read' || service.rebuild().ok) {
              stored.delete(id)
              offered = []
            }
          } else if (notice.kind === 'backfill') {
            if (action === 'read') {
              setBackfillState(db, notice.recordId, 'asked', now())
              const at = root(db)
              if (at !== null) queue.indexAll('backfill', [at], { afterRunning: true })
              resumeIfPaused()
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
      return priceRebuild(requireDb())
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
      // A rebuild replaces what it does not prove again (P2a-D25): never on a model the health
      // gate has paused, unless the author chose Keep reading anyway for it.
      if (askedBlock(db) !== null) {
        return {
          ok: false,
          code: 'DISABLED',
          message: HOLD_MESSAGE.health,
          nextStep: HEALTH_NEXT_STEP
        }
      }
      const estimate = priceRebuild(db)
      const { nodeIds } = startRebuild(db, now())
      // The rebuild replaces scene by scene: leftover reads of those scenes are its to do.
      queue.indexAll('rebuild', nodeIds)
      resumeIfPaused()
      publish()
      return { ok: true, queued: nodeIds.length, estimate }
    },

    rebuildSummary() {
      const db = requireDb()
      return rebuildSummary(db, deps.settings(db).features.judge)
    },

    checkEstimate() {
      const db = requireDb()
      return estimateCheck(db, rebuildContext(db))
    },

    checkBook(openNodeId) {
      const db = requireDb()
      const hold = findings.askedHold(db)
      if (hold !== null) {
        const code =
          hold === HOLD_FINDINGS.provider
            ? 'NO_KEY'
            : hold === HOLD_FINDINGS.dailyCap
              ? 'BUDGET'
              : 'DISABLED'
        return aiFailure(code, hold)
      }
      const estimate = estimateCheck(db, rebuildContext(db))
      const at = root(db)
      if (at !== null) {
        findings.checkAsked(openNodeId)
        queue.indexAll('checkBook', [at])
        resumeIfPaused()
      }
      publish()
      return { ok: true, estimate }
    },

    checkReport() {
      return checkReport(requireDb())
    },

    async notRight(claimId, choice, requestId) {
      const db = requireDb()
      if (choice.kind === 'wrongValue') {
        const outcome = wrongValue(db, claimId, now())
        if (outcome.outcome !== 'gone') {
          deps.changed({ nodeIds: outcome.nodeIds, recordIds: outcome.recordIds })
        }
        return { ok: true, outcome: outcome.outcome, dismissed: outcome.dismissed }
      }
      try {
        // Asked: gated by Use AI and the reading switch only, and spent as asked (P2a-D9).
        gate(db, 'switch', false)
        const outcome = await notAbout(
          db,
          { ai: deps.requestDeps(db) },
          { claimId, recordId: choice.recordId, requestId, onSpend: spender(db, true) }
        )
        if (outcome.outcome === 'moved' || outcome.outcome === 'dismissed') {
          deps.changed({ nodeIds: outcome.nodeIds, recordIds: outcome.recordIds })
        }
        publish()
        return { ok: true, outcome: outcome.outcome, dismissed: outcome.dismissed }
      } catch (err) {
        if (err instanceof AiProviderError) return aiFailure(err.code, err.message)
        throw err
      }
    },

    detailsChanged: () => publish(),

    rebuildAction(action) {
      const db = requireDb()
      const result = applyRebuildAction(db, action, now())
      if (result.nodeIds.length > 0 || result.recordIds.length > 0 || result.topicIds.length > 0) {
        deps.changed({
          nodeIds: result.nodeIds,
          recordIds: [...result.recordIds, ...result.topicIds]
        })
      }
      // F-16.22: the secrets and threads *Not right* took away leave the sidebar's lists.
      if (result.topicIds.length > 0) deps.recordsChanged?.(result.topicIds)
      if (result.names) deps.questions()
      // F-16.29: *Not a problem* on the rebuild's possible contradictions moves the counts.
      if (action.action === 'notProblems' && result.changed > 0) {
        deps.findingsChanged?.(findingCounts(db, deps.settings(db).features.judge))
        publish()
      }
      return { changed: result.changed }
    },

    cloudCap() {
      return cloudCapState(deps.cloud.get(), month())
    },

    setCloudCap(capUsd) {
      const next = deps.cloud.update((state) => setCap(state, capUsd, month()))
      // A cap raised past the spend lifts the hold: `publish` re-checks the backlog.
      publish()
      return cloudCapState(next, month())
    },

    reconcileCloud(credits) {
      deps.cloud.update((state) => reconcileTally(state, credits, now()))
      publish()
    },

    queueJudge: () => queueJudge(),

    judging() {
      const db = v2Db()
      if (db === null) return false
      return judgeRunning || listJobs(db, [...JUDGE_KINDS]).some((job) => job.status === 'queued')
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
      closedWaiting.clear()
      offered = []
      skipped = 0
      heldBack = false
      localCutoff = null
      lastStatus = null
      lastNotices = null
      findings.clear()
    }
  }
  return service
}

/** Drops the summary jobs a v2 project left from P1 (`summary.v5` is off in v2, plan P2a §3.7). */
export function dropSummaryJobs(db: TreeDb): void {
  deleteAllJobs(db, 'summary')
}
