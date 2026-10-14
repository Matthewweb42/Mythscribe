import { and, eq, gte } from 'drizzle-orm'
import type { Claim } from '@shared/memory/claims'
import { z } from 'zod'
import type {
  MemoryNotice,
  RebuildAction,
  RebuildProgress,
  RebuildSummary
} from '@shared/memory/views'
import { reading } from '../../db/schema'
import { activeDraftId, currentDraftId } from '../../draft/draftStore'
import type { TreeDb } from '../../tree/treeStore'
import { findingNotProblem, findingTouches } from '../findings/findingActions'
import { findingsOf } from '../findings/findingStore'
import { findingView } from '../findings/findingViews'
import { judgeContext } from '../findings/judge'
import { answerNameQuestion } from '../questions'
import { getRecord } from '../recordStore'
import { readableScenes } from './backlog'
import { draftClaims } from './claimStore'
import { dismissClaimsNotRight } from './notRight'
import { getRebuild, readRow, setRebuild, writeRow } from './readerRows'
import { markRosterForRebuild } from './roster'
import { topicNotRight } from './topicActions'
import { listTopicQuotes, listTopics } from './topicStore'

/**
 * *Rebuild memory* (F-16.19; design §2.7, plan P2a §3.6, P2a-D25): the whole active draft read
 * once, scene by scene, each full read replacing the claims of that scene it did not prove again,
 * so a stopped rebuild leaves each scene old or new, never empty; other drafts' rows, the
 * Dismissed list and everything the author wrote are untouched. Priced before it starts; its
 * progress is a settings row, so the queue resumes after a close. At the end, the summary groups
 * what it added by sheet, with *Not right* for a sheet's new lines and *Not names* for the names it
 * left waiting.
 */

/** Starts a rebuild: its progress row, the roster built afresh; answers the scenes to read. */
export function startRebuild(
  db: TreeDb,
  now: Date
): { nodeIds: string[]; progress: RebuildProgress } {
  const nodeIds = readableScenes(db).map((scene) => scene.nodeId)
  const progress: RebuildProgress = {
    startedAt: now.toISOString(),
    finishedAt: nodeIds.length === 0 ? now.toISOString() : null,
    draftId: activeDraftId(db),
    total: nodeIds.length,
    done: 0
  }
  setRebuild(db, progress)
  markRosterForRebuild(db)
  return { nodeIds, progress }
}

/** One scene of the rebuild read (or found unreadable): counted while the rebuild runs. */
export function rebuildSceneDone(db: TreeDb): void {
  const progress = getRebuild(db)
  if (progress?.finishedAt !== null) return
  setRebuild(db, { ...progress, done: Math.min(progress.total, progress.done + 1) })
}

/** The rebuild's readings (its draft, since it started). */
function rebuildReadings(db: TreeDb, progress: RebuildProgress): Set<string> {
  return new Set(
    db
      .select({ id: reading.id })
      .from(reading)
      .where(
        and(
          eq(reading.draftId, progress.draftId),
          eq(reading.purpose, 'rebuild'),
          gte(reading.created, progress.startedAt)
        )
      )
      .all()
      .map((row) => row.id)
  )
}

/** The claims the rebuild's readings stored (not the ones it kept or revived). */
function rebuildClaims(db: TreeDb, progress: RebuildProgress, readings: Set<string>): Claim[] {
  if (readings.size === 0) return []
  return draftClaims(db, progress.draftId).filter(
    (claim) => claim.readingId !== null && readings.has(claim.readingId)
  )
}

/**
 * F-16.22: the secrets and threads the rebuild made: AI-made, made since it started, their
 * defining reveal proved by one of its readings (a topic made before it whose reveal it proved
 * again is not new). Oldest first.
 */
function rebuildTopics(
  db: TreeDb,
  progress: RebuildProgress,
  readings: Set<string>
): RebuildSummary['topics'] {
  if (readings.size === 0) return []
  const made = new Set(
    listTopicQuotes(db, progress.draftId)
      .filter(
        (quote) =>
          quote.role === 'defining' && quote.readingId !== null && readings.has(quote.readingId)
      )
      .map((quote) => quote.recordId)
  )
  return listTopics(db)
    .filter(
      (topic) =>
        topic.origin === 'ai' && topic.created >= progress.startedAt && made.has(topic.recordId)
    )
    .map((topic) => ({ recordId: topic.recordId, kind: topic.kind, label: topic.label }))
}

/**
 * F-16.27, F-16.29 (P4 slice 3): the possible contradictions the rebuild opened: open findings of
 * its draft (the active one) made since it started, as `memory:findings` lists them.
 */
function rebuildFindings(db: TreeDb, progress: RebuildProgress): RebuildSummary['findings'] {
  if (currentDraftId(db) !== progress.draftId) return []
  const opened = findingsOf(db, progress.draftId, ['open']).filter(
    (finding) => finding.created >= progress.startedAt
  )
  if (opened.length === 0) return []
  const ctx = judgeContext(db, progress.draftId)
  return opened.flatMap((finding) => {
    const view = findingView(ctx, finding)
    return view === null ? [] : [view]
  })
}

/**
 * What the last rebuild changed, grouped by sheet; null before any rebuild. `findingsOn` (the
 * Contradiction check switch): off, the possible contradictions are left out, as everywhere.
 */
export function rebuildSummary(db: TreeDb, findingsOn = true): RebuildSummary | null {
  const progress = getRebuild(db)
  if (progress === null) return null
  const readings = rebuildReadings(db, progress)
  const claims = rebuildClaims(db, progress, readings)
  const topics = rebuildTopics(db, progress, readings)
  // A new thread's steps are under "New secrets and threads", not a sheet of their own.
  const fresh = new Set(topics.map((topic) => topic.recordId))
  const sheets = new Map<string, string[]>()
  const waiting = new Map<string, { text: string; lines: number }>()
  for (const claim of claims) {
    if (claim.state === 'live' && claim.recordId !== null && !fresh.has(claim.recordId)) {
      sheets.set(claim.recordId, [...(sheets.get(claim.recordId) ?? []), claim.id])
    }
    if (claim.state === 'waiting' && claim.pending?.kind === 'name') {
      const entry = waiting.get(claim.pending.norm) ?? { text: claim.pending.text, lines: 0 }
      waiting.set(claim.pending.norm, { ...entry, lines: entry.lines + 1 })
    }
  }
  return {
    progress,
    sheets: [...sheets]
      .map(([recordId, claimIds]) => ({
        recordId,
        name: getRecord(db, recordId)?.name ?? '',
        lines: claimIds.length,
        claimIds
      }))
      .filter((sheet) => sheet.name !== '')
      .sort((a, b) => b.lines - a.lines || a.name.localeCompare(b.name)),
    waiting: [...waiting]
      .map(([norm, entry]) => ({ norm, text: entry.text, lines: entry.lines }))
      .sort((a, b) => b.lines - a.lines || a.text.localeCompare(b.text)),
    topics,
    findings: findingsOn ? rebuildFindings(db, progress) : []
  }
}

/** The summary's bulk actions; answers how many lines, names or topics they took away. */
export function applyRebuildAction(
  db: TreeDb,
  action: RebuildAction,
  now: Date
): {
  changed: number
  nodeIds: string[]
  recordIds: string[]
  names: boolean
  /** The secrets and threads that went (*Not a secret* on each, F-16.22). */
  topicIds: string[]
} {
  const progress = getRebuild(db)
  if (progress === null) {
    return { changed: 0, nodeIds: [], recordIds: [], names: false, topicIds: [] }
  }
  if (action.action === 'notProblems') {
    // F-16.29: *Not a problem* on every possible contradiction the rebuild opened.
    const nodeIds = new Set<string>()
    const recordIds = new Set<string>()
    const opened = rebuildFindings(db, progress)
    const byId = new Map(findingsOf(db, progress.draftId).map((each) => [each.id, each]))
    for (const view of opened) {
      const finding = byId.get(view.id)
      if (finding === undefined) continue
      findingNotProblem(db, finding.id, now)
      const touched = findingTouches(finding)
      for (const id of touched.nodeIds) nodeIds.add(id)
      for (const id of touched.recordIds) recordIds.add(id)
    }
    return {
      changed: opened.length,
      nodeIds: [...nodeIds],
      recordIds: [...recordIds],
      names: false,
      topicIds: []
    }
  }
  const readings = rebuildReadings(db, progress)
  if (action.action === 'notTopics') {
    const nodeIds = new Set<string>()
    const recordIds = new Set<string>()
    const topicIds = new Set<string>()
    let changed = 0
    for (const topic of rebuildTopics(db, progress, readings)) {
      // An earlier one's prune may have taken this one already.
      if (topicIds.has(topic.recordId)) continue
      const { change } = topicNotRight(db, topic.recordId, now)
      changed += 1
      for (const id of change.nodeIds) nodeIds.add(id)
      for (const id of change.recordIds) recordIds.add(id)
      for (const id of change.topicIds) topicIds.add(id)
    }
    return {
      changed,
      nodeIds: [...nodeIds],
      recordIds: [...recordIds],
      names: false,
      topicIds: [...topicIds]
    }
  }
  const claims = rebuildClaims(db, progress, readings)
  if (action.action === 'notRightAll') {
    const lines = claims.filter(
      (claim) => claim.state === 'live' && claim.recordId === action.recordId
    )
    db.transaction((tx) => dismissClaimsNotRight(tx, lines, now))
    const changed = lines.length
    return {
      changed,
      nodeIds: [...new Set(lines.map((claim) => claim.nodeId))],
      recordIds: [action.recordId],
      names: false,
      topicIds: []
    }
  }
  const names = new Map<string, string>()
  for (const claim of claims) {
    if (claim.state === 'waiting' && claim.pending?.kind === 'name') {
      names.set(claim.pending.norm, claim.pending.text)
    }
  }
  const nodeIds = new Set<string>()
  for (const text of names.values()) {
    const { settled } = answerNameQuestion(db, { kind: 'notAName', name: text }, now)
    for (const nodeId of settled?.nodeIds ?? []) nodeIds.add(nodeId)
  }
  return {
    changed: names.size,
    nodeIds: [...nodeIds],
    recordIds: [],
    names: names.size > 0,
    topicIds: []
  }
}

/**
 * An unfinished rebuild ends where it stood: *Stop* (the queue's Cancel, without its spot checks),
 * or its last scene job ended (the reader service then queues them). Answers whether it was open.
 */
export function stopRebuild(db: TreeDb, now: Date): boolean {
  const progress = getRebuild(db)
  if (progress?.finishedAt !== null) return false
  setRebuild(db, { ...progress, finishedAt: now.toISOString() })
  return true
}

/**
 * F-16.29 (P4 slice 3): the settings row of the post-rebuild review: the rebuild it is for, and
 * whether the author closed its notice (*Done*). Written when a rebuild that read scenes closes.
 */
export const MEMORY_REBUILD_REVIEW_KEY = 'memoryRebuildReview'
const RebuildReview = z.object({ startedAt: z.string(), reviewed: z.boolean() })

/** A rebuild that read scenes closed: its review is due (the `rebuildDone` notice). */
export function noteRebuildDone(db: TreeDb, startedAt: string): void {
  writeRow(db, MEMORY_REBUILD_REVIEW_KEY, { startedAt, reviewed: false })
}

/** *Done* on the `rebuildDone` notice: never shown again for that rebuild. */
export function reviewRebuild(db: TreeDb, startedAt: string): void {
  const row = readRow(db, MEMORY_REBUILD_REVIEW_KEY, RebuildReview.nullable(), null)
  if (row?.startedAt === startedAt)
    writeRow(db, MEMORY_REBUILD_REVIEW_KEY, { ...row, reviewed: true })
}

/**
 * The `rebuildDone` notice (design §2.7: after a rebuild, one summary grouped by page, with bulk
 * actions): "Rebuild finished: 14 new lines on 6 sheets, 2 names, 3 possible contradictions" while
 * the last rebuild's review is due and the rebuild has finished. Null otherwise.
 */
export function rebuildDoneNotice(db: TreeDb, findingsOn: boolean): MemoryNotice | null {
  const progress = getRebuild(db)
  if (progress === null) return null
  const review = readRow(db, MEMORY_REBUILD_REVIEW_KEY, RebuildReview.nullable(), null)
  if (
    progress.finishedAt === null ||
    review === null ||
    review.reviewed ||
    review.startedAt !== progress.startedAt
  ) {
    return null
  }
  const summary = rebuildSummary(db, findingsOn)
  if (summary === null) return null
  return {
    id: `rebuildDone:${progress.startedAt}`,
    kind: 'rebuildDone',
    startedAt: progress.startedAt,
    lines: summary.sheets.reduce((sum, sheet) => sum + sheet.lines, 0),
    sheets: summary.sheets.length,
    names: summary.waiting.length,
    findings: summary.findings.length
  }
}
