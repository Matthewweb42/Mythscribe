import { eq, sql } from 'drizzle-orm'
import {
  addActiveTime,
  applyGoalsPatch,
  computeStreak,
  daysLeft,
  localDay,
  localHour,
  perDayNeeded,
  type Goals,
  type GoalsPatch,
  type GoalsStatus
} from '@shared/goals'
import { node, writingLog } from '../db/schema'
import { AppError } from '../ipc/errors'
import { getGoals, setGoals } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'

/**
 * Writing goals (F-10.3), main side: the targets in the `goals` settings row, the words written
 * in `writing_log`, and the session since the project was opened. Only `document:save` records
 * writing (through `manuscriptWordCount` before the save and `recordWriting` after it), so
 * import, replace, delete, move, and duplicate never count as words written.
 */

interface Session {
  words: number
  activeMs: number
  lastWriteAt: number | null
}

const freshSession = (): Session => ({ words: 0, activeMs: 0, lastWriteAt: null })

/** The session belongs to the open project; `manager.onChange` resets it. */
let session: Session = freshSession()

/** Forgets the session's words and time; called on every project open, create, and close. */
export function resetGoalsSession(): void {
  session = freshSession()
}

/** The light row the goals need: no content, no notes. */
interface GoalNode {
  id: string
  parentId: string | null
  sectionType: string | null
  kind: string
  wordCount: number
}

const goalColumns = {
  id: node.id,
  parentId: node.parentId,
  sectionType: node.sectionType,
  kind: node.kind,
  wordCount: node.wordCount
}

/** Every node, without content: what the rollup and the pruning walk. */
function goalNodes(db: TreeDb): GoalNode[] {
  return db.select(goalColumns).from(node).all()
}

/** The ids of every node under the manuscript root (the root itself excluded). */
function manuscriptIds(rows: readonly GoalNode[]): Set<string> {
  const root = rows.find((row) => row.parentId === null && row.sectionType === 'manuscript')
  const ids = new Set<string>()
  if (!root) return ids
  const children = new Map<string, GoalNode[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const list = children.get(row.parentId)
    if (list) list.push(row)
    else children.set(row.parentId, [row])
  }
  const stack = [...(children.get(root.id) ?? [])]
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    ids.add(next.id)
    stack.push(...(children.get(next.id) ?? []))
  }
  return ids
}

/**
 * The stored word count of `id` when it is a document under the manuscript, else null (a matter
 * document, a folder, an unknown id). Read before a save so the delta is the save's own.
 */
export function manuscriptWordCount(db: TreeDb, id: string): number | null {
  const row = db.select(goalColumns).from(node).where(eq(node.id, id)).get()
  if (row?.kind !== 'document') return null
  for (let parentId = row.parentId; parentId !== null;) {
    const parent = db.select(goalColumns).from(node).where(eq(node.id, parentId)).get()
    if (!parent) return null
    if (parent.parentId === null) return parent.sectionType === 'manuscript' ? row.wordCount : null
    parentId = parent.parentId
  }
  return null
}

/**
 * Records one counted save: `delta` net words and the active time since the previous counted
 * save (`addActiveTime`) go into the bucket of `now`'s local day and hour, and into the session.
 * A save that changed nothing and added no time writes no row.
 */
export function recordWriting(db: TreeDb, delta: number, now: Date = new Date()): void {
  const at = now.getTime()
  const activeMs = addActiveTime(session.lastWriteAt, at)
  session = {
    words: session.words + delta,
    activeMs: session.activeMs + activeMs,
    lastWriteAt: at
  }
  if (delta === 0 && activeMs === 0) return
  db.insert(writingLog)
    .values({ day: localDay(now), hour: localHour(now), words: delta, activeMs })
    .onConflictDoUpdate({
      target: [writingLog.day, writingLog.hour],
      set: {
        words: sql`${writingLog.words} + ${delta}`,
        activeMs: sql`${writingLog.activeMs} + ${activeMs}`
      }
    })
    .run()
}

/** Net words written per local day, from the log. */
export function wordsByDay(db: TreeDb): Record<string, number> {
  const rows = db
    .select({ day: writingLog.day, words: sql<number>`SUM(${writingLog.words})` })
    .from(writingLog)
    .groupBy(writingLog.day)
    .all()
  const days: Record<string, number> = {}
  for (const row of rows) days[row.day] = Number(row.words)
  return days
}

/** `goals` without node targets on nodes that are gone or not in the manuscript; the same object when none dropped. */
function pruneGoals(goals: Goals, manuscript: ReadonlySet<string>): Goals {
  const kept = Object.entries(goals.nodeTargets).filter(([id]) => manuscript.has(id))
  if (kept.length === Object.keys(goals.nodeTargets).length) return goals
  return { ...goals, nodeTargets: Object.fromEntries(kept) }
}

/** The stored goals, pruned; the row is rewritten when something dropped. */
export function readGoals(db: TreeDb): Goals {
  return readPruned(db, goalNodes(db))
}

function readPruned(db: TreeDb, rows: readonly GoalNode[]): Goals {
  const stored = getGoals(db)
  const pruned = pruneGoals(stored, manuscriptIds(rows))
  return pruned === stored ? stored : setGoals(db, pruned)
}

/**
 * Applies `patch` to the stored goals and stores the result. A node target can only be set on a
 * node in the manuscript (VALIDATION otherwise); clearing one is always accepted.
 */
export function updateGoals(db: TreeDb, patch: GoalsPatch): Goals {
  const rows = goalNodes(db)
  const manuscript = manuscriptIds(rows)
  for (const change of patch.nodeTargets ?? []) {
    if (change.target !== null && !manuscript.has(change.nodeId)) {
      throw new AppError('VALIDATION', 'Word targets go on manuscript chapters and scenes', {
        nodeId: change.nodeId
      })
    }
  }
  return setGoals(db, pruneGoals(applyGoalsPatch(readPruned(db, rows), patch), manuscript))
}

/** Where the author stands: the goals, the manuscript's words, today, the streaks, the pace, and the session. */
export function goalsStatus(db: TreeDb, now: Date = new Date()): GoalsStatus {
  const rows = goalNodes(db)
  const goals = readPruned(db, rows)
  const manuscript = manuscriptIds(rows)
  let manuscriptWords = 0
  for (const row of rows)
    if (row.kind === 'document' && manuscript.has(row.id)) manuscriptWords += row.wordCount
  const today = localDay(now)
  const days = wordsByDay(db)
  return {
    goals,
    manuscriptWords,
    today: { day: today, words: Math.max(0, days[today] ?? 0) },
    streak: computeStreak(days, goals.dailyTarget, today),
    daysLeft: daysLeft(goals.deadline, today),
    perDayNeeded: perDayNeeded(manuscriptWords, goals.projectTarget, goals.deadline, today),
    session: { words: Math.max(0, session.words), activeMs: session.activeMs }
  }
}
