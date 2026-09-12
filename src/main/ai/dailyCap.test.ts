import { describe, expect, it } from 'vitest'
import {
  AiUsageState,
  dayOf,
  defaultAiUsageState,
  rollIfNewDay,
  spend,
  wouldExceed
} from './dailyCap'

const spent: AiUsageState = {
  dailyCapUsd: 2,
  spentDate: '2026-09-12',
  spentTodayUsd: 1.5,
  requestsToday: 3,
  tokensToday: 900
}

describe('dailyCap (F-5.14)', () => {
  it('defaults to a 2.00 USD cap with no tally, and parses an older file to the same', () => {
    expect(defaultAiUsageState()).toEqual({
      dailyCapUsd: 2,
      spentDate: null,
      spentTodayUsd: 0,
      requestsToday: 0,
      tokensToday: 0
    })
    expect(AiUsageState.parse({})).toEqual(defaultAiUsageState())
    expect(AiUsageState.safeParse({ dailyCapUsd: 501 }).success).toBe(false)
    expect(AiUsageState.safeParse({ spentTodayUsd: -1 }).success).toBe(false)
  })

  it('names the local calendar day, zero-padded', () => {
    expect(dayOf(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(dayOf(new Date(2026, 11, 25, 0, 0))).toBe('2026-12-25')
  })

  it('keeps the tally on the same day and resets it on a new one, keeping the cap', () => {
    expect(rollIfNewDay(spent, '2026-09-12')).toBe(spent)
    expect(rollIfNewDay(spent, '2026-09-13')).toEqual({
      dailyCapUsd: 2,
      spentDate: '2026-09-13',
      spentTodayUsd: 0,
      requestsToday: 0,
      tokensToday: 0
    })
    expect(rollIfNewDay(defaultAiUsageState(), '2026-09-13').spentDate).toBe('2026-09-13')
  })

  it('accumulates cost, requests, and tokens within the day', () => {
    expect(spend(spent, { costUsd: 0.25, tokens: 100 }, '2026-09-12')).toEqual({
      ...spent,
      spentTodayUsd: 1.75,
      requestsToday: 4,
      tokensToday: 1000
    })
  })

  it('starts a fresh tally when the first spend of a new day lands', () => {
    expect(spend(spent, { costUsd: 0.25, tokens: 100 }, '2026-09-13')).toEqual({
      dailyCapUsd: 2,
      spentDate: '2026-09-13',
      spentTodayUsd: 0.25,
      requestsToday: 1,
      tokensToday: 100
    })
  })

  it('allows reaching the cap exactly and refuses going over it', () => {
    expect(wouldExceed(spent, 0.5, '2026-09-12')).toBe(false)
    expect(wouldExceed(spent, 0.51, '2026-09-12')).toBe(true)
    expect(wouldExceed(spent, 0.51, '2026-09-13')).toBe(false)
  })

  it('a cap of 0 refuses any positive spend but allows a free one', () => {
    const paused = { ...defaultAiUsageState(), dailyCapUsd: 0 }
    expect(wouldExceed(paused, 0.000001, '2026-09-12')).toBe(true)
    expect(wouldExceed(paused, 0, '2026-09-12')).toBe(false)
  })
})
