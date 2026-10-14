import { z } from 'zod'
import { backgroundCandidates, candidatesC7 } from '@shared/memory/candidates'
import {
  FINDING_RULES,
  FindingRule,
  RULE_ORDER,
  verdictOf,
  type Finding,
  type FindingRule as FindingRuleT,
  type FindingSide
} from '@shared/memory/findings'
import { knowsLine, LEARNS, parseHow } from '@shared/memory/knows'
import {
  CHECK_NOT_COVERED,
  SceneRefView,
  type CheckEstimate,
  type CheckReport
} from '@shared/memory/views'
import { cancelInflight } from '../../ai/inflight'
import {
  JUDGE_PROMPT_VERSION,
  buildJudgeConfirmPrompt,
  judgeBatches,
  parseJudgeConfirm
} from '../../ai/prompts/judge.v1'
import { AiCancelledError } from '../../ai/providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from '../../ai/request'
import { estimateCost } from '../../knowledge/conversion'
import { currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { getRecord } from '../recordStore'
import { dueScenes } from '../reading/backlog'
import { slotClaims } from '../reading/claimStore'
import { storedKnows } from '../reading/knowsViews'
import { readRow, writeRow } from '../reading/readerRows'
import { sceneReadFlags } from '../reading/sceneReadStore'
import { plannedRow, type RebuildContext } from '../switchover/plan'
import { candidateInputs, findingsFrame, type FindingsFrame } from './candidateInputs'
import { findingsOf, setConfirm } from './findingStore'
import { findingView } from './findingViews'
import { confirmPair, judgeContext, pairItem, readPair, type JudgeContext } from './judge'
import { cacheVerdict, cachedVerdict, peekVerdict } from './verdictCache'

/**
 * *Check the book* (F-16.30; design §2.4, plan P4 §3.1, P4-D22): asked and priced first. It finds
 * every candidate (C1–C6 and C7), judges every pair no remembered verdict covers (the fast judge,
 * both orders, as the background does but with no daily pair limit), then has the strong model
 * confirm the open findings, at most 20, one pair a call at three sentences either side: `c`
 * confirms, `ok` clears it (listed as "the stronger check found no contradiction"), `u` makes it
 * unclear (shown as unclear). Its report says what it checked and what it did not.
 *
 * - **Price** (`estimateCheck`): local, nothing written: the pair-orders the cache lacks give the
 *   fast calls (their batches), the open findings not yet confirmed (and not remembered for the
 *   strong tier) give the confirmations; about = those plus a quarter of the new pairs, at most =
 *   every pair that could open, never past 20; priced from the registry rows (`judge.v1`,
 *   `judge.v1:pro`) on the models set up, as *Rebuild memory* is. "Free" when nothing would go.
 * - **Confirm** (`confirmFindings`): in `RULE_ORDER`, those touching the open scene first within a
 *   rule, then newest; each pair's strong verdict is remembered under its own key, so a repeat on an
 *   unchanged book sends nothing. A Stop cancels the call in flight; what was judged stays.
 * - **Report** (the `memoryCheck` settings row, `checkReport`): the run's figures and the keys of
 *   what it found; the findings are read again when the report is asked for, so one closed since
 *   (*Not a problem*, *Update my note*, a revision) is left out. Secrets readers know with no
 *   learning line by anyone are kept as their scenes and "checked up to" only (rule 5).
 */

/** The stronger check's confirmations at most per check (design §2.4). */
export const CHECK_CONFIRM_MAX = 20

/** The settings row holding the last check's report. */
export const MEMORY_CHECK_KEY = 'memoryCheck'

const KeyList = z.array(z.string())

/** The report as stored: the run's figures and the lifecycle keys of what it found. */
const StoredCheck = z.object({
  at: z.string(),
  draftId: z.string(),
  costUsd: z.number().nonnegative(),
  stopped: z.boolean(),
  keys: z.object({ found: KeyList, unclear: KeyList, cleared: KeyList, hidden: KeyList }),
  confirmed: z.number().int().nonnegative(),
  checked: z.object({
    pairs: z.number().int().nonnegative(),
    byRule: z.record(FindingRule, z.number().int().nonnegative()),
    scenes: z.number().int().nonnegative(),
    notes: z.number().int().nonnegative()
  }),
  notChecked: z.object({
    unreadScenes: z.array(SceneRefView),
    pastConfirm: z.number().int().nonnegative(),
    unjudged: z.number().int().nonnegative()
  }),
  secrets: z.array(z.object({ secretId: z.string(), readersSince: SceneRefView.nullable() })),
  checkedUpTo: SceneRefView.nullable()
})
type StoredCheck = z.infer<typeof StoredCheck>

/**
 * The readable scenes with words that are not read yet for the check's purposes: a finished
 * sentence the gate would read (`dueScenes`), or never read for secrets and threads
 * (`topicsRead`); in reading order.
 */
export function unreadScenes(
  db: TreeDb,
  frame: FindingsFrame,
  draftId: string | null
): SceneRefView[] {
  if (draftId === null) return []
  const due = new Set(dueScenes(db).map((scene) => scene.nodeId))
  const flags = sceneReadFlags(db, draftId)
  return frame.nodes
    .filter(
      (row) =>
        row.kind === 'document' &&
        (row.wordCount ?? 0) > 0 &&
        frame.reading.order.has(row.id) &&
        (due.has(row.id) || flags.get(row.id)?.topicsRead !== true)
    )
    .map((row) => row.id)
    .sort((a, b) => (frame.reading.order.get(a) ?? 0) - (frame.reading.order.get(b) ?? 0))
    .map((nodeId) => ({ nodeId, ref: frame.reading.refs.get(nodeId) ?? '' }))
}

/**
 * The scenes the check looked at: the readable scenes with words in reading order, less those it
 * lists as not read yet (`unreadScenes`), which no rule has seen.
 */
function checkedScenes(frame: FindingsFrame, unread: readonly SceneRefView[]): number {
  const left = new Set(unread.map((scene) => scene.nodeId))
  return frame.nodes.filter(
    (row) =>
      row.kind === 'document' &&
      (row.wordCount ?? 0) > 0 &&
      frame.reading.order.has(row.id) &&
      !left.has(row.id)
  ).length
}

const sameSide = (x: FindingSide, y: FindingSide): boolean =>
  JSON.stringify(x) === JSON.stringify(y)

/**
 * The price of *Check the book* now (local; nothing is written, the cache is only peeked):
 * see the module comment.
 */
export function estimateCheck(db: TreeDb, context: RebuildContext): CheckEstimate {
  const draftId = currentDraftId(db)
  const frame = findingsFrame(db)
  const base: CheckEstimate = {
    free: true,
    pairs: 0,
    uncached: 0,
    fastCalls: 0,
    confirms: { about: 0, most: 0 },
    aboutUsd: 0,
    mostUsd: 0,
    priced: true,
    hidden: 0,
    unreadScenes: unreadScenes(db, frame, draftId),
    cloud: context.source === 'cloud',
    fastModel: context.fastModel,
    strongModel: context.strongModel
  }
  if (draftId === null) return base
  const inputs = candidateInputs(db, draftId, frame)
  const ctx = judgeContext(db, draftId, frame, inputs)
  const rows = new Map(findingsOf(db, draftId).map((row) => [row.key, row]))
  let pairs = 0
  let hidden = 0
  let due = 0
  const lacking: {
    item: NonNullable<ReturnType<typeof pairItem>>['item']
    ab: boolean
    ba: boolean
  }[] = []
  for (const each of [...backgroundCandidates(inputs), ...candidatesC7(inputs)]) {
    if (each.held) continue
    if (each.hidden) {
      hidden += 1
      continue
    }
    const row = rows.get(each.key)
    const same = row !== undefined && sameSide(row.a, each.a) && sameSide(row.b, each.b)
    const stored = same ? (row?.rendered ?? null) : null
    const read = readPair(ctx, each, stored)
    if (read.keys === null) continue
    pairs += 1
    // The row's verdicts stand while its rendering does; otherwise the cache is asked.
    const kept = same && row !== undefined && read === stored ? row : null
    const ab = kept?.verdictAb ?? peekVerdict(db, read.keys.ab)?.verdict ?? null
    const ba = kept?.verdictBa ?? peekVerdict(db, read.keys.ba)?.verdict ?? null
    const state = verdictOf(ab, ba)
    if (state === 'unjudged') {
      const pair = pairItem(ctx, each)
      if (pair !== null) lacking.push({ item: pair.item, ab: ab === null, ba: ba === null })
      continue
    }
    if (state !== 'open' || (kept?.confirm ?? null) !== null) continue
    const strong = confirmPair(ctx, each)
    if (strong !== null && peekVerdict(db, strong.key) === null) due += 1
  }
  let fastCalls = 0
  let uncached = 0
  for (const batch of judgeBatches(lacking)) {
    if (batch.some((each) => each.ab)) fastCalls += 1
    if (batch.some((each) => each.ba)) fastCalls += 1
  }
  for (const each of lacking) uncached += Number(each.ab) + Number(each.ba)
  const about = Math.min(CHECK_CONFIRM_MAX, due + Math.ceil(lacking.length / 4))
  const most = Math.min(CHECK_CONFIRM_MAX, due + lacking.length)
  const judgeRow = plannedRow('judge.v1')
  const proRow = plannedRow('judge.v1:pro')
  const fast = estimateCost(
    { source: context.source, model: context.fastModel, pricing: context.pricing },
    fastCalls * judgeRow.typicalInTokens,
    fastCalls * judgeRow.typicalOutTokens
  )
  const strong = (calls: number): { costUsd: number; priced: boolean } =>
    estimateCost(
      { source: context.source, model: context.strongModel, pricing: context.pricing },
      calls * proRow.typicalInTokens,
      calls * proRow.typicalOutTokens
    )
  const proAbout = strong(about)
  const proMost = strong(most)
  return {
    ...base,
    free: fastCalls === 0 && most === 0,
    pairs,
    uncached,
    fastCalls,
    confirms: { about, most },
    aboutUsd: fast.costUsd + proAbout.costUsd,
    mostUsd: fast.costUsd + proMost.costUsd,
    priced: fast.priced && proAbout.priced && proMost.priced,
    hidden
  }
}

/**
 * The price of judging `pairs` background pairs left for *Check the book* (the `findingsWaiting`
 * notice): both orders of their batches of ten, from the `judge.v1` row on the fast model.
 */
export function priceWaiting(pairs: number, context: RebuildContext): number {
  const calls = 2 * Math.ceil(pairs / 10)
  const row = plannedRow('judge.v1')
  return estimateCost(
    { source: context.source, model: context.fastModel, pricing: context.pricing },
    calls * row.typicalInTokens,
    calls * row.typicalOutTokens
  ).costUsd
}

const sideNode = (side: FindingSide): string | null => (side.kind === 'note' ? null : side.nodeId)

/**
 * The order the stronger check confirms open findings in (plan P4 §3.1): by rule (`RULE_ORDER`),
 * those touching the open scene first within a rule, then newest.
 */
export function confirmOrder(findings: readonly Finding[], openNodeId: string | null): Finding[] {
  const touches = (finding: Finding): number =>
    openNodeId !== null &&
    (sideNode(finding.a) === openNodeId || sideNode(finding.b) === openNodeId)
      ? 0
      : 1
  return [...findings].sort(
    (x, y) =>
      RULE_ORDER.indexOf(x.rule) - RULE_ORDER.indexOf(y.rule) ||
      touches(x) - touches(y) ||
      y.created.localeCompare(x.created)
  )
}

export interface ConfirmRunInput {
  /** Open findings with no stronger verdict yet, in `confirmOrder`. */
  findings: readonly Finding[]
  /** Calls at most (cached verdicts are free and not counted). */
  max: number
  /** The caller's id for `ai:cancel`; each call registers under `<requestId>:p<n>`. */
  requestId: string
  signal?: AbortSignal
  onSpend?: (usd: number) => void
  /** After each finding the stronger check settled (progress). */
  onConfirmed?: (result: ConfirmRunResult) => void
  now: () => Date
}

export interface ConfirmRunResult {
  requested: boolean
  /** Calls sent. */
  sent: number
  /** Findings whose stronger verdict was stored (from the cache or the strong model). */
  settled: Finding[]
  /** Open findings left for the next check (past `max`). */
  past: number
  /** Calls whose reply gave no verdict. */
  unanswered: number
  /** Findings not sent because a side is gone. */
  dropped: number
  costUsd: number
}

export const emptyConfirmRun = (): ConfirmRunResult => ({
  requested: false,
  sent: 0,
  settled: [],
  past: 0,
  unanswered: 0,
  dropped: 0,
  costUsd: 0
})

/**
 * The stronger check (F-16.30): each open finding's pair at three sentences either side, one call
 * a pair on the strong tier (reasoning off, `judge.v1`'s confirm render), at most `max` calls; a
 * remembered strong verdict is free. Each verdict lands only on the pair it was given for
 * (`setConfirm` with `expect`). `result` is filled as calls return, so a Stop (`AiCancelledError`)
 * or a failure still leaves what was confirmed counted.
 */
export async function confirmFindings(
  ctx: JudgeContext,
  deps: { ai: AiRequestDeps },
  input: ConfirmRunInput,
  result: ConfirmRunResult = emptyConfirmRun()
): Promise<ConfirmRunResult> {
  let inFlight: string | null = null
  const onAbort = (): void => {
    if (inFlight !== null) cancelInflight(inFlight)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (const finding of input.findings) {
      const strong = confirmPair(ctx, finding)
      if (strong === null) {
        result.dropped += 1
        continue
      }
      const expect = {
        a: finding.a,
        b: finding.b,
        extra: finding.extra,
        rendered: finding.rendered
      }
      const known = cachedVerdict(ctx.db, strong.key, input.now())
      if (known !== null) {
        const written = setConfirm(ctx.db, finding.id, {
          confirm: known.verdict,
          why: known.why,
          costUsd: 0,
          now: input.now(),
          expect
        })
        if (written) result.settled.push(finding)
        input.onConfirmed?.(result)
        continue
      }
      if (result.sent >= input.max) {
        result.past += 1
        continue
      }
      if (input.signal?.aborted === true) throw new AiCancelledError('Checking was stopped.')
      const prompt = buildJudgeConfirmPrompt(strong.pair)
      result.sent += 1
      inFlight = `${input.requestId}:p${result.sent}`
      const reply = await runAiRequest(deps.ai, {
        feature: 'judge',
        tier: 'strong',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        contextHash: sha256(JSON.stringify(prompt.messages)),
        promptVersion: JUDGE_PROMPT_VERSION,
        requestId: inFlight,
        cacheIf: (text) => parseJudgeConfirm(text) !== null
      })
      inFlight = null
      result.requested ||= !reply.cached
      result.costUsd += reply.costUsd
      input.onSpend?.(reply.costUsd)
      const ruling = parseJudgeConfirm(reply.text)
      const now = input.now()
      if (ruling === null) {
        result.unanswered += 1
        setConfirm(ctx.db, finding.id, { confirm: null, why: null, costUsd: reply.costUsd, now })
        input.onConfirmed?.(result)
        continue
      }
      cacheVerdict(
        ctx.db,
        {
          key: strong.key,
          verdict: ruling.r,
          why: ruling.w,
          tier: 'strong',
          promptVersion: JUDGE_PROMPT_VERSION,
          model: reply.model,
          costUsd: reply.costUsd
        },
        now
      )
      const written = setConfirm(ctx.db, finding.id, {
        confirm: ruling.r,
        why: ruling.w,
        costUsd: reply.costUsd,
        now,
        expect
      })
      if (written) result.settled.push(finding)
      input.onConfirmed?.(result)
    }
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }
  return result
}

/**
 * Secrets readers know by the end of the book that no counted learning line (saw, told,
 * overheard, read, deduced) gives anyone (design §2.7: in *Check the book* only), as the secret
 * and the scene readers have known it since; "checked up to" scopes them (rule 5: the renderer
 * words the scoped line, nothing here states an absence).
 */
export function secretsNobodyLearns(
  db: TreeDb,
  frame: FindingsFrame,
  draftId: string
): { secrets: StoredCheck['secrets']; checkedUpTo: SceneRefView | null } {
  const knows = storedKnows(db, null, frame.reading, frame.nodes)
  const learned = new Set(
    slotClaims(db, 'knows', draftId).flatMap((claim) => {
      const how = parseHow(claim.how)
      return claim.objectId !== null &&
        claim.state !== 'waiting' &&
        frame.reading.order.has(claim.nodeId) &&
        how !== null &&
        LEARNS.includes(how) &&
        knowsLine(claim) === 'counts'
        ? [claim.objectId]
        : []
    })
  )
  return {
    secrets: knows.secrets
      .filter(
        (secret) => secret.known && secret.readersSince !== null && !learned.has(secret.recordId)
      )
      .map((secret) => ({
        secretId: secret.recordId,
        readersSince:
          secret.readersSince === null
            ? null
            : { nodeId: secret.readersSince.nodeId, ref: secret.readersSince.ref }
      })),
    checkedUpTo: knows.checkedUpTo
  }
}

/** What a finished (or stopped) check reports, as `writeCheckReport` stores it. */
export interface CheckRunFigures {
  at: Date
  costUsd: number
  stopped: boolean
  /** The scenes not read yet when the check ran (`unreadScenes`). */
  unreadScenes: SceneRefView[]
}

/**
 * Stores the report of a check that just ended over the active draft: the findings as they now
 * stand (open, unclear, cleared by the stronger check, hidden as flashbacks), what was checked and
 * what was not, the secrets nobody learns. Answers the stored row.
 */
export function writeCheckReport(db: TreeDb, figures: CheckRunFigures): StoredCheck | null {
  const draftId = currentDraftId(db)
  if (draftId === null) return null
  const frame = findingsFrame(db)
  const findings = findingsOf(db, draftId)
  const keysIn = (test: (finding: Finding) => boolean): string[] =>
    findings.filter(test).map((finding) => finding.key)
  const judged = findings.filter(
    (finding) => finding.state !== 'held' && finding.state !== 'hidden'
  )
  const byRule = Object.fromEntries(FINDING_RULES.map((rule) => [rule, 0])) as Record<
    FindingRuleT,
    number
  >
  for (const finding of judged) byRule[finding.rule] += 1
  const inputs = candidateInputs(db, draftId, frame)
  const notes = new Set(inputs.notes.map((note) => `${note.ownerKind}:${note.ownerId}`))
  const knows = secretsNobodyLearns(db, frame, draftId)
  const stored: StoredCheck = {
    at: figures.at.toISOString(),
    draftId,
    costUsd: figures.costUsd,
    stopped: figures.stopped,
    keys: {
      found: keysIn((finding) => finding.state === 'open'),
      unclear: keysIn((finding) => finding.state === 'unclear'),
      cleared: keysIn((finding) => finding.state === 'fine' && finding.confirm === 'ok'),
      hidden: keysIn((finding) => finding.state === 'hidden')
    },
    confirmed: findings.filter((finding) => finding.state === 'open' && finding.confirm === 'c')
      .length,
    checked: {
      pairs: judged.filter((finding) => finding.state !== 'unjudged').length,
      byRule,
      scenes: checkedScenes(frame, figures.unreadScenes),
      notes: notes.size
    },
    notChecked: {
      unreadScenes: figures.unreadScenes,
      pastConfirm: findings.filter(
        (finding) => finding.state === 'open' && finding.confirm === null
      ).length,
      unjudged: findings.filter((finding) => finding.state === 'unjudged').length
    },
    secrets: knows.secrets,
    checkedUpTo: knows.checkedUpTo
  }
  writeRow(db, MEMORY_CHECK_KEY, stored)
  return stored
}

/**
 * The last check's report (`memory:checkReport`), its findings read again as they stand now: a
 * finding closed or moved out of its state since is left out; a secret or record gone is too.
 * Null before any check, or for a check of another draft.
 */
export function checkReport(db: TreeDb): CheckReport | null {
  const stored = readRow(db, MEMORY_CHECK_KEY, StoredCheck.nullable(), null)
  const draftId = currentDraftId(db)
  if (stored === null || draftId === null || stored.draftId !== draftId) return null
  const findings = new Map(findingsOf(db, draftId).map((finding) => [finding.key, finding]))
  let ctx: JudgeContext | null = null
  const viewsOf = (
    keys: readonly string[],
    state: Finding['state']
  ): NonNullable<ReturnType<typeof findingView>>[] =>
    keys.flatMap((key) => {
      const finding = findings.get(key)
      if (finding?.state !== state) return []
      ctx ??= judgeContext(db, draftId)
      const view = findingView(ctx, finding)
      return view === null ? [] : [view]
    })
  const cleared = viewsOf(stored.keys.cleared, 'fine')
  return {
    at: stored.at,
    draftId: stored.draftId,
    costUsd: stored.costUsd,
    stopped: stored.stopped,
    found: viewsOf(stored.keys.found, 'open'),
    unclear: viewsOf(stored.keys.unclear, 'unclear'),
    cleared,
    confirmed: stored.confirmed,
    checked: stored.checked,
    notChecked: { fixed: [...CHECK_NOT_COVERED], ...stored.notChecked },
    // One line per scene that hides a finding (both sides of a C2 body change can), each naming
    // whether the scene's Flashback switch or the card's reading makes it one.
    hidden: viewsOf(stored.keys.hidden, 'hidden').flatMap((view) =>
      view.actions.notFlashback.map((nodeId) => {
        const side = [view.a, view.b].find((each) => each.nodeId === nodeId)
        return {
          findingId: view.id,
          nodeId,
          ref: side?.ref ?? '',
          label: `${view.name}: ${view.slotLabel}`,
          typed: ctx?.inputs.typed.get(nodeId)?.flashback === true
        }
      })
    ),
    secretsNobodyLearns: stored.secrets.flatMap((secret) => {
      const record = getRecord(db, secret.secretId)
      return record === null
        ? []
        : [
            {
              secretId: secret.secretId,
              label: record.name,
              readersSince: secret.readersSince,
              checkedUpTo: stored.checkedUpTo
            }
          ]
    })
  }
}
