import { defaultGoals, type GoalsStatus } from '@shared/goals'

/** A `GoalsStatus` with nothing set and nothing written, for tests; `overrides` replace whole fields. */
export function goalsStatusFixture(overrides: Partial<GoalsStatus> = {}): GoalsStatus {
  return {
    goals: defaultGoals(),
    manuscriptWords: 0,
    today: { day: '2026-10-04', words: 0 },
    streak: { current: 0, best: 0 },
    daysLeft: null,
    perDayNeeded: null,
    session: { words: 0, activeMs: 0 },
    ...overrides
  }
}
