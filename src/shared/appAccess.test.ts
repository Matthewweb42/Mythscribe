import { describe, expect, it } from 'vitest'
import {
  APP_TRIAL_DAYS,
  appAccessFor,
  canWrite,
  extrasUnlocked,
  touchTrial,
  trialDaysText,
  trialEndsAt
} from './appAccess'

const at = (y: number, m: number, d: number, h = 0): number => new Date(y, m - 1, d, h).getTime()

describe('the trial clock (AI-BILLING-SPEC M1)', () => {
  it('ends at local midnight thirty calendar days after the day it started', () => {
    expect(APP_TRIAL_DAYS).toBe(30)
    expect(trialEndsAt(at(2026, 3, 1, 15))).toBe(at(2026, 3, 31))
    expect(trialEndsAt(at(2026, 3, 1, 0))).toBe(at(2026, 3, 31))
  })

  it('starts on the first touch and only ever moves lastSeenAt forward', () => {
    const started = touchTrial(null, 1000)
    expect(started).toEqual({ startedAt: 1000, lastSeenAt: 1000 })
    expect(touchTrial(started, 5000)).toEqual({ startedAt: 1000, lastSeenAt: 5000 })
    expect(touchTrial({ startedAt: 1000, lastSeenAt: 5000 }, 2000)).toEqual({
      startedAt: 1000,
      lastSeenAt: 5000
    })
  })

  it('counts calendar days left, today included, and expires as the last day ends', () => {
    const trial = { startedAt: at(2026, 3, 1, 15), lastSeenAt: at(2026, 3, 1, 15) }
    expect(appAccessFor(trial, false, at(2026, 3, 1, 15))).toEqual({
      state: 'trial',
      trialEndsAt: new Date(at(2026, 3, 31)).toISOString(),
      daysLeft: 30
    })
    expect(appAccessFor(trial, false, at(2026, 3, 30, 23)).daysLeft).toBe(1)
    expect(appAccessFor(trial, false, at(2026, 3, 31))).toMatchObject({
      state: 'expired',
      daysLeft: 0
    })
  })

  it('does not give days back when the system clock is turned back', () => {
    const trial = { startedAt: at(2026, 3, 1), lastSeenAt: at(2026, 4, 2) }
    expect(appAccessFor(trial, false, at(2026, 3, 5)).state).toBe('expired')
  })

  it('lets a license win over an ended trial', () => {
    const trial = { startedAt: at(2026, 1, 1), lastSeenAt: at(2026, 1, 1) }
    expect(appAccessFor(trial, true, at(2026, 6, 1)).state).toBe('licensed')
  })

  it('reads as writable until the state is known, and words the days left', () => {
    expect(canWrite(null)).toBe(true)
    expect(canWrite({ state: 'expired', trialEndsAt: '', daysLeft: 0 })).toBe(false)
    expect(canWrite({ state: 'licensed', trialEndsAt: '', daysLeft: 0 })).toBe(true)
    expect(trialDaysText(1)).toBe('1 day left in your trial')
    expect(trialDaysText(12)).toBe('12 days left in your trial')
  })

  it('unlocks the extras during the trial and with the license, never after it ends unpaid', () => {
    expect(extrasUnlocked({ state: 'trial', trialEndsAt: '', daysLeft: 12 })).toBe(true)
    expect(extrasUnlocked({ state: 'licensed', trialEndsAt: '', daysLeft: 0 })).toBe(true)
    expect(extrasUnlocked({ state: 'expired', trialEndsAt: '', daysLeft: 0 })).toBe(false)
    // Unknown counts as locked, unlike `canWrite`.
    expect(extrasUnlocked(null)).toBe(false)
  })
})
