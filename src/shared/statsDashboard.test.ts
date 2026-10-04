import { describe, expect, it } from 'vitest'
import { daysBetween } from './goals'
import {
  bestHour,
  dailySeries,
  describeStatsDay,
  formatHour,
  formatStatsDay,
  HEATMAP_WEEKS,
  heatLevel,
  heatmapGrid,
  heatThresholds,
  nameKey,
  SCENE_LENGTH_BUCKETS,
  sceneLengthStats,
  STATS_LOG_DAYS,
  tallyPov,
  weekdayIndex,
  type StatsDay,
  type StatsHour
} from './statsDashboard'

const day = (d: string, words: number): StatsDay => ({ day: d, words, activeMs: 0 })
const scene = (id: string, words: number): { id: string; title: string; words: number } => ({
  id,
  title: `Scene ${id}`,
  words
})

describe('sceneLengthStats (F-10.5)', () => {
  it('buckets on inclusive boundaries', () => {
    const stats = sceneLengthStats(
      [0, 1, 499, 500, 999, 1000, 1999, 2000, 2999, 3000, 4999, 5000, 12_000].map((w, i) =>
        scene(String(i), w)
      )
    )
    expect(stats.buckets.map((b) => b.count)).toEqual([1, 2, 2, 2, 2, 2, 2])
    expect(stats.buckets.map((b) => b.label)).toEqual(SCENE_LENGTH_BUCKETS.map((b) => b.label))
    expect(stats.count).toBe(13)
    expect(stats.median).toBe(1999)
  })

  it('reports median, mean, and the first shortest and longest in reading order', () => {
    const stats = sceneLengthStats([
      scene('a', 300),
      scene('b', 100),
      scene('c', 300),
      scene('d', 100)
    ])
    expect(stats.median).toBe(200)
    expect(stats.mean).toBe(200)
    expect(stats.shortest?.id).toBe('b')
    expect(stats.longest?.id).toBe('a')
  })

  it('is all zeros without scenes', () => {
    const stats = sceneLengthStats([])
    expect(stats).toMatchObject({ count: 0, median: 0, mean: 0, shortest: null, longest: null })
    expect(stats.buckets.every((b) => b.count === 0)).toBe(true)
  })
})

describe('tallyPov (F-10.5)', () => {
  it('groups by name key (case, spaces, hyphens) under the first spelling, sorts by scenes, and keeps No POV last among equals', () => {
    expect(
      tallyPov([
        { pov: ' Mara ', words: 100 },
        { pov: '', words: 50 },
        { pov: 'mara', words: 200 },
        { pov: 'Ilse Kahn', words: 1 },
        { pov: 'ilse-kahn', words: 2 },
        { pov: 'Ilse', words: 10 },
        { pov: '  ', words: 5 },
        { pov: 'Bo', words: 1 }
      ])
    ).toEqual([
      { pov: 'Ilse Kahn', scenes: 2, words: 3 },
      { pov: 'Mara', scenes: 2, words: 300 },
      { pov: null, scenes: 2, words: 55 },
      { pov: 'Bo', scenes: 1, words: 1 },
      { pov: 'Ilse', scenes: 1, words: 10 }
    ])
  })
})

describe('day helpers (F-10.5)', () => {
  it('numbers weekdays from Monday', () => {
    expect(weekdayIndex('2026-09-28')).toBe(0)
    expect(weekdayIndex('2026-10-04')).toBe(6)
  })

  it('formats days, titles, and hours without the locale', () => {
    expect(formatStatsDay('2026-10-04')).toBe('Sun 4 Oct 2026')
    expect(describeStatsDay('2026-10-05', 1)).toBe('Mon 5 Oct 2026: 1 word')
    expect(describeStatsDay('2026-10-05', -12)).toBe('Mon 5 Oct 2026: 12 words cut')
    expect(describeStatsDay('2026-10-05', 0)).toBe('Mon 5 Oct 2026: 0 words')
    expect(formatHour(7)).toBe('07:00')
  })

  it('compares names with case, spaces, and hyphens folded', () => {
    expect(nameKey('  Mara  Voss ')).toBe(nameKey('mara-voss'))
  })
})

describe('heatmapGrid (F-10.5)', () => {
  it('lays out 53 Monday-first weeks ending in the current week, future days null', () => {
    const today = '2026-10-01' // a Thursday
    const grid = heatmapGrid([day('2026-10-01', 40), day('2026-09-28', -3)], today)
    expect(grid).toHaveLength(HEATMAP_WEEKS)
    expect(grid.every((week) => week.length === 7)).toBe(true)
    const last = grid[HEATMAP_WEEKS - 1] ?? []
    expect(last.map((cell) => cell?.day ?? null)).toEqual([
      '2026-09-28',
      '2026-09-29',
      '2026-09-30',
      '2026-10-01',
      null,
      null,
      null
    ])
    expect(last[0]?.words).toBe(-3)
    expect(last[3]?.words).toBe(40)
    expect(last[1]?.words).toBe(0)
    const first = grid[0]?.[0]
    expect(first?.day).toBe('2025-09-29')
    expect(weekdayIndex(first?.day ?? '')).toBe(0)
  })

  it('never reaches further back than the days main sends', () => {
    // On a Sunday the grid starts furthest back: exactly the first of the STATS_LOG_DAYS days.
    const today = '2026-10-04'
    expect(heatmapGrid([], today)[0]?.[0]?.day).toBe('2025-09-29')
    expect(daysBetween('2025-09-29', today) + 1).toBe(STATS_LOG_DAYS)
  })
})

describe('heatThresholds / heatLevel (F-10.5)', () => {
  it('cuts the positive days into quartiles', () => {
    const thresholds = heatThresholds([
      day('2026-01-01', 10),
      day('2026-01-02', 20),
      day('2026-01-03', 30),
      day('2026-01-04', 40),
      day('2026-01-05', 0),
      day('2026-01-06', -5)
    ])
    expect(thresholds).toEqual([10, 20, 30])
    expect([10, 20, 30, 40].map((w) => heatLevel(w, thresholds))).toEqual([1, 2, 3, 4])
    expect(heatLevel(0, thresholds)).toBe(0)
    expect(heatLevel(-5, thresholds)).toBe(0)
  })

  it('shades a lone writing day and nothing without one', () => {
    expect(heatThresholds([day('2026-01-01', -1)])).toEqual([])
    const two = heatThresholds([day('2026-01-01', 300), day('2026-01-02', 1234)])
    expect([heatLevel(300, two), heatLevel(1234, two)]).toEqual([1, 4])
    const one = heatThresholds([day('2026-01-01', 9)])
    expect(heatLevel(9, one)).toBe(1)
    expect(heatLevel(9, [])).toBe(1)
  })
})

describe('dailySeries / bestHour (F-10.5)', () => {
  it('fills the last n days with zeros, oldest first', () => {
    expect(dailySeries([day('2026-10-03', 5)], '2026-10-04', 3)).toEqual([
      { day: '2026-10-02', words: 0 },
      { day: '2026-10-03', words: 5 },
      { day: '2026-10-04', words: 0 }
    ])
  })

  it('picks the hour with the most words, the earliest on a tie, null without words', () => {
    const hours: StatsHour[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      words: hour === 9 || hour === 21 ? 100 : 0,
      activeMs: 0
    }))
    expect(bestHour(hours)).toBe(9)
    expect(bestHour(hours.map((h) => ({ ...h, words: 0 })))).toBeNull()
  })
})
