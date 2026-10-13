import { z } from 'zod'
import type { AiProviderId } from '@shared/ai'
import { isFeatureAllowed, type AiSettings } from '@shared/aiSettings'
import { RULE_ORDER, type Finding, type FindingSide } from '@shared/memory/findings'
import { dayOf, rollIfNewDay } from '../../ai/dailyCap'
import { registerInflight, releaseInflight } from '../../ai/inflight'
import { AiBudgetError } from '../../ai/providers/types'
import type { AiRequestDeps } from '../../ai/request'
import { currentDraftId } from '../../draft/draftStore'
import { JobSkippedError } from '../../jobs/indexQueue'
import type { TreeDb } from '../../tree/treeStore'
import { readRow, writeRow } from '../reading/readerRows'
import { countFindings, findingsOf } from './findingStore'
import { findingCounts, type FindingCounts } from './findingsJob'
import { judgeContext, judgeFindings, type JudgeContext, type JudgeRunResult } from './judge'

/**
 * The contradiction judge's jobs (F-16.27, F-16.30; plan P4 §2.3, P4-D12), on the reader's
 * provider-backed queue (`readerService` only dispatches `judge` and `checkBook` here).
 *
 * - **Background** (`judge`): queued by the `findings` job when unjudged pairs exist and the
 *   switch allows; at most 10 pairs a run (two calls), the scene just read first, then by rule
 *   (`RULE_ORDER`) and reading order; it queues itself again while unjudged pairs remain, up to 30
 *   pairs a day; the rest wait for *Check the book*. Never while a *Rebuild memory* runs (its sweep
 *   is slice 3's). Gates before any request: Use AI and the **Contradiction check** switch, a
 *   provider, the day's pairs, the daily cap and, on Cloud, the monthly cap for background spend
 *   (P2a-D9). A hold throws `JobSkippedError`: the job goes quietly, the queue never pauses for it
 *   (reading behind it runs), and the next change that moves a finding queues it again.
 * - **Check the book** (`checkBook`, asked): every unjudged pair, as asked spend (past the Cloud
 *   cap, never past the daily cap), with no daily pair limit. Slice 3 adds C7, the stronger check
 *   and the report.
 *
 * Every call's cost goes to the Cloud tally as it returns (`spend`), and is shared out to the
 * findings it judged (`judge.ts`). After a run that stored verdicts, `memory:findingsChanged` and
 * `memory:changed` (the judged findings' scenes and records) are pushed.
 */

/** Pairs at most per background run (two calls: both orders). */
export const JUDGE_RUN_PAIRS = 10
/** Pairs at most the background judges a day (the rest wait for *Check the book*). */
export const JUDGE_DAY_PAIRS = 30

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
  cloudCap: 'Background checks reached your Cloud cap for this month.'
} as const

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
  now: () => Date
}

/** What one judge or check job did. */
export interface FindingsJobResult {
  /** A request left (the queue's rate limit counts it). */
  requested: boolean
  /** Background only: unjudged pairs remain and today's limit allows another run. */
  again: boolean
  run: JudgeRunResult | null
}

export interface FindingsService {
  /** A scene was just read: its findings are judged first in the next background run. */
  read(nodeId: string): void
  /** Whether a background run may be queued now and has something to judge. */
  wanted(db: TreeDb): boolean
  judge(db: TreeDb, requestId: string): Promise<FindingsJobResult>
  checkBook(db: TreeDb, requestId: string): Promise<FindingsJobResult>
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

export function createFindingsService(deps: FindingsServiceDeps): FindingsService {
  let lastRead: string | null = null

  const today = (): string => dayOf(deps.now())

  /** Whether today's AI spend already reached the daily cap. */
  const dailyCapped = (db: TreeDb): boolean => {
    const day = rollIfNewDay(deps.requestDeps(db).dailyCap.get(), today())
    return day.spentTodayUsd >= day.dailyCapUsd
  }

  /** What holds the judge back (`asked`: Check the book), or null. */
  const holdOf = (db: TreeDb, asked: boolean): string | null => {
    if (!isFeatureAllowed(deps.settings(db), 'judge')) return HOLD.off
    if (deps.provider(db) === null) return HOLD.provider
    if (!asked && deps.rebuilding(db)) return HOLD.rebuild
    if (!asked && judgeDay(db, today()).pairs >= JUDGE_DAY_PAIRS) return HOLD.dayPairs
    if (dailyCapped(db)) return HOLD.dailyCap
    if (!asked && deps.cloudCapped(db)) return HOLD.cloudCap
    return null
  }

  /** Pushes what a run moved: the counts, and the judged findings' scenes and records. */
  const pushed = (db: TreeDb, run: JudgeRunResult): void => {
    if (run.judged.length === 0) return
    deps.findingsChanged?.(findingCounts(db))
    const nodeIds = new Set<string>()
    const recordIds = new Set<string>()
    for (const finding of run.judged) {
      recordIds.add(finding.recordId)
      for (const side of [finding.a, finding.b]) {
        const nodeId = sideNode(side)
        if (nodeId !== null) nodeIds.add(nodeId)
      }
    }
    deps.changed({ nodeIds: [...nodeIds].sort(), recordIds: [...recordIds].sort() })
  }

  /** One run over the active draft's unjudged findings. */
  const run = async (db: TreeDb, requestId: string, asked: boolean): Promise<FindingsJobResult> => {
    const hold = holdOf(db, asked)
    if (hold !== null) throw new JobSkippedError(hold)
    const draftId = currentDraftId(db)
    if (draftId === null) return { requested: false, again: false, run: null }
    const day = judgeDay(db, today())
    const room = asked
      ? Number.MAX_SAFE_INTEGER
      : Math.min(JUDGE_RUN_PAIRS, JUDGE_DAY_PAIRS - day.pairs)
    const ctx = judgeContext(db, draftId)
    const findings = judgeOrder(findingsOf(db, draftId, ['unjudged']), ctx, lastRead)
    const controller = registerInflight(requestId)
    let result: JudgeRunResult
    try {
      result = await judgeFindings(
        ctx,
        { ai: deps.requestDeps(db) },
        {
          findings,
          maxPairs: room,
          requestId,
          signal: controller.signal,
          onSpend: (usd) => deps.spend(db, usd, asked),
          now: deps.now
        }
      )
    } catch (err) {
      // The daily cap reached mid-run: what was judged stays; the rest waits, quietly.
      if (err instanceof AiBudgetError) throw new JobSkippedError(HOLD.dailyCap)
      throw err
    } finally {
      releaseInflight(requestId)
    }
    if (!asked) addJudgeDay(db, today(), result.sent)
    pushed(db, result)
    const again =
      !asked && result.sent > 0 && result.left > 0 && judgeDay(db, today()).pairs < JUDGE_DAY_PAIRS
    return { requested: result.requested, again, run: result }
  }

  return {
    read(nodeId) {
      lastRead = nodeId
    },

    wanted(db) {
      if (holdOf(db, false) !== null) return false
      const draftId = currentDraftId(db)
      return draftId !== null && countFindings(db, draftId, 'unjudged') > 0
    },

    judge: (db, requestId) => run(db, requestId, false),

    checkBook: (db, requestId) => run(db, requestId, true),

    clear() {
      lastRead = null
    }
  }
}
