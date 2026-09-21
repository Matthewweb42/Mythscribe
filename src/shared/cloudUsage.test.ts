import { describe, expect, it } from 'vitest'
import {
  creditWarning,
  LOW_BALANCE_MICROS,
  periodSpentMicros,
  projectedDaysLeft,
  RUN_OUT_WARNING_DAYS,
  USAGE_PERIOD_DAYS
} from './cloudUsage'

const DAY_MS = 24 * 60 * 60_000
const NOW = Date.UTC(2026, 8, 20)

describe('periodSpentMicros', () => {
  it('sums the rows and is zero for none', () => {
    expect(periodSpentMicros([{ micros: 1_200 }, { micros: 300 }])).toBe(1_500)
    expect(periodSpentMicros([])).toBe(0)
  })
})

describe('projectedDaysLeft', () => {
  it('divides the balance by the pace since the first charge in the period', () => {
    // 3.00 USD over 3 days is 1.00 a day; 10.00 lasts 10 days.
    const days = projectedDaysLeft({
      balanceMicros: 10_000_000,
      spentMicros: 3_000_000,
      firstChargeAt: NOW - 3 * DAY_MS,
      now: NOW
    })
    expect(days).toBe(10)
  })

  it('counts a first charge made today as one day, not zero', () => {
    const days = projectedDaysLeft({
      balanceMicros: 4_000_000,
      spentMicros: 2_000_000,
      firstChargeAt: NOW - 60_000,
      now: NOW
    })
    expect(days).toBe(2)
  })

  it('never averages over more than the period', () => {
    const days = projectedDaysLeft({
      balanceMicros: 1_000_000,
      spentMicros: USAGE_PERIOD_DAYS * 100_000,
      firstChargeAt: NOW - 90 * DAY_MS,
      now: NOW
    })
    expect(days).toBe(10)
  })

  it('floors to whole days', () => {
    const days = projectedDaysLeft({
      balanceMicros: 2_500_000,
      spentMicros: 1_000_000,
      firstChargeAt: NOW - DAY_MS,
      now: NOW
    })
    expect(days).toBe(2)
  })

  it('is null with nothing to project from', () => {
    const base = { balanceMicros: 5_000_000, now: NOW }
    expect(projectedDaysLeft({ ...base, spentMicros: 0, firstChargeAt: null })).toBeNull()
    expect(projectedDaysLeft({ ...base, spentMicros: 500, firstChargeAt: null })).toBeNull()
  })

  it('is zero once the balance is used up, even with no spend in the period', () => {
    const base = { spentMicros: 0, firstChargeAt: null, now: NOW }
    expect(projectedDaysLeft({ ...base, balanceMicros: 0 })).toBe(0)
    expect(projectedDaysLeft({ ...base, balanceMicros: -40 })).toBe(0)
  })
})

describe('creditWarning', () => {
  it('reports the most urgent warning first', () => {
    expect(creditWarning({ balanceMicros: 0, daysLeft: 0 })).toBe('empty')
    expect(creditWarning({ balanceMicros: -5, daysLeft: null })).toBe('empty')
    expect(creditWarning({ balanceMicros: LOW_BALANCE_MICROS - 1, daysLeft: 1 })).toBe('low')
    expect(
      creditWarning({ balanceMicros: LOW_BALANCE_MICROS, daysLeft: RUN_OUT_WARNING_DAYS })
    ).toBe('runOut')
  })

  it('is null while the balance is comfortable', () => {
    expect(
      creditWarning({ balanceMicros: LOW_BALANCE_MICROS, daysLeft: RUN_OUT_WARNING_DAYS + 1 })
    ).toBeNull()
    expect(creditWarning({ balanceMicros: 5_000_000, daysLeft: null })).toBeNull()
  })
})
