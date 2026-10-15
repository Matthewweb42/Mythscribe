import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  estimateTokens,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODELS,
  type Tier
} from '@shared/ai'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import { PROJECT_NOTES_NAME } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import { containsInlineTag } from '@shared/memory/inlineTagReplace'
import { normName } from '@shared/memory/names'
import { pageTextBlocks } from '@shared/memory/pageMarks'
import { isTopicKind } from '@shared/memory/topics'
import type {
  SwitchoverConsent,
  SwitchoverOutcome,
  SwitchoverPlan
} from '@shared/memory/switchover'
import type { MemoryNotice, RebuildSummary } from '@shared/memory/views'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppStateStore } from '../../appState/appStateStore'
import { BackupService } from '../../backups/backupService'
import { draftText, node, snapshot, snapshotText } from '../../db/schema'
import { rollbackSnapshot } from '../../db/snapshot'
import { activeDraftId } from '../../draft/draftStore'
import { dismissedKeys } from '../../memory/dismissedStore'
import { findingsFrame } from '../../memory/findings/candidateInputs'
import { sweepCalls } from '../../memory/findings/findingsService'
import { findingsOf, invariantFindings } from '../../memory/findings/findingStore'
import { runFindingsJob } from '../../memory/findings/findingsJob'
import { scanNamesFor, staleNameScans } from '../../memory/nameIndexer'
import {
  indexNodePassages,
  indexStaleRecords,
  stalePassageOwners
} from '../../memory/passageIndexer'
import { rebuildEstimate } from '../../memory/reading/backlog'
import { draftClaims } from '../../memory/reading/claimStore'
import { getRebuild } from '../../memory/reading/readerRows'
import { createReaderService, type ReaderService } from '../../memory/reading/readerService'
import { requestKind } from '../../memory/reading/readingFixture'
import { getRecord, listRecords } from '../../memory/recordStore'
import { storedSceneDetails } from '../../memory/sceneDetailStore'
import {
  inlineTagReplacements,
  planSwitchover,
  type RebuildContext
} from '../../memory/switchover/plan'
import { getSwitchoverRecord } from '../../memory/switchover/record'
import {
  runConvert,
  switchoverSafety,
  type SafetyMemo,
  type SwitchoverRunDeps
} from '../../memory/switchover/run'
import { TEST_BOOK, testBookScene } from '../../memory/testBook/book'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import {
  addTestBookNotes,
  addTestBookPages,
  buildTestBookProject,
  TEST_BOOK_CATEGORY,
  type TestBookProject
} from '../../memory/testBook/project'
import { buildTestBookV1Project, type TestBookV1Project } from '../../memory/testBook/projectV1'
import { ProjectManager } from '../../project/manager'
import { getStoryMemory } from '../../project/settingsStore'
import { researchDocumentIds } from '../../research/researchTree'
import type { Schedule } from '../../schedule'
import { listNodes, renameNode, type TreeDb } from '../../tree/treeStore'
import { defaultMemoryCloudState, type MemoryCloudState } from '../cloudTally'
import { jobOutcome } from '../../jobs/indexQueue'
import { cancelInflight } from '../inflight'
import { AiBudgetError, type AiMessage, type Provider } from '../providers/types'
import { fakeChatServer, type ChatServer, type ChatServerReply } from './fakeChatServer'
import { judgeOracleReply } from './judgeOracle'
import {
  liveProviderError,
  liveProviderFromEnv,
  liveRequestDeps,
  recordingProvider,
  type CapturedCall,
  type LiveProvider,
  type LiveRequestDeps
} from './liveProvider'
import { acceptAll, invariants, oracleRead, oracleVerify, sceneOf } from './memoryOracle'
import {
  cutLines,
  plantedBarLines,
  plantedFailures,
  plantedMeasures,
  unreviewedLines,
  type PlantedMeasures
} from './plantedScore'

/**
 * The switch-over of a v1 project, replayed on the test book (F-16.31 part A, F-16.3, F-5.12;
 * plan `Switchover.md` §5.2, §5.3), `npm run eval:ai` (and so `npm run test`):
 *
 * - **The offline replay**: the test book built the way a v1 author has it
 *   (`buildTestBookV1Project`: sheets and tags, inline tags, scene meta, a timeline, a Plan sheet,
 *   what the AI made, a snapshot, h10 in an inactive draft) in a temporary "My Drive" folder,
 *   opened through a `ProjectManager` that sees Google Drive (the author's set-up). The dry run
 *   lists every labelled record as converted, the AI-written field under Filed by AI, the AI's
 *   facts and summaries as dropped, and offers the split pair (Callum Varrow and the `varrow` tag)
 *   and no other (SW-D15: the book's families and places are never offered);
 *   then `switchoverSafety` and `runConvert` with the default words and that merge ticked, as the
 *   dialog sends them. After the reopen on v2: the prose is the test book's, byte for byte, in
 *   both drafts; the snapshot is byte-identical; no inline tag is left; the records are the labels'
 *   (names, nicknames, shared surnames); the invariants hold; the dry run's price is
 *   `rebuildEstimate`'s. Then *Rebuild memory* through the reader service, as the app runs it
 *   (the notice while it waits, the ask, the reading, the spot checks, the contradiction sweep),
 *   answered by the oracle reader and checker (`memoryOracle.ts`) and the oracle judge
 *   (`judgeOracle.ts`) behind a fake OpenRouter: the claims and findings are the same as the same
 *   rebuild of the v2-built book (`buildTestBookProject` with the same pages and notes, which the
 *   v1 book keeps as sheet text), the author's pages (every named record's, converted ones
 *   included, and every Research page) are byte-identical before and after, the invariants hold
 *   with the findings in, the record ends `started` and the notice goes.
 * - **The adversarial replay**: a paragraph lost inside the conversion (planted with a temporary
 *   trigger) is refused by `checkConverted`; the project stays v1, its bytes as they were.
 * - **The live switch-over run** (`runLiveSwitchover`; `MYTHSCRIBE_EVAL_LIVE=1`; part A's live test,
 *   decision SW-D13, owed by the author before her real switch; it cannot run in the build
 *   sessions, which have no key):
 *
 *       MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- switchover
 *
 *   (`OPENAI_API_KEY`, with `OPENAI_BASE_URL` for another server, still works through
 *   `liveProvider.ts`.) The same conversion, then *Rebuild memory* with the real `reader.v2`,
 *   `verify.v2` and the sweep's `judge.v1` on the default models (V4 Flash fast, V4 Pro for the
 *   strong spot checks), at the app's own pace. It stops once the reported cost passes 50¢ (about
 *   3–5¢ expected: 18 scenes read, the Idea scene, the cut scene and h10 never) and writes
 *   `test-results/eval-switchover/switchover-<date>.md` and `.json` (no prompt text, no key). Bars
 *   (`SWITCHOVER_PASS_BARS`): the actual cost within 0.5–1.5× of the price the dry run asked, the
 *   time reported against its minutes, the memory bars of `-- memory` (`plantedScore.ts`) met on
 *   the converted book, the author's pages untouched, and no request carrying sheet text the AI
 *   wrote, an Ideas line or an AI row the switch leaves in v1's tables. A rate limit or a network
 *   error is retried as the app's queue retries it. Offline tests drive it end to end against a
 *   fake OpenRouter: the report, the 50¢ stop, a rate limit retried, a hard provider error, an
 *   unpriced model.
 */

const LIVE = process.env.MYTHSCRIBE_EVAL_LIVE === '1'
const NOW = new Date(Date.UTC(2026, 9, 14, 12, 0, 0))

/** Use AI on, every feature on (the reading, the checker, the Contradiction check). */
const SETTINGS: AiSettings = { ...defaultAiSettings(), dial: 1 }

/** The live run stops once its reported cost passes this. */
const LIVE_STOP_USD = 0.5

/** The live run's pass bars (decided by Claude, unconfirmed; decision SW-D13). */
export const SWITCHOVER_PASS_BARS = {
  /** The rebuild's reported cost against the price the dry run asked. */
  costRatioMin: 0.5,
  costRatioMax: 1.5,
  /** Author pages (Pinned, Ideas, Research) whose stored text the rebuild changed. */
  pagesChanged: 0,
  /**
   * Requests that carried sheet text the AI wrote (Filed by AI earlier), an Ideas line, or a v1 AI
   * row the switch leaves frozen (the sheet it made, an old scene summary).
   */
  notCanonSent: 0
} as const

/** Where the dry run and *Rebuild memory* price on: an own key on the models given. */
const contextFor = (models: Record<Tier, string>): RebuildContext => ({
  source: 'ownKey',
  fastModel: models.fast,
  strongModel: models.strong,
  pricing: null
})

const noSchedule: Schedule = () => () => undefined

/** Waits until `ready` holds, polling (the reader's queue works on timers); false at the limit. */
async function waitFor(ready: () => boolean, limitMs: number): Promise<boolean> {
  const end = Date.now() + limitMs
  while (!ready()) {
    if (Date.now() > end) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return true
}

/** How long *Rebuild memory* may take before the run stops it and reports so (25 minutes). */
const REBUILD_LIMIT_MS = 1_500_000

// ---- The switch on a temporary Google Drive folder -------------------------------------------

/** The test book switched over, reopened on story memory v2. */
export interface SwitchedTestBook {
  /** The v1 build, as it was made (its session is closed). */
  v1: TestBookV1Project
  /** The dry run the author read. */
  plan: SwitchoverPlan
  /** What she consented to: the default words, the split pair merged. */
  consent: SwitchoverConsent
  /** The kept backup and the dated copy beside the project. */
  safety: { backup: string; datedCopy: string }
  outcome: SwitchoverOutcome
  /** The snapshot rows before the switch, as stored. */
  snapshotsBefore: string
  /** The converted project, open, as the replays read it. */
  book: TestBookProject
  /** The "My Drive" folder the project lives in. */
  drive: string
  close(): void
}

/** The split pair: the merge the author ticks (Callum Varrow and the `varrow` tag's record). */
const SPLIT = { keep: 'Callum Varrow', merge: 'Varrow' } as const

/** Every snapshot row and snapshot text, in key order, as JSON (the bytes the check compares). */
function snapshotRows(db: TreeDb): string {
  return JSON.stringify([
    db.select().from(snapshot).orderBy(asc(snapshot.id)).all(),
    db
      .select()
      .from(snapshotText)
      .orderBy(asc(snapshotText.snapshotId), asc(snapshotText.nodeId))
      .all()
  ])
}

/** The derived indexes the app builds when a v2 project opens (`queueMemoryIndex`). */
function indexOnOpen(db: TreeDb, now: Date): void {
  for (const nodeId of staleNameScans(db)) scanNamesFor(db, nodeId, now)
  const stale = stalePassageOwners(db)
  for (const id of new Set(stale.filter((owner) => owner.kind !== 'record').map((o) => o.id))) {
    indexNodePassages(db, id, now)
  }
  if (stale.some((owner) => owner.kind === 'record')) indexStaleRecords(db, now)
}

/** Label record id → the project's record id, by the record's name. */
function recordsByLabel(db: TreeDb): Map<string, string> {
  const byName = new Map(listRecords(db).map((row) => [row.name, row.id]))
  const records = new Map<string, string>()
  for (const label of TEST_BOOK_LABELS.records) {
    const id = byName.get(label.name)
    if (id !== undefined) records.set(label.id, id)
  }
  return records
}

/** The test book on v1, open in Drive with its copies made and its dry run read: Convert is next. */
export interface ReadyToConvert {
  v1: TestBookV1Project
  plan: SwitchoverPlan
  consent: SwitchoverConsent
  safety: { backup: string; datedCopy: string }
  snapshotsBefore: string
  drive: string
  manager: ProjectManager
  deps: SwitchoverRunDeps
  memo: SafetyMemo
  close(): void
}

/**
 * The test book built on v1 in `<tmp>/My Drive/` and opened through a `ProjectManager` that sees
 * Google Drive, as the installed app opens the author's project; then the safety step (the Drive
 * working copy flushed, a kept backup, a dated copy beside the project), the dry run, and the
 * consent the dialog sends with the default words and the split pair ticked. Throws when a step
 * fails (a replay expects every step to work).
 */
export function readyToConvert(
  tmp: string,
  options: { now: Date; context: RebuildContext }
): ReadyToConvert {
  const drive = path.join(tmp, 'My Drive')
  fs.mkdirSync(drive, { recursive: true })
  const v1 = buildTestBookV1Project(drive, options.now)
  const snapshotsBefore = snapshotRows(v1.db)
  v1.session.close()
  const inDrive = (target: string): boolean =>
    path.resolve(target).startsWith(`${path.resolve(drive)}${path.sep}`)
  const manager = new ProjectManager({
    workingRoot: () => path.join(tmp, 'working'),
    detectCloud: (target) => (inDrive(target) ? 'googleDrive' : null)
  })
  let clock = options.now.getTime()
  const backups = new BackupService({
    appState: new AppStateStore(path.join(tmp, 'userData', 'app-state.json')),
    projects: manager,
    defaultFolder: path.join(tmp, 'backups'),
    onChange: () => undefined,
    schedule: noSchedule,
    now: () => new Date((clock += 1000))
  })
  manager.onBeforeClose((session) => backups.projectClosing(session))
  manager.onChange((info) => (info ? backups.projectOpened() : backups.projectClosed()))
  const close = (): void => {
    manager.close()
    backups.dispose()
  }
  try {
    manager.open(v1.folder)
    const deps: SwitchoverRunDeps = {
      session: () => manager.require(),
      backupNow: (opts) => backups.backupNow(opts).file,
      current: () => manager.current(),
      close: () => manager.close(),
      now: () => new Date((clock += 60_000)),
      hold: () => Promise.resolve(),
      release: () => undefined
    }
    const db = manager.require().connection.orm
    const safe = switchoverSafety(deps, null)
    if (!safe.outcome.ok || safe.memo === null) {
      throw new Error(`The safety step failed: ${JSON.stringify(safe.outcome)}`)
    }
    const plan = planSwitchover(db, options.context, sweepCalls)
    const pair = plan.merges.find(
      (each) => each.keepName === SPLIT.keep && each.mergeName === SPLIT.merge
    )
    if (pair === undefined) throw new Error('The dry run offers no Varrow merge')
    return {
      v1,
      plan,
      consent: {
        replacements: inlineTagReplacements(db).map((row) => ({
          key: row.key,
          text: row.replacement
        })),
        merges: [{ keep: pair.keep, merge: pair.merge }]
      },
      safety: { backup: safe.outcome.backup, datedCopy: safe.outcome.datedCopy },
      snapshotsBefore,
      drive,
      manager,
      deps,
      memo: safe.memo,
      close
    }
  } catch (err) {
    close()
    throw err
  }
}

/** Convert, as the dialog sends it: the open project's id and the consent. */
const convert = (ready: ReadyToConvert): Promise<{ outcome: SwitchoverOutcome }> =>
  runConvert(
    ready.deps,
    { consent: ready.consent, projectId: ready.manager.require().info.id },
    ready.memo
  )

/**
 * The test book switched over in place (`readyToConvert`, then Convert, which closes the project
 * so Drive gets it), reopened on v2 with the derived indexes an open builds.
 */
export async function switchTestBook(
  tmp: string,
  options: { now: Date; context: RebuildContext }
): Promise<SwitchedTestBook> {
  const ready = readyToConvert(tmp, options)
  try {
    const { outcome } = await convert(ready)
    if (!outcome.ok) throw new Error(`Convert failed: ${outcome.step}: ${outcome.message}`)
    ready.manager.open(outcome.folder)
    const session = ready.manager.require()
    indexOnOpen(session.connection.orm, options.now)
    return {
      v1: ready.v1,
      plan: ready.plan,
      consent: ready.consent,
      safety: ready.safety,
      outcome,
      snapshotsBefore: ready.snapshotsBefore,
      book: {
        session,
        db: session.connection.orm,
        records: recordsByLabel(session.connection.orm),
        scenes: ready.v1.scenes,
        inactiveDraftId: ready.v1.inactiveDraftId
      },
      drive: ready.drive,
      close: ready.close
    }
  } catch (err) {
    ready.close()
    throw err
  }
}

// ---- What the conversion must keep -----------------------------------------------------------

/** A stored document's paragraphs as text (a paragraph with anything but text reads as such). */
function storedParagraphs(stored: string | null): string[] | null {
  if (stored === null) return null
  const doc = JSON.parse(stored) as TiptapNodeT
  return (doc.content ?? []).map((paragraph) =>
    (paragraph.content ?? [])
      .map((child) => (child.type === 'text' ? (child.text ?? '') : `[${child.type}]`))
      .join('')
  )
}

/** Every place where the converted prose is not the test book's, byte for byte. */
export function proseDifferences(book: TestBookProject): string[] {
  const out: string[] = []
  const contentOf = new Map(listNodes(book.db).map((row) => [row.id, row.content]))
  const drafts = new Map(
    book.db
      .select()
      .from(draftText)
      .where(eq(draftText.draftId, book.inactiveDraftId))
      .all()
      .map((row) => [row.nodeId, row.content])
  )
  for (const scene of TEST_BOOK) {
    const nodeId = book.scenes.get(scene.id) ?? ''
    const wanted = scene.paragraphs.length === 0 ? null : [...scene.paragraphs]
    if (scene.source !== 'inactiveDraft') {
      const active = storedParagraphs(contentOf.get(nodeId) ?? null)
      if (JSON.stringify(active) !== JSON.stringify(wanted)) out.push(`${scene.id} (active draft)`)
    }
    // The earlier draft: every scene as it was when the draft was made, h09's node holding h10.
    if (scene.id === 'h09') continue
    const earlier = scene.source === 'inactiveDraft' ? 'h09' : scene.id
    const inDraft = storedParagraphs(drafts.get(book.scenes.get(earlier) ?? '') ?? null)
    if (wanted !== null && JSON.stringify(inDraft) !== JSON.stringify(wanted)) {
      out.push(`${scene.id} (earlier draft)`)
    }
  }
  return out
}

/** Every stored document (contents, notes, drafts) still holding an inline tag. */
function tokensLeft(db: TreeDb): string[] {
  const parse = (stored: string | null): TiptapNodeT | null =>
    stored === null ? null : (JSON.parse(stored) as TiptapNodeT)
  const out: string[] = []
  for (const row of db.select().from(node).all()) {
    for (const [what, stored] of [
      ['content', row.content],
      ['notes', row.notes]
    ] as const) {
      const doc = parse(stored)
      if (doc !== null && containsInlineTag(doc)) out.push(`${row.title} (${what})`)
    }
  }
  for (const row of db.select().from(draftText).all()) {
    const doc = parse(row.content)
    if (doc !== null && containsInlineTag(doc)) out.push(`draft ${row.nodeId}`)
  }
  return out
}

/** A record as the labels name it: its category, its names (shared or not). */
interface RecordShape {
  name: string
  categoryId: string
  aliases: string[]
}

/** The records the labels make (secrets and threads are the reading's, never a record yet). */
export function labelledRecords(): RecordShape[] {
  return TEST_BOOK_LABELS.records
    .flatMap((label) => {
      const categoryId = TEST_BOOK_CATEGORY[label.kind]
      if (categoryId === undefined) return []
      const main = normName(label.name)
      return [
        {
          name: label.name,
          categoryId,
          aliases: label.aliases
            .filter((alias) => normName(alias.text) !== main)
            .map((alias) => `${alias.text}${alias.shared === true ? ' (shared)' : ''}`)
            .sort()
        }
      ]
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** The project's records in the same shape. */
export function storedRecords(db: TreeDb): RecordShape[] {
  return listRecords(db)
    .map((row) => ({
      name: row.name,
      categoryId: row.categoryId,
      aliases: row.aliases
        .filter((alias) => !alias.isMain)
        .map((alias) => `${alias.text}${alias.shared ? ' (shared)' : ''}`)
        .sort()
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Every page the author owns, as stored: each named record's Pinned and Ideas (hers or the
 * switch-over's, whose pages hold her v1 sheets' text and the Filed-by-AI block; never a record
 * or a secret the reading made), each Research page.
 */
export function authorPages(db: TreeDb): Map<string, string> {
  const pages = new Map<string, string>()
  for (const row of listRecords(db)) {
    if (row.origin === 'ai' || isTopicKind(row.kind)) continue
    const full = getRecord(db, row.id)
    if (full === null) continue
    pages.set(`${row.name} · Pinned`, JSON.stringify(full.pinned))
    pages.set(`${row.name} · Ideas`, JSON.stringify(full.ideas))
  }
  const rows = listNodes(db)
  const byId = new Map(rows.map((row) => [row.id, row]))
  for (const id of researchDocumentIds(rows)) {
    const row = byId.get(id)
    pages.set(`Research · ${row?.title ?? id}`, row?.content ?? '')
  }
  return pages
}

/** The pages whose stored text differs between two reads. */
const pagesChanged = (before: Map<string, string>, after: Map<string, string>): string[] =>
  [...before].filter(([key, text]) => after.get(key) !== text).map(([key]) => key)

// ---- Rebuild memory through the reader service ------------------------------------------------

/** How *Rebuild memory* ended. */
export interface RebuildRun {
  /** The switch-over's notice before the rebuild was asked (null without the record). */
  notice: MemoryNotice | null
  /** The notices once it ended. */
  notices: MemoryNotice[]
  /** What `memory:rebuild` answered. */
  started: ReturnType<ReaderService['rebuild']>
  summary: RebuildSummary | null
  /** Wall-clock seconds from the ask to the last judge run. */
  seconds: number
  /** The cost stop (or an unknown cost) ended it. */
  stopped: boolean
  /** What ended it early, as a report says it: a hard provider error, a missing notice, the limit. */
  error: string | null
}

/**
 * The provider with every request refused once `over()` says so, as the request path refuses one
 * past the daily cap (`AiBudgetError`, before anything is sent): the reader's queue pauses on it,
 * and the run then stops the queue as the app's Stop does. (An `AiCancelledError` here, before the
 * queue is stopped, would leave its job queued and run it again at once.) Every error the provider
 * throws goes to `failed`, which tells the hard ones from those the queue retries.
 */
function stoppingProvider(
  provider: Provider,
  over: () => boolean,
  failed: (err: unknown) => void
): Provider {
  return {
    id: provider.id,
    resolveModel: (tier) => provider.resolveModel(tier),
    complete: async (request) => {
      if (over()) throw new AiBudgetError('The live switch-over run reached its cost cap.')
      try {
        return await provider.complete(request)
      } catch (err) {
        failed(err)
        throw err
      }
    },
    stream: (request) => provider.stream(request),
    testConnection: () => provider.testConnection(),
    ...(provider.price === undefined ? {} : { price: provider.price })
  }
}

/**
 * *Rebuild memory* as the app runs it after the switch (F-16.31; SW-D8): the reader service over
 * the book, Use AI on, the open (whose backlog check raises the switch-over's notice while the
 * record waits), the rebuild asked with its price, then the reading, the spot checks and the
 * contradiction sweep on the reader's queue until it is idle. A transient provider error (a rate
 * limit, the network) is the queue's to retry, as in the app. `over` (the cost cap), a hard
 * `providerError` (one that pauses the app's queue) and `limitMs` stop it with the queue's Stop;
 * nothing here throws on its own limits, so a run always has its report.
 */
export async function rebuildMemory(
  book: TestBookProject,
  live: Pick<LiveProvider, 'provider' | 'models'>,
  run: LiveRequestDeps,
  options: {
    now: () => Date
    minIntervalMs?: number
    over?: () => boolean
    providerError?: () => string | null
    limitMs?: number
  }
): Promise<RebuildRun> {
  let cloud: MemoryCloudState = defaultMemoryCloudState()
  const reader = createReaderService({
    db: () => book.db,
    memory: () => 'v2',
    settings: () => SETTINGS,
    requestDeps: () => run.deps,
    provider: () => ({
      id: live.provider.id,
      fastModel: live.models.fast,
      strongModel: live.models.strong
    }),
    pricing: () => null,
    cloud: {
      get: () => cloud,
      update: (fn) => {
        cloud = fn(cloud)
        return cloud
      }
    },
    cancelRequest: (id) => void cancelInflight(id),
    now: options.now,
    changed: () => undefined,
    questions: () => undefined,
    planLinksChanged: () => undefined,
    status: () => undefined,
    notices: () => undefined,
    jobs: () => undefined,
    ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
    backlogDelayMs: 0
  })
  try {
    const switched = getSwitchoverRecord(book.db) !== null
    reader.opened()
    const noticeOf = (): MemoryNotice | null =>
      reader.notices().find((each) => each.kind === 'switchoverRebuild') ?? null
    let error: string | null = null
    if (switched && !(await waitFor(() => noticeOf() !== null, 10_000))) {
      error = 'the switch-over notice never showed'
    }
    const notice = noticeOf()
    const at = Date.now()
    const started = reader.rebuild()
    let stopped = false
    if (started.ok && error === null) {
      const limitMs = options.limitMs ?? REBUILD_LIMIT_MS
      const end = Date.now() + limitMs
      for (;;) {
        if (options.over?.() === true) {
          reader.cancelAll()
          stopped = true
          break
        }
        error = options.providerError?.() ?? null
        const status = reader.queueStatus()
        if (error !== null || (status.running === null && status.paused !== null)) {
          error ??= `${status.paused?.code ?? 'PROVIDER'}: ${status.paused?.message ?? ''}`
          reader.cancelAll()
          break
        }
        const finished = typeof getRebuild(book.db)?.finishedAt === 'string'
        if (status.running === null && status.queued === 0 && !reader.judging() && finished) {
          break
        }
        if (Date.now() > end) {
          error = `Rebuild memory did not finish in ${Math.round(limitMs / 60_000)} minutes`
          reader.cancelAll()
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      // The queue's last change lands a moment after its last job.
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (started.ok && error === null && !stopped) {
      // Plan Suggestions.md: the rebuild's lines are suggestions, which the contradictions never
      // read; the author accepts every one, and the contradictions are found among them and
      // judged, as the rebuild's sweep did while lines were stored live.
      acceptAll(book)
      runFindingsJob(book.db, options.now(), { cachedVerdicts: true })
      reader.queueJudge()
      const end = Date.now() + (options.limitMs ?? REBUILD_LIMIT_MS)
      while (reader.judging() && Date.now() < end && options.over?.() !== true) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      error = options.providerError?.() ?? null
    }
    return {
      notice,
      notices: reader.notices(),
      started,
      summary: reader.rebuildSummary(),
      seconds: (Date.now() - at) / 1000,
      stopped,
      error
    }
  } finally {
    reader.clear()
  }
}

// ---- The memory, comparable across two projects ----------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/** Every id of the project as a name that means the same thing in another project. */
function stableIds(book: TestBookProject): Map<string, string> {
  const ids = new Map<string, string>()
  for (const row of listRecords(book.db)) ids.set(row.id, `record:${row.name}`)
  for (const row of listNodes(book.db)) {
    const scene = sceneOf(book, row.id)
    ids.set(row.id, scene === '' ? `node:${row.title}` : `scene:${scene}`)
  }
  ids.set(activeDraftId(book.db), 'draft:active')
  ids.set(book.inactiveDraftId, 'draft:earlier')
  for (const claim of [
    ...draftClaims(book.db, activeDraftId(book.db)),
    ...draftClaims(book.db, book.inactiveDraftId)
  ]) {
    ids.set(
      claim.id,
      `claim:${sceneOf(book, claim.nodeId)}¶${claim.para}:${ids.get(claim.recordId ?? '') ?? '-'}:${claim.slot}:${claim.quote}`
    )
  }
  return ids
}

const stable = (value: unknown, ids: ReadonlyMap<string, string>): string =>
  JSON.stringify(value).replace(UUID, (id) => ids.get(id) ?? '<id>')

/**
 * What the memory holds, comparable across two projects: every claim (its subject, slot, value,
 * quote, proof, voice, mode, state; never its ids, times or which ones the spot checks drew) and
 * every finding (its rule, sides, verdicts and state), each as one line with ids named.
 */
export function memoryLines(book: TestBookProject): { claims: string[]; findings: string[] } {
  const ids = stableIds(book)
  const claims = [
    ...draftClaims(book.db, activeDraftId(book.db)),
    ...draftClaims(book.db, book.inactiveDraftId)
  ].map((claim) =>
    stable(
      {
        node: claim.nodeId,
        draft: claim.draftId,
        record: claim.recordId,
        pending: claim.pending,
        subject: claim.subjectText,
        slot: claim.slot,
        value: claim.value,
        object: claim.objectId,
        how: claim.how,
        from: claim.fromId,
        voice: claim.voice,
        speaker: claim.speakerId,
        mode: claim.mode,
        quote: claim.quote,
        para: claim.para,
        anchor: claim.anchor,
        proof: claim.proof,
        change: claim.change,
        state: claim.state
      },
      ids
    )
  )
  const findings = findingsOf(book.db, activeDraftId(book.db)).map((finding) =>
    stable(
      {
        rule: finding.rule,
        variant: finding.variant,
        record: finding.recordId,
        slot: finding.slot,
        a: finding.a,
        b: finding.b,
        extra: finding.extra,
        verdicts: [finding.verdictAb, finding.verdictBa, finding.confirm],
        state: finding.state
      },
      ids
    )
  )
  return { claims: claims.sort(), findings: findings.sort() }
}

// ---- A fake OpenRouter answered by the oracles ------------------------------------------------

/**
 * The oracle reader and checker (`memoryOracle.ts`) and the oracle judge (`judgeOracle.ts`) behind
 * a fake OpenRouter. By default each reply reports the tokens it would take (the request's and the
 * reply's, estimated as the app estimates them) and no cost, so the ledger prices it from the
 * price table as it would a live request; `costUsd` reports a cost instead, `failAfter` answers
 * an HTTP error from the request after that many, and `failAt` answers one on that call only.
 */
export function switchoverOracleServer(
  options: {
    costUsd?: number
    failAfter?: { calls: number; status: number }
    failAt?: { call: number; status: number }
  } = {}
): ChatServer {
  const server: ChatServer = fakeChatServer((messages: AiMessage[]): ChatServerReply => {
    const failAfter = options.failAfter
    if (failAfter !== undefined && server.calls.length > failAfter.calls) {
      return { text: 'Payment required', status: failAfter.status }
    }
    const failAt = options.failAt
    if (failAt?.call === server.calls.length) {
      return { text: 'Rate limited', status: failAt.status }
    }
    const judged = judgeOracleReply(messages)
    const text =
      judged?.text ??
      (requestKind({ messages }) === 'verify'
        ? oracleVerify({ messages })
        : oracleRead({ messages }))
    return {
      text,
      ...(judged?.finishReason === undefined ? {} : { finishReason: judged.finishReason }),
      usage: {
        inputTokens: estimateTokens(messages.map((message) => message.content).join('\n')),
        outputTokens: estimateTokens(text)
      },
      costUsd: options.costUsd ?? null
    }
  })
  return server
}

/** A live provider over `server`, from `OPENROUTER_API_KEY` alone. */
const fakeLive = (server: ChatServer, env: Record<string, string> = {}): LiveProvider =>
  liveProviderFromEnv({ OPENROUTER_API_KEY: 'sk-or-fake', ...env }, { fetch: server.fetch })

// ---- The live switch-over run ----------------------------------------------------------------

/** What a live run did, for its report. */
export interface SwitchoverLiveRun {
  models: Record<Tier, string>
  route: string
  stopUsd: number
  /** The price and time the dry run asked. */
  price: { costUsd: number; priced: boolean; minutes: number; requests: number }
  costUsd: number
  seconds: number
  requests: number
  /** The cost stop came before the run's end. */
  stopped: boolean
  /** What stopped the run (a hard provider error, the time limit), or null. */
  error: string | null
  /** Transient provider errors (rate limits, the network) the queue retried, as the app does. */
  retried: number
  costUnknown: string | null
  at?: Date
}

/** What a live run measured. */
export interface SwitchoverScore {
  /** The conversion's own checks (prose, snapshot, tokens, records): problems found. */
  conversion: string[]
  /** Author pages the rebuild changed. */
  pagesChanged: string[]
  /** Requests that carried sheet text the AI wrote, an Ideas line or a frozen v1 AI row. */
  notCanonSent: number
  /** The planted-error run's measures on the converted book. */
  memory: PlantedMeasures
  /** Readable scenes the rebuild read, of the readable scenes. */
  scenesRead: number
  scenes: number
}

export interface SwitchoverLiveReport {
  markdown: string
  json: unknown
  failures: string[]
  score: SwitchoverScore
  run: SwitchoverLiveRun
}

const cents = (usd: number): string => `${(usd * 100).toFixed(2)}¢`

/** The run's report: the bars (SW-D13), then the facts no bar judges. */
export function switchoverReport(
  score: SwitchoverScore,
  run: SwitchoverLiveRun
): SwitchoverLiveReport {
  const bars = SWITCHOVER_PASS_BARS
  const failures: string[] = []
  const ratio = run.price.costUsd > 0 ? run.costUsd / run.price.costUsd : null
  if (!run.price.priced) {
    failures.push(
      `the dry run could not price the rebuild (${run.models.fast} or ${run.models.strong} is not on the price table)`
    )
  } else if (ratio !== null && (ratio < bars.costRatioMin || ratio > bars.costRatioMax)) {
    failures.push(
      `actual cost ${cents(run.costUsd)} is ${ratio.toFixed(2)}× the dry run’s ${cents(run.price.costUsd)} (bar ${bars.costRatioMin}–${bars.costRatioMax}×)`
    )
  }
  failures.push(...score.conversion.map((problem) => `conversion: ${problem}`))
  failures.push(...plantedFailures(score.memory))
  if (score.pagesChanged.length > bars.pagesChanged) {
    failures.push(`the rebuild changed ${score.pagesChanged.length} author pages`)
  }
  if (score.notCanonSent > bars.notCanonSent) {
    failures.push(
      `${score.notCanonSent} requests carried AI-written sheet text, an Ideas line or a frozen v1 AI row`
    )
  }
  if (run.stopped) failures.push(`stopped at the ${run.stopUsd} USD cap before the end`)
  if (run.error !== null) failures.push(`stopped by a provider error (${run.error})`)
  if (run.costUnknown !== null) failures.push(run.costUnknown)
  if (
    !run.stopped &&
    run.error === null &&
    run.costUnknown === null &&
    score.scenesRead < score.scenes
  ) {
    failures.push(
      `only ${score.scenesRead} of ${score.scenes} scenes were read (${run.retried} transient errors retried)`
    )
  }
  const lines = [
    `# Story memory: the live switch-over run (${(run.at ?? new Date()).toISOString()})`,
    '',
    `Models: fast \`${run.models.fast}\`, strong \`${run.models.strong}\`, on ${run.route}. ` +
      `The test book built on v1, switched over in place, then *Rebuild memory*: ` +
      `${score.scenesRead} of ${score.scenes} scenes read; requests: ${run.requests}; ` +
      `reported cost: ${run.costUsd.toFixed(4)} USD (it stops at ${run.stopUsd} USD).`,
    '',
    '## Pass bars (decided by Claude, unconfirmed; SW-D13)',
    '',
    `- The price asked: ${run.price.priced ? cents(run.price.costUsd) : 'not known'} for ${run.price.requests} requests, about ${run.price.minutes} min; ` +
      `actual ${cents(run.costUsd)}${ratio === null ? '' : ` (${ratio.toFixed(2)}×; bar ${bars.costRatioMin}–${bars.costRatioMax}×)`}`,
    `- Time: ${run.seconds.toFixed(0)} s against the ${run.price.minutes} min the dry run said (no bar)`,
    `- Transient provider errors (rate limits, the network) the queue retried, as the app does: ${run.retried} (no bar)`,
    `- The conversion's checks (prose, snapshot, inline tags, records): ${score.conversion.length === 0 ? 'clean' : score.conversion.join('; ')}`,
    `- Author pages changed by the rebuild: ${score.pagesChanged.length} (bar ${bars.pagesChanged})${score.pagesChanged.length > 0 ? `: ${score.pagesChanged.join(', ')}` : ''}`,
    `- Requests carrying AI-written sheet text, an Ideas line or a frozen v1 AI row (the sheet it made, an old summary): ${score.notCanonSent} (bar ${bars.notCanonSent})`,
    '',
    '### The memory bars of the planted-error run (`-- memory`), on the converted book',
    '',
    ...plantedBarLines(score.memory),
    ...cutLines(score.memory),
    '',
    failures.length === 0 ? '**Passed.**' : `**Failed:** ${failures.join('; ')}.`,
    '',
    ...(run.error === null ? [] : [`**Stopped by a provider error:** ${run.error}.`, '']),
    ...(run.costUnknown === null ? [] : [`**Cost unknown:** ${run.costUnknown}.`, '']),
    ...unreviewedLines(score.memory),
    '',
    'No prompt text and no key are written here.'
  ]
  return {
    markdown: lines.join('\n'),
    json: { ...run, bars, score, failures },
    failures,
    score,
    run
  }
}

/** The conversion's checks on a switched book, each problem as a line (none when clean). */
export function conversionProblems(switched: SwitchedTestBook): string[] {
  const { book } = switched
  const problems: string[] = []
  const prose = proseDifferences(book)
  if (prose.length > 0) problems.push(`prose differs in ${prose.join(', ')}`)
  if (snapshotRows(book.db) !== switched.snapshotsBefore) problems.push('a snapshot changed')
  const left = tokensLeft(book.db)
  if (left.length > 0) problems.push(`inline tags left in ${left.join(', ')}`)
  if (JSON.stringify(storedRecords(book.db)) !== JSON.stringify(labelledRecords())) {
    problems.push('the records are not the labels’')
  }
  const broken = invariants(book)
  if (broken.length > 0) problems.push(`${broken.length} memory invariants broken`)
  return problems
}

/**
 * The texts no request may carry: the sheet text the AI wrote (Filed by AI earlier), the Ideas
 * lines, and the AI's rows the switch leaves frozen in v1's tables until P9 (the sheet it made, the
 * old scene summaries), which no v2 path may read.
 */
function notCanonTexts(switched: SwitchedTestBook): string[] {
  return [
    switched.v1.aiWritten.text,
    ...TEST_BOOK_LABELS.pages.filter((page) => page.page === 'ideas').flatMap((page) => page.lines),
    ...switched.v1.aiFrozen
  ]
}

/**
 * The live switch-over run (plan `Switchover.md` §5.3): the test book built on v1 and switched
 * over in place (`switchTestBook`, priced on the run's own models), then *Rebuild memory* through
 * the reader service with the live reader, checker and sweep judge, at the app's own pace
 * (`minIntervalMs`, the queue's default unless given). A transient provider error (a rate limit,
 * the network) is retried by the queue as in the app and counted. It stops once the reported cost
 * passes `stopUsd` (the queue's Stop: what was read stays), once a cost cannot be known, at a hard
 * provider error (one that pauses the app's queue: a bad key, no credit) or after `limitMs`; the
 * report then says so, with what was read and what it cost. (A failure before the rebuild, in the
 * conversion, throws; the live test writes that as its report.)
 */
export async function runLiveSwitchover(
  live: LiveProvider,
  options: { stopUsd?: number; now?: Date; minIntervalMs?: number; limitMs?: number } = {}
): Promise<SwitchoverLiveReport> {
  const stopUsd = options.stopUsd ?? LIVE_STOP_USD
  const now = options.now ?? new Date()
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-live-'))
  const captured: CapturedCall<'any'>[] = []
  let firstError: string | null = null
  let retried = 0
  const holder: { run: LiveRequestDeps | null } = { run: null }
  const over = (): boolean =>
    holder.run !== null && (holder.run.spent() > stopUsd || holder.run.costUnknown() !== null)
  const provider = stoppingProvider(
    recordingProvider(live.provider, captured, () => 'any'),
    over,
    (err) => {
      // The queue's own sorting: a hard error pauses it in the app, so it stops the run; the
      // rest (rate limits, the network) the queue retries after its backoff.
      const outcome = jobOutcome(err)
      if (outcome === 'hard') {
        firstError ??= liveProviderError(err) ?? (err instanceof Error ? err.message : String(err))
      } else if (outcome === 'transient') {
        retried += 1
      }
    }
  )
  const run = liveRequestDeps({ provider, local: live.local })
  holder.run = run
  let switched: SwitchedTestBook | null = null
  try {
    switched = await switchTestBook(tmp, { now, context: contextFor(live.models) })
    const conversion = conversionProblems(switched)
    const before = authorPages(switched.book.db)
    const rebuilt = await rebuildMemory(switched.book, { provider, models: live.models }, run, {
      now: () => new Date(),
      ...(options.minIntervalMs === undefined ? {} : { minIntervalMs: options.minIntervalMs }),
      over,
      providerError: () => firstError,
      ...(options.limitMs === undefined ? {} : { limitMs: options.limitMs })
    })
    const banned = notCanonTexts(switched)
    const readable = TEST_BOOK.filter(
      (scene) => scene.source === 'scene' && scene.paragraphs.length > 0
    )
    const memory = plantedMeasures(switched.book)
    const costUnknown = run.costUnknown()
    const started = rebuilt.started.ok
      ? null
      : `${rebuilt.started.code}: ${rebuilt.started.message}`
    return switchoverReport(
      {
        conversion,
        pagesChanged: pagesChanged(before, authorPages(switched.book.db)),
        notCanonSent: captured.filter((call) =>
          call.messages.some((message) => banned.some((text) => message.content.includes(text)))
        ).length,
        memory,
        scenesRead: rebuilt.summary?.progress.done ?? 0,
        scenes: readable.length
      },
      {
        models: live.models,
        route: live.describe,
        stopUsd,
        price: {
          costUsd: switched.plan.rebuild.costUsd,
          priced: switched.plan.rebuild.priced,
          minutes: switched.plan.rebuild.minutes,
          requests: switched.plan.rebuild.requests
        },
        costUsd: run.spent(),
        seconds: rebuilt.seconds,
        requests: run.ledger.filter((entry) => !entry.cached).length,
        stopped: rebuilt.stopped && costUnknown === null,
        error: rebuilt.error ?? started,
        retried,
        costUnknown,
        at: now
      }
    )
  } finally {
    switched?.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

// ---- The offline replay ----------------------------------------------------------------------

const CONTEXT = contextFor(OPENROUTER_DEFAULT_MODELS)

describe('the v1 test book switched over in place (F-16.31 part A, F-16.3)', () => {
  let tmp: string
  let switched: SwitchedTestBook
  let ideasBefore: string | null

  beforeAll(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-eval-'))
    switched = await switchTestBook(tmp, { now: NOW, context: CONTEXT })
    const captain = switched.book.records.get('captain') ?? ''
    ideasBefore = JSON.stringify(getRecord(switched.book.db, captain)?.ideas ?? null)
  }, 120_000)
  afterAll(() => {
    switched.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('builds the book as a v1 author has it: inline tags a third of the way, the split pair, the AI’s rows', () => {
    const { v1 } = switched
    const readable = TEST_BOOK.filter((scene) => scene.source === 'scene').length
    const tagged = [...v1.inlineTags.keys()].filter((id) => id !== 'h10')
    expect(tagged.length).toBeGreaterThanOrEqual(Math.floor(readable / 3))
    expect(tagged.length).toBeLessThanOrEqual(Math.ceil(readable / 3) + 1)
    expect(v1.inlineTags.get('h10')).toEqual(['Thornmere'])
    // The split pair's surname stands alone where its token is.
    expect([...v1.inlineTags.values()].flat()).toContain('Varrow')
    expect(v1.tags.has('harrow-mrs')).toBe(false)
    expect(v1.tags.size).toBe(v1.sheets.size - 1)
  })

  it('dry run: every record converted by name, the AI’s field filed, its facts and summaries dropped, the merge offered', () => {
    const { plan } = switched
    const converted = new Set(plan.converted.map((item) => item.name))
    for (const record of labelledRecords()) expect(converted, record.name).toContain(record.name)
    expect(converted).toContain('Varrow')
    expect(plan.filedByAi).toEqual([
      { name: 'Ned Ashby', lines: [`Personality: ${switched.v1.aiWritten.text}`] }
    ])
    const dropped = new Map(plan.dropped.map((item) => [item.name, item.detail]))
    expect(dropped.get('Sheets the AI made')).toBe(switched.v1.aiSheet)
    expect(dropped.get('Facts the AI read')).toBe('Callum Varrow 1')
    expect(dropped.get('Observed facts')).toMatch(/^1 fact;/)
    expect(dropped.get('Scene summaries and cards')).toMatch(/^2 scenes;/)
    // Only the split pair: the Harrows, the Ashbys, the Lowthers and the Pells are families
    // (each has a name or a title of its own), the Bell and Pell House are places, and the shared
    // "Harrow" is never a reason to merge (SW-D15).
    expect(plan.merges.map((pair) => [pair.keepName, pair.mergeName, pair.rule])).toEqual([
      ['Callum Varrow', 'Varrow', 'subset']
    ])
    // The Plan sheet's text goes to Ideas; the shared surname is named in the notes.
    expect(plan.converted.find((item) => item.name === 'the Captain')?.detail).toContain(
      '1 Ideas line'
    )
    expect(plan.notes).toContainEqual(expect.stringContaining('“harrow” is a name of Mr. Harrow'))
    expect(plan.inlineTags).toBe(new Set(switched.consent.replacements.map((row) => row.key)).size)
  })

  it('makes the copies first: a kept backup and a dated copy in Google Drive, named in the record', () => {
    const { safety, outcome, drive } = switched
    expect(fs.existsSync(safety.backup)).toBe(true)
    expect(path.dirname(safety.datedCopy)).toBe(drive)
    expect(fs.existsSync(path.join(safety.datedCopy, 'project.db'))).toBe(true)
    expect(outcome).toMatchObject({ ok: true, trial: false, backup: safety.backup })
    expect(getSwitchoverRecord(switched.book.db)).toMatchObject({
      trial: false,
      backup: safety.backup,
      datedCopy: safety.datedCopy,
      rebuild: 'waiting'
    })
    expect(getStoryMemory(switched.book.db).version).toBe('v2')
    expect(switched.book.session.info.storyMemory).toBe('v2')
  })

  it('gives the prose back byte for byte in both drafts, keeps the snapshot, leaves no inline tag', () => {
    expect(proseDifferences(switched.book)).toEqual([])
    expect(snapshotRows(switched.book.db)).toBe(switched.snapshotsBefore)
    expect(tokensLeft(switched.book.db)).toEqual([])
    expect(conversionProblems(switched)).toEqual([])
  })

  it('makes the labels’ records: names, nicknames, the shared surname, the split pair merged', () => {
    expect(storedRecords(switched.book.db)).toEqual(labelledRecords())
    expect(invariants(switched.book)).toEqual([])
    const pageOf = (
      label: string,
      page: 'pinned' | 'ideas'
    ): { text: string; notCanon: boolean }[] =>
      pageTextBlocks(
        getRecord(switched.book.db, switched.book.records.get(label) ?? '')?.[page] ?? {
          type: 'doc'
        }
      ).map((block) => ({ text: block.text, notCanon: block.notCanon }))
    // The field an Organise run wrote is filed under its heading, Not canon, never as canon.
    expect(pageOf('ashby', 'pinned')).toEqual([
      { text: 'Filed by AI earlier: please check', notCanon: true },
      { text: `Personality: ${switched.v1.aiWritten.text}`, notCanon: true }
    ])
    // Her sheet text is her canon Pinned lines; a Plan sheet's text is Ideas.
    for (const page of TEST_BOOK_LABELS.pages) {
      expect(pageOf(page.record, page.page), `${page.record} ${page.page}`).toEqual(
        page.lines.map((text) => ({ text, notCanon: false }))
      )
    }
    for (const note of TEST_BOOK_LABELS.notes) {
      if (note.record === undefined) continue
      expect(pageOf(note.record, 'pinned'), note.record).toEqual(
        note.lines.map((text) => ({ text, notCanon: false }))
      )
    }
    const captain = getRecord(switched.book.db, switched.book.records.get('captain') ?? '')
    const captainIdeas = TEST_BOOK_LABELS.pages.find((page) => page.record === 'captain')
    expect(docToText(captain?.ideas ?? { type: 'doc' })).toBe(captainIdeas?.lines.join('\n'))
  })

  it('types every scene’s details from its scene meta: POV and place records, the time, a year where a run starts', () => {
    const { book } = switched
    const recordOf = (label: string | undefined): string | null =>
      label === undefined ? null : (book.records.get(label) ?? null)
    for (const scene of TEST_BOOK) {
      const wanted = scene.details
      if (wanted === undefined || scene.source === 'inactiveDraft') continue
      const stored = storedSceneDetails(book.db, book.scenes.get(scene.id) ?? '')
      expect(
        [stored.povRecordId, stored.place.recordId, stored.time.text, stored.flashback],
        scene.id
      ).toEqual([recordOf(wanted.pov), recordOf(wanted.place), wanted.time ?? '', null])
    }
    // The year of each timeline event, on the first scene of its run (F-16.11): the 1811 run
    // from s01 to h07, then each later year, and the flashback h16 back in 1811.
    const years = TEST_BOOK.flatMap((scene) => {
      const year = storedSceneDetails(book.db, book.scenes.get(scene.id) ?? '').storyYear
      return scene.source === 'inactiveDraft' || year === null ? [] : [[scene.id, year]]
    })
    expect(years).toEqual([
      ['s01', 1811],
      ['h08', 1812],
      ['h09', 1814],
      ['h15', 1815],
      ['h16', 1811]
    ])
  })

  it('priced the rebuild as Rebuild memory prices it on the converted book (SW-D10)', () => {
    expect(rebuildEstimate(switched.book.db, CONTEXT, sweepCalls)).toEqual(switched.plan.rebuild)
    expect(switched.plan.rebuild).toMatchObject({ scenes: 18, priced: true })
  })

  describe('Rebuild memory with the oracle reader and judge, against the v2-built book', () => {
    let rebuilt: RebuildRun
    let baseline: RebuildRun
    let v2: TestBookProject
    let v2tmp: string
    let pagesBefore: Map<string, string>
    let server: ChatServer

    beforeAll(async () => {
      pagesBefore = authorPages(switched.book.db)
      server = switchoverOracleServer()
      const live = fakeLive(server)
      rebuilt = await rebuildMemory(switched.book, live, liveRequestDeps(live), {
        now: () => NOW,
        minIntervalMs: 0
      })
      v2tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-v2-'))
      v2 = buildTestBookProject(v2tmp, NOW)
      // The author's pages and notes, as the v1 book keeps them in its sheets, so the note rules
      // read the same canon on both; the Research page under the title the switch gives v1's
      // Project notes, so its ids compare.
      addTestBookPages(v2, NOW)
      addTestBookNotes(v2, NOW)
      const rows = listNodes(v2.db)
      for (const id of researchDocumentIds(rows)) {
        const research = TEST_BOOK_LABELS.notes.find((note) => note.research !== undefined)
        if (rows.find((row) => row.id === id)?.title === research?.research) {
          renameNode(v2.db, id, PROJECT_NOTES_NAME)
        }
      }
      indexOnOpen(v2.db, NOW)
      const v2live = fakeLive(switchoverOracleServer())
      baseline = await rebuildMemory(v2, v2live, liveRequestDeps(v2live), {
        now: () => NOW,
        minIntervalMs: 0
      })
    }, 300_000)
    afterAll(() => {
      v2.session.close()
      fs.rmSync(v2tmp, { recursive: true, force: true })
    })

    it('waits in one priced notice, then the asked rebuild starts at the dry run’s price', () => {
      expect(rebuilt.notice).toMatchObject({
        kind: 'switchoverRebuild',
        scenes: 18,
        priceUsd: switched.plan.rebuild.costUsd,
        priced: true
      })
      expect(rebuilt.started).toEqual({ ok: true, queued: 18, estimate: switched.plan.rebuild })
      expect([rebuilt.stopped, rebuilt.error]).toEqual([false, null])
    })

    it('ends the wait: the record says started and the notice is gone', () => {
      expect(getSwitchoverRecord(switched.book.db)).toMatchObject({
        rebuild: 'started',
        rebuildStartedAt: NOW.toISOString()
      })
      expect(rebuilt.notices.filter((notice) => notice.kind === 'switchoverRebuild')).toEqual([])
      expect(rebuilt.summary?.progress).toMatchObject({ done: 18, total: 18 })
    })

    it('reads the switched book as it reads the v2-built one: the same claims and findings', () => {
      const ours = memoryLines(switched.book)
      const theirs = memoryLines(v2)
      expect(ours.claims.length).toBeGreaterThan(0)
      expect(ours.findings.length).toBeGreaterThan(0)
      expect(ours.claims).toEqual(theirs.claims)
      expect(ours.findings).toEqual(theirs.findings)
      // Her converted sheet text is canon the note rules read: a note against the book (C6).
      expect(ours.findings.filter((line) => line.includes('"rule":"C6"')).length).toBeGreaterThan(0)
      expect(baseline.summary?.progress).toMatchObject({ done: 18, total: 18 })
    })

    it('leaves the author’s pages byte-identical and the invariants clean, findings included', () => {
      // The pages compared are the converted records' too: never an empty check.
      expect([...pagesBefore.keys()]).toEqual(
        expect.arrayContaining([
          'Ned Ashby · Pinned',
          'the Captain · Ideas',
          'The Bell · Pinned',
          'Anne Fenwick · Pinned',
          `Research · ${PROJECT_NOTES_NAME}`
        ])
      )
      expect(pagesChanged(pagesBefore, authorPages(switched.book.db))).toEqual([])
      expect(
        JSON.stringify(
          getRecord(switched.book.db, switched.book.records.get('captain') ?? '')?.ideas ?? null
        )
      ).toBe(ideasBefore)
      const { db } = switched.book
      const { reading } = findingsFrame(db)
      expect(
        invariants(switched.book, [], {
          findings: invariantFindings(db, activeDraftId(db), (nodeId) => reading.order.has(nodeId)),
          dismissedFindings: dismissedKeys(db, 'notProblem')
        })
      ).toEqual([])
    })

    it('never sends the AI’s sheet text or an Ideas line, and sends as the app does', () => {
      const banned = notCanonTexts(switched)
      expect(
        server.calls.filter((call) =>
          call.messages.some((message) => banned.some((text) => message.content.includes(text)))
        )
      ).toEqual([])
      for (const call of server.calls) {
        expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
        expect(call.body).toMatchObject({ reasoning: { enabled: false } })
      }
      expect(new Set(server.calls.map((call) => call.body.model))).toEqual(
        new Set([OPENROUTER_DEFAULT_MODELS.fast, OPENROUTER_DEFAULT_MODELS.strong])
      )
    })
  })
})

describe('the switch-over over the test book: the adversarial replay (F-16.31, SW-D6)', () => {
  it('refuses a paragraph lost inside the conversion and leaves the project v1, its bytes as they were', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-switchover-plant-'))
    const ready = readyToConvert(tmp, { now: NOW, context: CONTEXT })
    try {
      const sqlite = ready.manager.require().connection.sqlite
      // s01 holds an inline tag, so the conversion rewrites it: the plant keeps only its first
      // paragraph as it does, the rest of the scene lost.
      const s01 = ready.v1.scenes.get('s01') ?? ''
      const lost = JSON.stringify({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: testBookScene('s01').paragraphs[0] ?? '' }]
          }
        ]
      }).replace(/'/g, "''")
      sqlite.exec(`CREATE TEMP TRIGGER plant AFTER UPDATE OF content ON node
        WHEN NEW.id = '${s01}' AND NEW.content NOT LIKE '%inlineTag%'
        BEGIN UPDATE node SET content = '${lost}' WHERE id = NEW.id; END`)
      const bytes = rollbackSnapshot(sqlite)
      const { outcome } = await convert(ready)
      sqlite.exec('DROP TRIGGER IF EXISTS temp.plant')
      expect(outcome.ok).toBe(false)
      if (outcome.ok) return
      expect(outcome.step).toBe('convert')
      expect(outcome.message).toMatch(/“Thornmere is let” would not read as it did/)
      expect(outcome.message).toMatch(
        /Nothing was changed: this project still uses the old story memory\.$/
      )
      const db = ready.manager.require().connection.orm
      expect(ready.manager.current()?.storyMemory).toBe('v1')
      expect(getStoryMemory(db).version).toBe('v1')
      expect(getSwitchoverRecord(db)).toBeNull()
      expect(listRecords(db)).toEqual([])
      expect(rollbackSnapshot(sqlite).equals(bytes)).toBe(true)
    } finally {
      ready.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  }, 120_000)
})

describe('the live switch-over run, end to end against a fake OpenRouter (F-16.31; nothing spent)', () => {
  it('starts from OPENROUTER_API_KEY alone, switches over, rebuilds as the app does, and passes every bar', async () => {
    const server = switchoverOracleServer()
    const report = await runLiveSwitchover(fakeLive(server), { now: NOW, minIntervalMs: 0 })
    expect(report.failures).toEqual([])
    expect(report.score).toMatchObject({
      conversion: [],
      pagesChanged: [],
      notCanonSent: 0,
      scenesRead: 18,
      scenes: 18
    })
    // The fake prices each reply by its tokens, as a live one is: the dry run's price holds.
    const ratio = report.run.costUsd / report.run.price.costUsd
    expect(ratio).toBeGreaterThanOrEqual(SWITCHOVER_PASS_BARS.costRatioMin)
    expect(ratio).toBeLessThanOrEqual(SWITCHOVER_PASS_BARS.costRatioMax)
    expect(report.run.requests).toBe(server.calls.length)
    expect(report.markdown).toContain('on OpenRouter (OPENROUTER_API_KEY)')
    expect(report.markdown).toContain('**Passed.**')
    expect(report.markdown).not.toContain('sk-or-fake')
    for (const call of server.calls) {
      expect(call.headers.get('authorization')).toBe('Bearer sk-or-fake')
      expect(call.body).toMatchObject({ reasoning: { enabled: false }, usage: { include: true } })
    }
  }, 300_000)

  it('stops once the reported cost passes 50¢, keeps what was read, and says so', async () => {
    const server = switchoverOracleServer({ costUsd: 0.06 })
    const report = await runLiveSwitchover(fakeLive(server), { now: NOW, minIntervalMs: 0 })
    expect(report.run.stopped).toBe(true)
    expect(report.failures).toContain('stopped at the 0.5 USD cap before the end')
    // Nine replies pass 50¢; nothing is asked after the stop (one may already be on its way).
    expect(server.calls.length).toBeGreaterThanOrEqual(9)
    expect(server.calls.length).toBeLessThanOrEqual(10)
    expect(report.run.costUsd).toBeLessThanOrEqual(0.6 + 1e-9)
    expect(report.score.scenesRead).toBeLessThan(18)
    // What was read is kept, and the author's pages are untouched.
    expect(report.score.pagesChanged).toEqual([])
  }, 300_000)

  it('stops at a provider error and reports what it read and what it cost', async () => {
    const server = switchoverOracleServer({ failAfter: { calls: 4, status: 402 } })
    const report = await runLiveSwitchover(fakeLive(server), { now: NOW, minIntervalMs: 0 })
    expect(report.run.error).toMatch(/^[A-Z_]+: /)
    expect(report.failures).toContainEqual(
      expect.stringMatching(/^stopped by a provider error \([A-Z_]+: .*\)$/)
    )
    expect(report.markdown).toContain('**Stopped by a provider error:**')
    // The error stops the queue: nothing is asked after the reply that failed.
    expect(server.calls.length).toBe(5)
    expect(report.score.pagesChanged).toEqual([])
  }, 300_000)

  it('retries a rate limit as the app’s queue does, reads every scene, and counts it', async () => {
    const server = switchoverOracleServer({ failAt: { call: 3, status: 429 } })
    const report = await runLiveSwitchover(fakeLive(server), { now: NOW, minIntervalMs: 0 })
    expect(report.run.error).toBeNull()
    expect(report.run.retried).toBe(1)
    expect(report.score.scenesRead).toBe(18)
    expect(report.failures).toEqual([])
    expect(report.markdown).toContain(
      '- Transient provider errors (rate limits, the network) the queue retried, as the app does: 1 (no bar)'
    )
  }, 300_000)

  it('says so when the models are not priced: the dry run’s price unknown, and the run stopped', async () => {
    const server = switchoverOracleServer()
    const live = fakeLive(server, {
      MYTHSCRIBE_EVAL_FAST_MODEL: 'vendor/unpriced-fast',
      MYTHSCRIBE_EVAL_STRONG_MODEL: 'vendor/unpriced-strong'
    })
    const report = await runLiveSwitchover(live, { now: NOW, minIntervalMs: 0 })
    expect(report.run.price.priced).toBe(false)
    expect(report.failures).toContain(
      'the dry run could not price the rebuild (vendor/unpriced-fast or vendor/unpriced-strong is not on the price table)'
    )
    expect(report.run.costUnknown).toMatch(/^cost unknown for vendor\/unpriced-fast/)
    expect(report.failures).toContainEqual(expect.stringMatching(/^cost unknown for /))
    expect(server.calls.length).toBeLessThanOrEqual(2)
  }, 300_000)
})

describe('the switch-over report (F-16.31, SW-D13)', () => {
  const measures: PlantedMeasures = {
    quotesFound: { right: 10, of: 10 },
    costRefusals: { items: 12, byReason: { slot: 1, tooShort: 1, tooLong: 0, notRead: 0 } },
    verifierPass: { right: 9, of: 10 },
    stored: {
      precision: { right: 15, of: 15 },
      callsTurned: { right: 15, of: 15 },
      wrong: [],
      unjudged: [],
      notRead: 0
    },
    storedFacts: [],
    attribution: { right: 10, of: 10 },
    literalPrecision: { right: 5, of: 5 },
    supportPrecision: { right: 5, of: 5 },
    unreviewed: [],
    facts: 15,
    strays: 0,
    strayLines: [],
    falseAlarms: [],
    cut: { right: 0, of: 18 },
    recovered: { right: 2, of: 18 },
    cutReplies: 2
  }
  const score: SwitchoverScore = {
    conversion: [],
    pagesChanged: [],
    notCanonSent: 0,
    memory: measures,
    scenesRead: 18,
    scenes: 18
  }
  const run = (costUsd: number): SwitchoverLiveRun => ({
    models: OPENROUTER_DEFAULT_MODELS,
    route: 'OpenRouter (OPENROUTER_API_KEY)',
    stopUsd: LIVE_STOP_USD,
    price: { costUsd: 0.04, priced: true, minutes: 3, requests: 110 },
    costUsd,
    seconds: 95,
    requests: 60,
    stopped: false,
    error: null,
    retried: 0,
    costUnknown: null,
    at: NOW
  })

  it('holds the actual cost to 0.5–1.5× of the price asked, and reports the time against its minutes', () => {
    expect(switchoverReport(score, run(0.04)).failures).toEqual([])
    expect(switchoverReport(score, run(0.021)).failures).toEqual([])
    expect(switchoverReport(score, run(0.059)).failures).toEqual([])
    expect(switchoverReport(score, run(0.018)).failures).toEqual([
      'actual cost 1.80¢ is 0.45× the dry run’s 4.00¢ (bar 0.5–1.5×)'
    ])
    expect(switchoverReport(score, run(0.061)).failures).toEqual([
      'actual cost 6.10¢ is 1.52× the dry run’s 4.00¢ (bar 0.5–1.5×)'
    ])
    expect(switchoverReport(score, run(0.04)).markdown).toContain(
      '- Time: 95 s against the 3 min the dry run said (no bar)'
    )
  })

  it('fails on a page the rebuild touched, a Not canon line sent, a missed memory bar, a conversion problem', () => {
    const failures = switchoverReport(
      {
        ...score,
        conversion: ['a snapshot changed'],
        pagesChanged: ['Ned Ashby · Pinned'],
        notCanonSent: 1,
        memory: { ...measures, supportPrecision: { right: 4, of: 5 } }
      },
      run(0.04)
    ).failures
    expect(failures).toEqual([
      'conversion: a snapshot changed',
      'support precision 80.0 % < 90 %',
      'the rebuild changed 1 author pages',
      '1 requests carried AI-written sheet text, an Ideas line or a frozen v1 AI row'
    ])
  })
})

describe.skipIf(!LIVE)('the live switch-over run (MYTHSCRIBE_EVAL_LIVE=1)', () => {
  it('switches the test book over, rebuilds it with the real reader, checker and judge, and writes the report', async () => {
    const dir = path.resolve('test-results/eval-switchover')
    fs.mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    let report: SwitchoverLiveReport
    try {
      // One key: OPENROUTER_API_KEY, else OPENAI_API_KEY (and OPENAI_BASE_URL).
      report = await runLiveSwitchover(liveProviderFromEnv())
    } catch (err) {
      // A failure before the rebuild (the conversion, the key) still leaves a report.
      const message = err instanceof Error ? err.message : String(err)
      fs.writeFileSync(
        path.join(dir, `switchover-${stamp}.md`),
        `# Story memory: the live switch-over run\n\n**Failed before the report:** ${message}\n`
      )
      throw err
    }
    fs.writeFileSync(path.join(dir, `switchover-${stamp}.md`), report.markdown)
    fs.writeFileSync(
      path.join(dir, `switchover-${stamp}.json`),
      JSON.stringify(report.json, null, 2)
    )
    process.stdout.write(`\n${report.markdown}\n`)
    expect(report.failures).toEqual([])
    // Above the rebuild's own 25-minute limit and the switch before it, so the run's report is
    // always written before the test's time runs out.
  }, 2_400_000)
})
