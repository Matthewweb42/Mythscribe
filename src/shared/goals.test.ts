import { describe, expect, it } from 'vitest'
import {
  ACTIVE_GAP_MS,
  GOAL_TARGET_MAX,
  Goals,
  GoalsPatch,
  NODE_TARGETS_MAX,
  addActiveTime,
  addDays,
  applyGoalsPatch,
  computeStreak,
  daysBetween,
  daysLeft,
  defaultGoals,
  goalTargetError,
  isGoalDay,
  localDay,
  localHour,
  parseGoalTarget,
  perDayNeeded,
  progressRatio,
  wordsPerHour
} from './goals'

describe('Goals', () => {
  it('parses an empty or partial row with every field defaulted', () => {
    expect(Goals.parse({})).toEqual(defaultGoals())
    expect(Goals.parse({ dailyTarget: 500 })).toEqual({ ...defaultGoals(), dailyTarget: 500 })
  })

  it('refuses a target outside 1..GOAL_TARGET_MAX, a fraction, and a date that is not a day', () => {
    expect(Goals.safeParse({ projectTarget: 0 }).success).toBe(false)
    expect(Goals.safeParse({ projectTarget: GOAL_TARGET_MAX + 1 }).success).toBe(false)
    expect(Goals.safeParse({ dailyTarget: 1.5 }).success).toBe(false)
    expect(Goals.safeParse({ deadline: '2026-02-30' }).success).toBe(false)
    expect(Goals.safeParse({ deadline: '2026-2-3' }).success).toBe(false)
    expect(Goals.safeParse({ nodeTargets: { a: 0 } }).success).toBe(false)
  })
})

describe('isGoalDay', () => {
  it('accepts a real day and refuses the rest', () => {
    expect(isGoalDay('2028-02-29')).toBe(true)
    expect(isGoalDay('2026-02-29')).toBe(false)
    expect(isGoalDay('2026-13-01')).toBe(false)
    expect(isGoalDay('tomorrow')).toBe(false)
  })
})

describe('applyGoalsPatch', () => {
  it('changes only the fields given, null clearing them', () => {
    const goals = { ...defaultGoals(), projectTarget: 80_000, deadline: '2026-12-31' }
    expect(applyGoalsPatch(goals, { dailyTarget: 500 })).toEqual({ ...goals, dailyTarget: 500 })
    expect(applyGoalsPatch(goals, { deadline: null })).toEqual({ ...goals, deadline: null })
  })

  it('sets and clears node targets in order without touching the input', () => {
    const goals = { ...defaultGoals(), nodeTargets: { a: 1000 } }
    const next = applyGoalsPatch(goals, {
      nodeTargets: [
        { nodeId: 'b', target: 2000 },
        { nodeId: 'a', target: null }
      ]
    })
    expect(next.nodeTargets).toEqual({ b: 2000 })
    expect(goals.nodeTargets).toEqual({ a: 1000 })
  })

  it('leaves out a new node target past the cap but still changes an existing one', () => {
    const nodeTargets: Record<string, number> = {}
    for (let i = 0; i < NODE_TARGETS_MAX; i++) nodeTargets[`n${i}`] = 10
    const next = applyGoalsPatch(
      { ...defaultGoals(), nodeTargets },
      {
        nodeTargets: [
          { nodeId: 'extra', target: 5 },
          { nodeId: 'n0', target: 20 }
        ]
      }
    )
    expect(next.nodeTargets.extra).toBeUndefined()
    expect(next.nodeTargets.n0).toBe(20)
  })

  it('patch schema takes partial input and refuses a bad target', () => {
    expect(GoalsPatch.parse({})).toEqual({})
    expect(GoalsPatch.safeParse({ nodeTargets: [{ nodeId: 'a', target: -1 }] }).success).toBe(false)
  })
})

describe('day arithmetic', () => {
  it('formats the local day and hour', () => {
    const date = new Date(2026, 0, 5, 23, 59)
    expect(localDay(date)).toBe('2026-01-05')
    expect(localHour(date)).toBe(23)
  })

  it('adds days across month and year ends and counts days between', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01')
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(daysBetween('2026-10-04', '2026-10-11')).toBe(7)
    expect(daysBetween('2026-10-11', '2026-10-04')).toBe(-7)
    // Across a DST change in many zones; midday arithmetic keeps whole days.
    expect(daysBetween('2026-03-01', '2026-04-01')).toBe(31)
  })
})

describe('computeStreak', () => {
  const today = '2026-10-04'

  it('has no streak without a daily target', () => {
    expect(computeStreak({ [today]: 900 }, null, today)).toEqual({ current: 0, best: 0 })
  })

  it('counts consecutive met days ending today', () => {
    const days = { '2026-10-02': 500, '2026-10-03': 600, '2026-10-04': 501 }
    expect(computeStreak(days, 500, today)).toEqual({ current: 3, best: 3 })
  })

  it('keeps yesterday’s streak while today is still under target', () => {
    const days = { '2026-10-02': 500, '2026-10-03': 600, '2026-10-04': 100 }
    expect(computeStreak(days, 500, today)).toEqual({ current: 2, best: 2 })
  })

  it('breaks on a missed day and remembers the best run', () => {
    const days = {
      '2026-09-01': 500,
      '2026-09-02': 500,
      '2026-09-03': 500,
      '2026-09-04': 499,
      '2026-10-02': 700
    }
    expect(computeStreak(days, 500, today)).toEqual({ current: 0, best: 3 })
  })
})

describe('daysLeft and perDayNeeded', () => {
  it('counts today and the deadline', () => {
    expect(daysLeft('2026-10-04', '2026-10-04')).toBe(1)
    expect(daysLeft('2026-10-13', '2026-10-04')).toBe(10)
    expect(daysLeft('2026-10-01', '2026-10-04')).toBe(0)
    expect(daysLeft(null, '2026-10-04')).toBeNull()
  })

  it('spreads the remaining words over the days left, rounded up', () => {
    expect(perDayNeeded(1000, 2001, '2026-10-13', '2026-10-04')).toBe(101)
    expect(perDayNeeded(2500, 2000, '2026-10-13', '2026-10-04')).toBe(0)
    expect(perDayNeeded(10, 2000, '2026-10-01', '2026-10-04')).toBeNull()
    expect(perDayNeeded(10, null, '2026-10-13', '2026-10-04')).toBeNull()
    expect(perDayNeeded(10, 2000, null, '2026-10-04')).toBeNull()
  })
})

describe('pace and active time', () => {
  it('shows words per hour only after a minute of writing', () => {
    expect(wordsPerHour(100, 59_999)).toBeNull()
    expect(wordsPerHour(500, 30 * 60_000)).toBe(1000)
    expect(wordsPerHour(-50, 30 * 60_000)).toBe(0)
  })

  it('adds the gap since the previous save, capped', () => {
    expect(addActiveTime(null, 10_000)).toBe(0)
    expect(addActiveTime(10_000, 40_000)).toBe(30_000)
    expect(addActiveTime(0, ACTIVE_GAP_MS * 3)).toBe(ACTIVE_GAP_MS)
    expect(addActiveTime(50_000, 40_000)).toBe(0)
  })

  it('clamps progress to 0..1', () => {
    expect(progressRatio(50, 100)).toBe(0.5)
    expect(progressRatio(150, 100)).toBe(1)
    expect(progressRatio(-5, 100)).toBe(0)
    expect(progressRatio(50, null)).toBe(0)
  })
})

describe('parseGoalTarget / goalTargetError', () => {
  it('reads digits with thousands separators', () => {
    expect(parseGoalTarget('2000')).toBe(2000)
    expect(parseGoalTarget(' 80,000 ')).toBe(80_000)
    expect(parseGoalTarget('1 500')).toBe(1500)
  })

  it('refuses zero, fractions as typed, words, and numbers past the cap', () => {
    expect(parseGoalTarget('0')).toBeNull()
    expect(parseGoalTarget('-5')).toBeNull()
    expect(parseGoalTarget('2.5')).toBeNull()
    expect(parseGoalTarget('lots')).toBeNull()
    expect(parseGoalTarget('')).toBeNull()
    expect(parseGoalTarget(String(GOAL_TARGET_MAX + 1))).toBeNull()
  })

  it('lets an optional field stay empty', () => {
    expect(goalTargetError('', true)).toBeNull()
    expect(goalTargetError('')).toMatch(/whole number/)
    expect(goalTargetError('500')).toBeNull()
  })
})
