import { z } from 'zod'
import { addDays, daysBetween, GoalDay } from './goals'

/**
 * The statistics dashboard (F-10.5): the writing heatmap, words per day, productive hours, the
 * scene length distribution, POV distribution, character appearances, and setting usage. Main
 * answers one `StatsDashboard` from `writing_log` (F-10.3) and the stored node rows, tags,
 * mentions, and entities; the arithmetic both sides lean on lives here so it is tested once.
 * Days and hours are the local ones `writing_log` stores; the day math is `goals.ts`'s.
 */

/** Weeks the heatmap covers, ending with the current week. */
export const HEATMAP_WEEKS = 53

/** Days of the log main sends: every day the heatmap can show (53 full weeks). */
export const STATS_LOG_DAYS = HEATMAP_WEEKS * 7

/** Days the words-per-day chart covers, ending today. */
export const WORDS_PER_DAY_DAYS = 30

/** Most rows the character and setting lists carry. */
export const STATS_ROWS_MAX = 50

/** The scene length buckets, inclusive bounds; `max` null is open-ended. */
export const SCENE_LENGTH_BUCKETS: readonly { label: string; min: number; max: number | null }[] = [
  { label: '0', min: 0, max: 0 },
  { label: '1–499', min: 1, max: 499 },
  { label: '500–999', min: 500, max: 999 },
  { label: '1,000–1,999', min: 1000, max: 1999 },
  { label: '2,000–2,999', min: 2000, max: 2999 },
  { label: '3,000–4,999', min: 3000, max: 4999 },
  { label: '5,000+', min: 5000, max: null }
]

const Count = z.number().int().nonnegative()

/** One logged day: net words (may be negative) and active writing time. */
export const StatsDay = z.object({ day: GoalDay, words: z.number().int(), activeMs: Count })
export type StatsDay = z.infer<typeof StatsDay>

/** One hour of the day over the whole log: words of the hours that added words, and time. */
export const StatsHour = z.object({
  hour: z.number().int().min(0).max(23),
  words: Count,
  activeMs: Count
})
export type StatsHour = z.infer<typeof StatsHour>

/** A manuscript document by its stored word count. */
export const SceneRef = z.object({ id: z.string(), title: z.string(), words: Count })
export type SceneRef = z.infer<typeof SceneRef>

export const SceneLengthBucket = z.object({
  label: z.string(),
  min: Count,
  max: Count.nullable(),
  count: Count
})
export type SceneLengthBucket = z.infer<typeof SceneLengthBucket>

export const SceneLengthStats = z.object({
  count: Count,
  buckets: z.array(SceneLengthBucket),
  median: Count,
  mean: Count,
  shortest: SceneRef.nullable(),
  longest: SceneRef.nullable()
})
export type SceneLengthStats = z.infer<typeof SceneLengthStats>

/** Scenes and words by point of view; `pov` null is the scenes without one. */
export const PovRow = z.object({ pov: z.string().nullable(), scenes: Count, words: Count })
export type PovRow = z.infer<typeof PovRow>

/**
 * A character or setting: the manuscript documents it is linked to or mentioned in (and, for a
 * setting, set in), the mentions summed, and for a character the scenes told from its POV.
 * `tagId` null is a scene location that matches no setting tag.
 */
export const AppearanceRow = z.object({
  tagId: z.string().nullable(),
  name: z.string(),
  scenes: Count,
  mentions: Count,
  povScenes: Count.optional()
})
export type AppearanceRow = z.infer<typeof AppearanceRow>

/** What `stats:dashboard` answers. */
export const StatsDashboard = z.object({
  today: GoalDay,
  /** Only the days with log rows, within the last `STATS_LOG_DAYS` days, oldest first. */
  days: z.array(StatsDay),
  /** Always 24 entries, hour 0 first. */
  hours: z.array(StatsHour),
  scenes: SceneLengthStats,
  pov: z.array(PovRow),
  characters: z.array(AppearanceRow),
  settings: z.array(AppearanceRow),
  truncated: z.object({ characters: z.boolean(), settings: z.boolean() })
})
export type StatsDashboard = z.infer<typeof StatsDashboard>

/** The lowercase, single-spaced form two names are compared in; hyphens count as spaces, so a tag `mara-voss` matches "Mara Voss". */
export function nameKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, ' ')
}

/** Count, buckets, median and mean (rounded), and the shortest and longest (first in reading order on a tie). */
export function sceneLengthStats(scenes: readonly SceneRef[]): SceneLengthStats {
  const buckets = SCENE_LENGTH_BUCKETS.map((bucket) => ({ ...bucket, count: 0 }))
  let shortest: SceneRef | null = null
  let longest: SceneRef | null = null
  let total = 0
  for (const scene of scenes) {
    const bucket = buckets.find(
      (b) => scene.words >= b.min && (b.max === null || scene.words <= b.max)
    )
    if (bucket) bucket.count += 1
    if (shortest === null || scene.words < shortest.words) shortest = scene
    if (longest === null || scene.words > longest.words) longest = scene
    total += scene.words
  }
  const sorted = scenes.map((scene) => scene.words).sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const median =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? (sorted[mid] ?? 0)
        : Math.round(((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2)
  return {
    count: scenes.length,
    buckets,
    median,
    mean: scenes.length === 0 ? 0 : Math.round(total / scenes.length),
    shortest,
    longest
  }
}

/**
 * Scenes and words by POV: trimmed, grouped case-insensitively (the first spelling in reading
 * order names the row), sorted by scenes then name; scenes without a POV are one `pov: null`
 * row, last among equals.
 */
export function tallyPov(scenes: readonly { pov: string; words: number }[]): PovRow[] {
  const rows = new Map<string, PovRow>()
  for (const scene of scenes) {
    const pov = scene.pov.trim()
    const key = nameKey(pov)
    const row = rows.get(key) ?? { pov: pov === '' ? null : pov, scenes: 0, words: 0 }
    row.scenes += 1
    row.words += scene.words
    rows.set(key, row)
  }
  return [...rows.values()].sort((a, b) => {
    if (b.scenes !== a.scenes) return b.scenes - a.scenes
    if (a.pov === null) return 1
    if (b.pov === null) return -1
    return a.pov.localeCompare(b.pov)
  })
}

/** The weekday of a `YYYY-MM-DD` day, Monday 0 to Sunday 6. */
export function weekdayIndex(day: string): number {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return (new Date(y, m - 1, d, 12).getDay() + 6) % 7
}

/** One heatmap cell: a day and its net words. */
export interface HeatCell {
  day: string
  words: number
}

/**
 * The heatmap: `HEATMAP_WEEKS` columns of 7 days each, Monday first, the last column holding
 * today. Days after today are null. Days without a log row have 0 words.
 */
export function heatmapGrid(days: readonly StatsDay[], today: string): (HeatCell | null)[][] {
  const words = new Map(days.map((d) => [d.day, d.words]))
  const start = addDays(today, -weekdayIndex(today) - (HEATMAP_WEEKS - 1) * 7)
  const weeks: (HeatCell | null)[][] = []
  for (let w = 0; w < HEATMAP_WEEKS; w++) {
    const week: (HeatCell | null)[] = []
    for (let d = 0; d < 7; d++) {
      const day = addDays(start, w * 7 + d)
      week.push(daysBetween(day, today) < 0 ? null : { day, words: words.get(day) ?? 0 })
    }
    weeks.push(week)
  }
  return weeks
}

/**
 * The three cut points between shade levels 1–4: the quartiles of the days that added words,
 * taken at the lower rank so the busiest day is above the last cut (and shades darkest) unless
 * it ties. Empty when no day did.
 */
export function heatThresholds(days: readonly StatsDay[]): number[] {
  const positive = days
    .map((d) => d.words)
    .filter((w) => w > 0)
    .sort((a, b) => a - b)
  if (positive.length === 0) return []
  const at = (q: number): number => positive[Math.floor(q * (positive.length - 1))] ?? 0
  return [at(0.25), at(0.5), at(0.75)]
}

/** The shade of a day, 0–4: 0 for no words (or words cut), then by `thresholds`. */
export function heatLevel(words: number, thresholds: readonly number[]): number {
  if (words <= 0) return 0
  let level = 1
  for (const cut of thresholds) if (words > cut) level += 1
  return Math.min(level, 4)
}

/** The last `n` days ending today, oldest first, with their net words (0 without a row). */
export function dailySeries(days: readonly StatsDay[], today: string, n: number): HeatCell[] {
  const words = new Map(days.map((d) => [d.day, d.words]))
  const series: HeatCell[] = []
  for (let i = n - 1; i >= 0; i--) {
    const day = addDays(today, -i)
    series.push({ day, words: words.get(day) ?? 0 })
  }
  return series
}

/** The hour with the most words (the earliest on a tie), or null when no hour added any. */
export function bestHour(hours: readonly StatsHour[]): number | null {
  let best: StatsHour | null = null
  for (const hour of hours)
    if (hour.words > 0 && (best === null || hour.words > best.words)) best = hour
  return best === null ? null : best.hour
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** A `YYYY-MM-DD` day as `Sun 4 Oct 2026`: weekday, day, month, year, independent of the locale. */
export function formatStatsDay(day: string): string {
  const [y = 0, m = 1, d = 1] = day.split('-').map(Number)
  return `${WEEKDAYS[weekdayIndex(day)] ?? ''} ${d} ${MONTHS[m - 1] ?? ''} ${y}`
}

/** A day's title: `Mon 4 Oct 2026: 1,234 words`, or `… 12 words cut` for a net loss. */
export function describeStatsDay(day: string, words: number): string {
  const amount = Math.abs(words).toLocaleString()
  const unit = Math.abs(words) === 1 ? 'word' : 'words'
  return `${formatStatsDay(day)}: ${words < 0 ? `${amount} ${unit} cut` : `${amount} ${unit}`}`
}

/** `21:00`. */
export function formatHour(hour: number): string {
  return `${String(hour).padStart(2, '0')}:00`
}
