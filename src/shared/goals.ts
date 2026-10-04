import { z } from 'zod'

/**
 * Writing goals (F-10.3): a project word target with an optional deadline, a daily target with
 * streaks, word targets on manuscript nodes, and the session's active time and pace. The targets
 * live in the project `settings` row under `GOALS_KEY` (no migration); the words written live in
 * the `writing_log` table (hourly buckets of the net word change of manuscript documents saved
 * from the editor). One owner for the shapes, the caps, and the day arithmetic, so main and the
 * renderer never disagree on what "today" or a streak is.
 */

/** The `settings` row key the targets live under. */
export const GOALS_KEY = 'goals'

/** Largest word target the app takes, for the project, a day, or a node. */
export const GOAL_TARGET_MAX = 10_000_000

/** Most per-node targets a project keeps. */
export const NODE_TARGETS_MAX = 5_000

/**
 * The longest gap between two saves that still counts as writing: each counted save adds the time
 * since the previous one, capped here, so a lunch break never inflates the session.
 */
export const ACTIVE_GAP_MS = 5 * 60_000

/** Active time below which words per hour is not shown: one save a minute in is no pace yet. */
export const PACE_MIN_ACTIVE_MS = 60_000

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** Whether `day` is a real calendar day written `YYYY-MM-DD`. */
export function isGoalDay(day: string): boolean {
  if (!DAY_PATTERN.test(day)) return false
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  const date = new Date(y, m - 1, d)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d
}

/** A calendar day, `YYYY-MM-DD`. */
export const GoalDay = z.string().refine(isGoalDay, 'Pick a valid date')
export type GoalDay = z.infer<typeof GoalDay>

/** One word target: a whole number from 1 to `GOAL_TARGET_MAX`. */
export const GoalTarget = z
  .number()
  .int('A target is a whole number of words')
  .min(1, 'A target is at least 1 word')
  .max(GOAL_TARGET_MAX, `A target can be at most ${GOAL_TARGET_MAX.toLocaleString()} words`)

/** The stored targets. Every field is defaulted so an older or partial row still parses. */
export const Goals = z.object({
  projectTarget: GoalTarget.nullable().default(null),
  deadline: GoalDay.nullable().default(null),
  dailyTarget: GoalTarget.nullable().default(null),
  /** Word targets by node id, on manuscript documents and folders. */
  nodeTargets: z
    .record(z.string().min(1), GoalTarget)
    .refine((targets) => Object.keys(targets).length <= NODE_TARGETS_MAX, {
      message: `At most ${NODE_TARGETS_MAX} node targets`
    })
    .default({})
})
export type Goals = z.infer<typeof Goals>

/** The targets of a project that never set any (or whose row is unreadable). */
export function defaultGoals(): Goals {
  return { projectTarget: null, deadline: null, dailyTarget: null, nodeTargets: {} }
}

/** One node target change: a number sets it, null clears it. */
export const NodeTargetChange = z.object({
  nodeId: z.string().min(1),
  target: GoalTarget.nullable()
})
export type NodeTargetChange = z.infer<typeof NodeTargetChange>

/** What `goals:set` takes: only the fields that change; null clears a target or the deadline. */
export const GoalsPatch = z.object({
  projectTarget: GoalTarget.nullable().optional(),
  deadline: GoalDay.nullable().optional(),
  dailyTarget: GoalTarget.nullable().optional(),
  nodeTargets: z.array(NodeTargetChange).max(NODE_TARGETS_MAX).optional()
})
export type GoalsPatch = z.infer<typeof GoalsPatch>

/** What `goals:get` and `goals:set` answer: the targets and where the author stands against them. */
export const GoalsStatus = z.object({
  goals: Goals,
  /** Words in every manuscript document now. */
  manuscriptWords: z.number().int().nonnegative(),
  /** Today's net words written (never below 0 here; the log keeps the signed figure). */
  today: z.object({ day: GoalDay, words: z.number().int().nonnegative() }),
  /** Consecutive days at the daily target; both 0 without a daily target. */
  streak: z.object({
    current: z.number().int().nonnegative(),
    best: z.number().int().nonnegative()
  }),
  /** Days left until the deadline, today and the deadline included; 0 once it has passed. */
  daysLeft: z.number().int().nonnegative().nullable(),
  /** Words a day still needed to reach the project target by the deadline. */
  perDayNeeded: z.number().int().nonnegative().nullable(),
  /** Since the project was opened: net words (never below 0) and active writing time. */
  session: z.object({
    words: z.number().int().nonnegative(),
    activeMs: z.number().int().nonnegative()
  })
})
export type GoalsStatus = z.infer<typeof GoalsStatus>

/**
 * The targets with `patch` applied. Node target changes are applied in order (null deletes);
 * a set past `NODE_TARGETS_MAX` is left out rather than failing the whole patch.
 */
export function applyGoalsPatch(goals: Goals, patch: GoalsPatch): Goals {
  const next: Goals = { ...goals, nodeTargets: { ...goals.nodeTargets } }
  if (patch.projectTarget !== undefined) next.projectTarget = patch.projectTarget
  if (patch.deadline !== undefined) next.deadline = patch.deadline
  if (patch.dailyTarget !== undefined) next.dailyTarget = patch.dailyTarget
  for (const change of patch.nodeTargets ?? []) {
    if (change.target === null) delete next.nodeTargets[change.nodeId]
    else if (
      change.nodeId in next.nodeTargets ||
      Object.keys(next.nodeTargets).length < NODE_TARGETS_MAX
    )
      next.nodeTargets[change.nodeId] = change.target
  }
  return next
}

const pad = (n: number): string => String(n).padStart(2, '0')

/** The local calendar day of `date`, `YYYY-MM-DD`. */
export function localDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/** The local hour of `date`, 0–23. */
export function localHour(date: Date): number {
  return date.getHours()
}

/** Midday of a `YYYY-MM-DD` day in local time, so adding days never trips over a DST change. */
function dayDate(day: string): Date {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

/** The day `n` days after `day` (before it for a negative `n`). */
export function addDays(day: string, n: number): string {
  const date = dayDate(day)
  date.setDate(date.getDate() + n)
  return localDay(date)
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((dayDate(to).getTime() - dayDate(from).getTime()) / 86_400_000)
}

/**
 * The streaks over `days` (net words by day): `current` is the run of consecutive days at or
 * over `dailyTarget` that ends today, or ends yesterday while today is still under target (the
 * streak is not lost until the day is over); `best` is the longest run ever, the current one
 * included. No daily target means no streak.
 */
export function computeStreak(
  days: Readonly<Record<string, number>>,
  dailyTarget: number | null,
  today: string
): { current: number; best: number } {
  if (dailyTarget === null) return { current: 0, best: 0 }
  const met = (day: string): boolean => (days[day] ?? 0) >= dailyTarget
  let current = 0
  for (let day = met(today) ? today : addDays(today, -1); met(day); day = addDays(day, -1))
    current += 1
  const metDays = Object.keys(days)
    .filter((day) => isGoalDay(day) && met(day))
    .sort()
  let best = 0
  let run = 0
  let previous: string | null = null
  for (const day of metDays) {
    run = previous !== null && daysBetween(previous, day) === 1 ? run + 1 : 1
    best = Math.max(best, run)
    previous = day
  }
  return { current, best: Math.max(best, current) }
}

/** Days left until `deadline`, today and the deadline both counted; 0 once it has passed, null without one. */
export function daysLeft(deadline: string | null, today: string): number | null {
  if (deadline === null) return null
  return Math.max(0, daysBetween(today, deadline) + 1)
}

/**
 * Words a day still needed to reach `target` by `deadline`: the words remaining spread over the
 * days left, rounded up. 0 once the target is met; null without a target or a deadline, or once
 * the deadline has passed with words still to write.
 */
export function perDayNeeded(
  total: number,
  target: number | null,
  deadline: string | null,
  today: string
): number | null {
  if (target === null || deadline === null) return null
  const remaining = target - total
  if (remaining <= 0) return 0
  const left = daysLeft(deadline, today) ?? 0
  return left === 0 ? null : Math.ceil(remaining / left)
}

/** Words per active hour, rounded; null until `PACE_MIN_ACTIVE_MS` of writing. */
export function wordsPerHour(words: number, activeMs: number): number | null {
  if (activeMs < PACE_MIN_ACTIVE_MS) return null
  return Math.round(Math.max(0, words) / (activeMs / 3_600_000))
}

/** The active time a save at `now` adds: the gap since the previous save, capped at `ACTIVE_GAP_MS`. */
export function addActiveTime(lastWriteAt: number | null, now: number): number {
  if (lastWriteAt === null || now <= lastWriteAt) return 0
  return Math.min(now - lastWriteAt, ACTIVE_GAP_MS)
}

/** How far `words` is toward `target`, clamped to 0–1; 0 without a target. */
export function progressRatio(words: number, target: number | null): number {
  if (target === null || target <= 0) return 0
  return Math.min(1, Math.max(0, words / target))
}

/**
 * A word target as typed: digits with optional thousands separators (`2,000` and `2 000` are
 * both 2000; a point is refused, since `2.5` must not read as 25). Null when it is not a whole
 * number in range.
 */
export function parseGoalTarget(input: string): number | null {
  const digits = input.trim().replace(/[\s,'’_]/g, '')
  if (!/^\d+$/.test(digits)) return null
  const value = Number(digits)
  return GoalTarget.safeParse(value).success ? value : null
}

/** What a target field says about `input`: null when it is a valid target (or empty, when `optional`). */
export function goalTargetError(input: string, optional = false): string | null {
  if (optional && input.trim() === '') return null
  return parseGoalTarget(input) === null
    ? `Type a whole number of words from 1 to ${GOAL_TARGET_MAX.toLocaleString()}.`
    : null
}
