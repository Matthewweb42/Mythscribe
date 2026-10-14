import { z } from 'zod'
import { AI_NEXT_STEP, type AiProviderId } from '@shared/ai'
import { isFeatureAllowed, type AiSettings } from '@shared/aiSettings'
import { RULE_ORDER, type Finding, type FindingSide } from '@shared/memory/findings'
import type { CheckProgress } from '@shared/memory/views'
import { dayOf, rollIfNewDay } from '../../ai/dailyCap'
import { JUDGE_PAIRS_MAX } from '../../ai/prompts/judge.v1'
import { registerInflight, releaseInflight } from '../../ai/inflight'
import { AiBudgetError, AiCancelledError, AiProviderError } from '../../ai/providers/types'
import type { AiRequestDeps } from '../../ai/request'
import { currentDraftId } from '../../draft/draftStore'
import { JobSkippedError, jobOutcome } from '../../jobs/indexQueue'
import type { TreeDb } from '../../tree/treeStore'
import { readRow, writeRow } from '../reading/readerRows'
import { findingsFrame } from './candidateInputs'
import {
  CHECK_CONFIRM_MAX,
  confirmFindings,
  confirmOrder,
  emptyConfirmRun,
  unreadScenes,
  writeCheckReport,
  type ConfirmRunResult
} from './checkBook'
import { findingsOf } from './findingStore'
import { findingCounts, runFindingsJob, type FindingCounts } from './findingsJob'
import {
  emptyJudgeRun,
  judgeContext,
  judgeFindings,
  type JudgeContext,
  type JudgeRunResult
} from './judge'

/**
 * The contradiction judge's jobs (F-16.27, F-16.30; plan P4 §2.3, §3.1, §3.3, P4-D12), on the
 * reader's provider-backed queue (`readerService` only dispatches `judge` and `checkBook` here).
 *
 * - **Background** (`judge`): queued by the `findings` job when unjudged pairs exist and the
 *   switch allows; at most 10 pairs a run (two calls), the scene just read first, then by rule
 *   (`RULE_ORDER`) and reading order; it queues itself again while unjudged pairs remain, up to 30
 *   pairs a day; the rest wait for *Check the book*. C7 pairs are *Check the book*'s only. Never
 *   while a *Rebuild memory* runs. Gates before any request: Use AI and the **Contradiction check**
 *   switch, a provider, the day's pairs, the daily cap and, on Cloud, the monthly cap for
 *   background spend (P2a-D9). A hold throws `JobSkippedError`: the job goes quietly, the queue
 *   never pauses for it (reading behind it runs), and the next change that moves a finding queues
 *   it again.
 * - **The rebuild sweep** (a `judge` job while the `memoryJudgeSweep` row is due, P4-D12): a
 *   *Rebuild memory* that read any scene ends with one sweep of up to 60 pairs (C1–C6), asked
 *   spend priced with the rebuild (past the Cloud cap and the day's pairs, never past the daily
 *   cap), after a recompute of its own.
 * - **Check the book** (`checkBook`, asked, F-16.30): a recompute with C7, every unjudged pair (no
 *   daily pair limit), then the stronger check on the open findings (`confirmFindings`, at most
 *   20 calls), then the report (`writeCheckReport`). Asked spend: past the Cloud cap, never past
 *   the daily cap. A Stop keeps what was judged, and the report says it was stopped. Its progress
 *   (`progress`) is the activity bar's.
 *
 * Every call's cost goes to the Cloud tally as it returns (`spend`), and is shared out to the
 * findings it judged (`judge.ts`). After a run that moved a finding's state (an unjudged pair now
 * open, unclear or fine), `memory:findingsChanged` and `memory:changed` (those findings' scenes and
 * records) are pushed; a run that only stored half a pair pushes nothing, so it never queues
 * itself again through the recompute. A run cut short (the daily cap, a provider failure, a Stop)
 * still counts the pairs it sent and pushes what it settled. A background run's transient provider
 * failure (a rate limit, the network) goes quietly: the next change that moves a finding queues it
 * again, and it never shows as a scene that could not be read.
 */

/** Pairs at most per background run (two calls: both orders). */
export const JUDGE_RUN_PAIRS = 10
/** Pairs at most the background judges a day (the rest wait for *Check the book*). */
export const JUDGE_DAY_PAIRS = 30

/** Pairs at most the rebuild's sweep judges (P4-D12). */
export const JUDGE_SWEEP_PAIRS = 60

/**
 * The settings row saying a finished rebuild's sweep is due (asked, priced with the rebuild): the
 * pairs its price covered, which the sweep judges at most.
 */
export const MEMORY_JUDGE_SWEEP_KEY = 'memoryJudgeSweep'
const JudgeSweep = z.object({ rebuildAt: z.string(), pairs: z.number().int().positive() })

/**
 * The pairs the rebuild sweep of a `scenes`-scene rebuild judges at most: a batch (one call per
 * order) per 15 scenes, at most `JUDGE_SWEEP_PAIRS`; what *Rebuild memory*'s price covers.
 */
export function sweepPairs(scenes: number): number {
  return Math.min(JUDGE_SWEEP_PAIRS, JUDGE_PAIRS_MAX * Math.ceil(scenes / 15))
}

/** The rebuild sweep's calls, as *Rebuild memory*'s price counts them (both orders of each batch). */
export function sweepCalls(scenes: number): number {
  return 2 * Math.ceil(sweepPairs(scenes) / JUDGE_PAIRS_MAX)
}

/** The settings row counting today's background pairs. */
export const MEMORY_JUDGE_DAY_KEY = 'memoryJudgeDay'
const JudgeDay = z.object({ day: z.string(), pairs: z.number().int().nonnegative() })
type JudgeDay = z.infer<typeof JudgeDay>

/** The background pairs judged on `today` (a row from another day reads as none). */
export function judgeDay(db: TreeDb, today: string): JudgeDay {
  const row = readRow(db, MEMORY_JUDGE_DAY_KEY, JudgeDay.nullable(), null)
  return row?.day === today ? row : { day: today, pairs: 0 }
}

function addJudgeDay(db: TreeDb, today: string, pairs: number): void {
  if (pairs === 0) return
  const day = judgeDay(db, today)
  writeRow(db, MEMORY_JUDGE_DAY_KEY, { day: today, pairs: day.pairs + pairs })
}

export const HOLD = {
  off: 'The contradiction check is off.',
  provider: 'The contradiction check needs an AI provider.',
  rebuild: 'The contradiction check waits for Rebuild memory to finish.',
  dayPairs:
    'The contradiction check reached today’s background limit; Check the book judges the rest.',
  dailyCap: 'The contradiction check waits: today’s AI spend reached its cap.',
  cloudCap: 'Background checks reached your Cloud cap for this month.',
  transient: 'The contradiction check will try again after the next change:'
} as const

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** What ended a check early, with the next step (the dialog and the activity bar say it); null for a Stop. */
function checkFailure(err: unknown): string | null {
  if (err instanceof AiCancelledError) return null
  if (err instanceof AiBudgetError) return HOLD.dailyCap
  if (err instanceof AiProviderError) return `${err.message} ${AI_NEXT_STEP[err.code]}`.trim()
  return errorText(err)
}

export interface FindingsServiceDeps {
  settings: (db: TreeDb) => AiSettings
  provider: (db: TreeDb) => { id: AiProviderId } | null
  requestDeps: (db: TreeDb) => AiRequestDeps
  /** The Cloud monthly cap holds background spend now. */
  cloudCapped: (db: TreeDb) => boolean
  /** A *Rebuild memory* is running. */
  rebuilding: (db: TreeDb) => boolean
  /** A request's reported cost into the Cloud tally, background or asked (P2a-D9). */
  spend: (db: TreeDb, usd: number, asked: boolean) => void
  /** `memory:changed` for these scenes and records. */
  changed: (payload: { nodeIds: string[]; recordIds: string[] }) => void
  /** `memory:findingsChanged`. */
  findingsChanged?: (counts: FindingCounts) => void
  /** *Check the book*'s progress moved (the status the activity bar reads). */
  progressed?: () => void
  /**
   * The sweep of the rebuild started `rebuildAt` ended (however it ended): the keys of the open
   * findings made since that rebuild started, which the post-rebuild review lists.
   */
  swept?: (db: TreeDb, rebuildAt: string, keys: string[]) => void
  now: () => Date
}

/** What one judge or check job did. */
export interface FindingsJobResult {
  /** A request left (the queue's rate limit counts it). */
  requested: boolean
  /** Background only: unjudged pairs remain and today's limit allows another run. */
  again: boolean
  run: JudgeRunResult | null
  /** *Check the book* only: the stronger check's run. */
  confirm: ConfirmRunResult | null
}

export interface FindingsService {
  /** A scene was just read: its findings are judged first in the next background run. */
  read(nodeId: string): void
  /** Whether a judge job (background, or a due rebuild sweep) may be queued now and has work. */
  wanted(db: TreeDb): boolean
  judge(db: TreeDb, requestId: string): Promise<FindingsJobResult>
  checkBook(db: TreeDb, requestId: string): Promise<FindingsJobResult>
  /**
   * What holds an asked run (Check the book, the sweep) back now: the switch, a provider, the daily
   * cap; null when it may run.
   */
  askedHold(db: TreeDb): string | null
  /** *Check the book* was asked for with this scene open (its findings are confirmed first). */
  checkAsked(openNodeId: string | null): void
  /**
   * A *Rebuild memory* of `scenes` scenes that read some finished: its sweep is due, at most the
   * pairs its price covered (`sweepPairs`).
   */
  sweepDue(db: TreeDb, rebuildAt: string, scenes: number): void
  /**
   * The background pairs left for *Check the book* while the day's limit or the Cloud cap holds
   * background judging (the `findingsWaiting` notice), or 0.
   */
  waiting(db: TreeDb): number
  /** *Check the book*'s progress this session (null before a check). */
  progress(): CheckProgress | null
  clear(): void
}

const sideNode = (side: FindingSide): string | null => (side.kind === 'note' ? null : side.nodeId)

/**
 * The order unjudged findings are judged in: those touching `first` (the scene just read), then by
 * rule (`RULE_ORDER`), then by their earliest side in reading order, then oldest.
 */
export function judgeOrder(
  findings: readonly Finding[],
  ctx: JudgeContext,
  first: string | null
): Finding[] {
  const order = ctx.inputs.reading.order
  const at = (finding: Finding): number =>
    Math.min(
      ...[finding.a, finding.b].map((side) => {
        const nodeId = sideNode(side)
        return nodeId === null
          ? Number.MAX_SAFE_INTEGER
          : (order.get(nodeId) ?? Number.MAX_SAFE_INTEGER)
      })
    )
  const touches = (finding: Finding): number =>
    first !== null && (sideNode(finding.a) === first || sideNode(finding.b) === first) ? 0 : 1
  return [...findings].sort(
    (x, y) =>
      touches(x) - touches(y) ||
      RULE_ORDER.indexOf(x.rule) - RULE_ORDER.indexOf(y.rule) ||
      at(x) - at(y) ||
      x.created.localeCompare(y.created)
  )
}

/** How a run judges: in the background, as the rebuild's sweep, or as *Check the book*. */
type RunMode = 'background' | 'sweep' | 'check'

/** The unjudged findings a run of `mode` judges (C7 is *Check the book*'s only). */
const unjudgedFor = (db: TreeDb, draftId: string, mode: RunMode): Finding[] =>
  findingsOf(db, draftId, ['unjudged']).filter(
    (finding) => mode === 'check' || finding.rule !== 'C7'
  )

export function createFindingsService(deps: FindingsServiceDeps): FindingsService {
  let lastRead: string | null = null
  let openScene: string | null = null
  let check: CheckProgress | null = null

  const today = (): string => dayOf(deps.now())

  /** Whether today's AI spend already reached the daily cap. */
  const dailyCapped = (db: TreeDb): boolean => {
    const day = rollIfNewDay(deps.requestDeps(db).dailyCap.get(), today())
    return day.spentTodayUsd >= day.dailyCapUsd
  }

  /** What holds an asked run back: the switch, a provider, the daily cap. */
  const askedHold = (db: TreeDb): string | null => {
    if (!isFeatureAllowed(deps.settings(db), 'judge')) return HOLD.off
    if (deps.provider(db) === null) return HOLD.provider
    if (dailyCapped(db)) return HOLD.dailyCap
    return null
  }

  /** What holds the judge back in `mode`, or null. */
  const holdOf = (db: TreeDb, mode: RunMode): string | null => {
    const asked = askedHold(db)
    if (asked !== null || mode !== 'background') return asked
    if (deps.rebuilding(db)) return HOLD.rebuild
    if (judgeDay(db, today()).pairs >= JUDGE_DAY_PAIRS) return HOLD.dayPairs
    if (deps.cloudCapped(db)) return HOLD.cloudCap
    return null
  }

  /**
   * The due sweep, or null. A sweep is tried once: held back when it would run (the switch off, no
   * provider, the daily cap) or while another rebuild runs, it is dropped, never run later as spend
   * nobody asked for then (that rebuild's own sweep follows it).
   */
  const dueSweep = (db: TreeDb): z.infer<typeof JudgeSweep> | null => {
    const row = readRow(db, MEMORY_JUDGE_SWEEP_KEY, JudgeSweep.nullable(), null)
    if (row === null) return null
    if (askedHold(db) === null && !deps.rebuilding(db)) return row
    writeRow(db, MEMORY_JUDGE_SWEEP_KEY, null)
    return null
  }

  /** Pushes what a run moved: the counts, and the settled findings' scenes and records. */
  const pushed = (db: TreeDb, settled: readonly Finding[]): void => {
    if (settled.length === 0) return
    deps.findingsChanged?.(findingCounts(db, deps.settings(db).features.judge))
    const nodeIds = new Set<string>()
    const recordIds = new Set<string>()
    for (const finding of settled) {
      recordIds.add(finding.recordId)
      for (const side of [finding.a, finding.b]) {
        const nodeId = sideNode(side)
        if (nodeId !== null) nodeIds.add(nodeId)
      }
    }
    deps.changed({ nodeIds: [...nodeIds].sort(), recordIds: [...recordIds].sort() })
  }

  /**
   * An asked run's own recompute first (the findings job may still be waiting out its debounce
   * after the last change), with C7 for *Check the book*; the counts are pushed when it moved.
   */
  const recomputeFirst = (db: TreeDb, mode: RunMode): void => {
    const shown = deps.settings(db).features.judge
    const result = runFindingsJob(db, deps.now(), {
      cachedVerdicts: true,
      shown,
      checkRules: mode === 'check'
    })
    if (result.counts !== null) deps.findingsChanged?.(result.counts)
  }

  const setProgress = (next: CheckProgress | null): void => {
    check = next
    deps.progressed?.()
  }

  /** One run's judging over the active draft's unjudged findings; `failed` holds what it threw. */
  const judgeRun = async (
    db: TreeDb,
    draftId: string,
    requestId: string,
    mode: RunMode,
    signal: AbortSignal,
    result: JudgeRunResult,
    sweepRoom = JUDGE_SWEEP_PAIRS
  ): Promise<{ err: unknown } | null> => {
    const day = judgeDay(db, today())
    const room =
      mode === 'background'
        ? Math.min(JUDGE_RUN_PAIRS, JUDGE_DAY_PAIRS - day.pairs)
        : mode === 'sweep'
          ? sweepRoom
          : Number.MAX_SAFE_INTEGER
    const ctx = judgeContext(db, draftId)
    const findings = judgeOrder(unjudgedFor(db, draftId, mode), ctx, lastRead)
    if (mode === 'check' && check !== null) setProgress({ ...check, toJudge: findings.length })
    try {
      await judgeFindings(
        ctx,
        { ai: deps.requestDeps(db) },
        {
          findings,
          maxPairs: room,
          requestId,
          signal,
          onSpend: (usd) => deps.spend(db, usd, mode !== 'background'),
          ...(mode === 'check'
            ? {
                onCall: (run: JudgeRunResult) => {
                  if (check !== null) setProgress({ ...check, judged: run.sent })
                }
              }
            : {}),
          now: deps.now
        },
        result
      )
      return null
    } catch (err) {
      return { err }
    } finally {
      if (mode === 'background') addJudgeDay(db, today(), result.sent)
      pushed(db, result.settled)
    }
  }

  /** A failure as the job reports it: quiet for the daily cap and a background transient one. */
  const rethrow = (err: unknown, mode: RunMode): never => {
    if (err instanceof AiBudgetError) throw new JobSkippedError(HOLD.dailyCap)
    if (mode === 'background' && jobOutcome(err) === 'transient') {
      throw new JobSkippedError(`${HOLD.transient} ${errorText(err)}`)
    }
    throw err
  }

  /** A background run, or the rebuild's sweep when one is due. */
  const judge = async (db: TreeDb, requestId: string): Promise<FindingsJobResult> => {
    const due = dueSweep(db)
    const sweep = due !== null
    const mode: RunMode = sweep ? 'sweep' : 'background'
    const hold = holdOf(db, mode)
    // Tried once (`dueSweep`): run now, it is due no more.
    if (sweep) writeRow(db, MEMORY_JUDGE_SWEEP_KEY, null)
    if (hold !== null) throw new JobSkippedError(hold)
    const draftId = currentDraftId(db)
    if (draftId === null) return { requested: false, again: false, run: null, confirm: null }
    if (sweep) recomputeFirst(db, mode)
    const controller = registerInflight(requestId)
    // Filled as the calls return, so a run cut short still counts and pushes what it did.
    const result = emptyJudgeRun()
    let failed: { err: unknown } | null
    try {
      failed = await judgeRun(
        db,
        draftId,
        requestId,
        mode,
        controller.signal,
        result,
        due?.pairs ?? JUDGE_SWEEP_PAIRS
      )
    } finally {
      releaseInflight(requestId)
      if (due !== null) {
        const keys = findingsOf(db, draftId, ['open'])
          .filter((finding) => finding.created >= due.rebuildAt)
          .map((finding) => finding.key)
        deps.swept?.(db, due.rebuildAt, keys)
      }
    }
    if (failed !== null) rethrow(failed.err, mode)
    // After a sweep, background judging takes up what is left (within its own limits).
    const again =
      result.left > 0 &&
      (sweep || (result.sent > 0 && judgeDay(db, today()).pairs < JUDGE_DAY_PAIRS))
    return { requested: result.requested, again, run: result, confirm: null }
  }

  /** *Check the book*: recompute with C7, judge every unjudged pair, confirm, report. */
  const checkBook = async (db: TreeDb, requestId: string): Promise<FindingsJobResult> => {
    const hold = holdOf(db, 'check')
    if (hold !== null) {
      // Met as it began (since *Check*: the cap reached by queued work, the switch turned off, the
      // provider removed): it ends at once with the hold, so the dialog waiting on it says why.
      const at = deps.now().toISOString()
      setProgress({
        startedAt: at,
        finishedAt: at,
        judged: 0,
        toJudge: 0,
        confirmed: 0,
        toConfirm: 0,
        stopped: true,
        reason: hold
      })
      throw new JobSkippedError(hold)
    }
    const draftId = currentDraftId(db)
    if (draftId === null) return { requested: false, again: false, run: null, confirm: null }
    const startedAt = deps.now()
    setProgress({
      startedAt: startedAt.toISOString(),
      finishedAt: null,
      judged: 0,
      toJudge: 0,
      confirmed: 0,
      toConfirm: 0,
      stopped: false,
      reason: null
    })
    const unread = unreadScenes(db, findingsFrame(db), draftId)
    recomputeFirst(db, 'check')
    const controller = registerInflight(requestId)
    const result = emptyJudgeRun()
    const confirm = emptyConfirmRun()
    let failed: { err: unknown } | null = null
    try {
      failed = await judgeRun(db, draftId, requestId, 'check', controller.signal, result)
      if (failed === null) {
        const open = confirmOrder(
          findingsOf(db, draftId, ['open']).filter((finding) => finding.confirm === null),
          openScene
        )
        if (check !== null)
          setProgress({ ...check, toConfirm: Math.min(open.length, CHECK_CONFIRM_MAX) })
        try {
          await confirmFindings(
            judgeContext(db, draftId),
            { ai: deps.requestDeps(db) },
            {
              findings: open,
              max: CHECK_CONFIRM_MAX,
              requestId,
              signal: controller.signal,
              onSpend: (usd) => deps.spend(db, usd, true),
              onConfirmed: (run) => {
                if (check !== null) setProgress({ ...check, confirmed: run.settled.length })
              },
              now: deps.now
            },
            confirm
          )
        } catch (err) {
          failed = { err }
        } finally {
          pushed(db, confirm.settled)
        }
      }
    } finally {
      releaseInflight(requestId)
      writeCheckReport(db, {
        at: deps.now(),
        costUsd: result.costUsd + confirm.costUsd,
        stopped: failed !== null,
        unreadScenes: unread
      })
      if (check !== null) {
        setProgress({
          ...check,
          finishedAt: deps.now().toISOString(),
          stopped: failed !== null,
          reason: failed === null ? null : checkFailure(failed.err)
        })
      }
    }
    if (failed !== null) {
      // A Stop keeps what was judged and its report; nothing else to say.
      if (failed.err instanceof AiCancelledError) throw failed.err
      rethrow(failed.err, 'check')
    }
    return {
      requested: result.requested || confirm.requested,
      again: false,
      run: result,
      confirm
    }
  }

  return {
    read(nodeId) {
      lastRead = nodeId
    },

    wanted(db) {
      const draftId = currentDraftId(db)
      if (draftId === null) return false
      const mode: RunMode = dueSweep(db) !== null ? 'sweep' : 'background'
      // A due sweep (not held: `dueSweep`) is wanted even with nothing unjudged yet: it recomputes
      // first.
      if (mode === 'sweep') return true
      return holdOf(db, mode) === null && unjudgedFor(db, draftId, mode).length > 0
    },

    judge,

    checkBook,

    askedHold,

    checkAsked(openNodeId) {
      openScene = openNodeId
    },

    sweepDue(db, rebuildAt, scenes) {
      const pairs = sweepPairs(scenes)
      if (pairs > 0) writeRow(db, MEMORY_JUDGE_SWEEP_KEY, { rebuildAt, pairs })
    },

    waiting(db) {
      const draftId = currentDraftId(db)
      if (draftId === null || askedHold(db) !== null) return 0
      const held = judgeDay(db, today()).pairs >= JUDGE_DAY_PAIRS || deps.cloudCapped(db)
      return held ? unjudgedFor(db, draftId, 'background').length : 0
    },

    progress: () => check,

    clear() {
      lastRead = null
      openScene = null
      check = null
    }
  }
}
