import { describe, expect, it } from 'vitest'
import {
  MemoryCloudState,
  addCloudSpend,
  allowMore,
  capNoticeDue,
  capReached,
  cloudCapState,
  defaultMemoryCloudState,
  markCapNotice,
  monthOf,
  reconcileTally,
  rollIfNewMonth,
  setCap
} from './cloudTally'

const OCT = '2026-10'
const NOW = new Date(2026, 9, 12, 12, 0, 0)

const spent = (background: number, asked = 0): MemoryCloudState => ({
  ...defaultMemoryCloudState(),
  month: OCT,
  backgroundUsd: background,
  askedUsd: asked
})

describe('the Cloud monthly tally (F-16.19, P2a §3.6)', () => {
  it('defaults to a $1 cap with nothing spent, read leniently from an older file', () => {
    expect(MemoryCloudState.parse({})).toEqual(defaultMemoryCloudState())
    expect(defaultMemoryCloudState().capUsd).toBe(1)
    expect(MemoryCloudState.safeParse({ capUsd: 0.3 }).success).toBe(false)
    expect(MemoryCloudState.safeParse({ backgroundUsd: -1 }).success).toBe(false)
    expect(monthOf(NOW)).toBe(OCT)
  })

  it('rolls on a new local month and keeps the cap', () => {
    const october = { ...spent(0.8, 0.2), extraUsd: 1, capUsd: 2 }
    expect(rollIfNewMonth(october, OCT)).toBe(october)
    expect(rollIfNewMonth(october, '2026-11')).toEqual({
      ...october,
      month: '2026-11',
      backgroundUsd: 0,
      askedUsd: 0,
      extraUsd: 0
    })
  })

  it('adds background and asked spend apart; only background counts against the cap', () => {
    let state = defaultMemoryCloudState()
    state = addCloudSpend(state, { usd: 0.6, asked: false }, OCT)
    state = addCloudSpend(state, { usd: 5, asked: true }, OCT)
    expect(state).toMatchObject({ month: OCT, backgroundUsd: 0.6, askedUsd: 5 })
    expect(capReached(state, OCT)).toBe(false)
    state = addCloudSpend(state, { usd: 0.4, asked: false }, OCT)
    expect(capReached(state, OCT)).toBe(true)
    // A new month starts below the cap again.
    expect(capReached(state, '2026-11')).toBe(false)
  })

  it('allows another $1 this month, and changes the cap in quarter steps', () => {
    let state = spent(1)
    expect(capReached(state, OCT)).toBe(true)
    state = allowMore(state, OCT)
    expect(capReached(state, OCT)).toBe(false)
    expect(cloudCapState(state, OCT)).toMatchObject({ limitUsd: 2, extraUsd: 1, reached: false })
    state = setCap(state, 0.25, OCT)
    expect(cloudCapState(state, OCT)).toMatchObject({ capUsd: 0.25, limitUsd: 1.25, reached: false })
    expect(() => setCap(state, 0.3, OCT)).toThrow()
    // The extra lasts one month.
    expect(cloudCapState(state, '2026-11')).toMatchObject({ extraUsd: 0, limitUsd: 0.25 })
  })

  it('raises the notice once a month', () => {
    let state = spent(1)
    expect(capNoticeDue(state, OCT)).toBe(true)
    state = markCapNotice(state, OCT)
    expect(capNoticeDue(state, OCT)).toBe(false)
    expect(capNoticeDue(state, '2026-11')).toBe(true)
  })

  it('reconciles upward with /credits, never down, and only on a period inside this month', () => {
    const credits = (readerMicros: number, firstAt: Date | null) => ({
      periodSpend: [
        { feature: 'reader', micros: readerMicros, requests: 10, tokens: 1 },
        { feature: 'verify', micros: 100_000, requests: 5, tokens: 1 },
        { feature: 'chat', micros: 9_000_000, requests: 1, tokens: 1 }
      ],
      periodFirstChargeAt: firstAt === null ? null : firstAt.getTime()
    })
    const inOctober = new Date(2026, 9, 2, 9, 0, 0)
    // Server: 0.5 + 0.1 = 0.6 of reading, 0.2 of it asked here: background 0.4 > 0.1.
    expect(reconcileTally(spent(0.1, 0.2), credits(500_000, inOctober), NOW).backgroundUsd).toBeCloseTo(
      0.4
    )
    // Never lowered.
    expect(reconcileTally(spent(0.9, 0.2), credits(500_000, inOctober), NOW).backgroundUsd).toBe(0.9)
    // A period reaching into September says nothing about October alone.
    const inSeptember = new Date(2026, 8, 20, 9, 0, 0)
    expect(reconcileTally(spent(0.1), credits(900_000, inSeptember), NOW).backgroundUsd).toBe(0.1)
    expect(reconcileTally(spent(0.1), credits(900_000, null), NOW).backgroundUsd).toBe(0.1)
  })
})
