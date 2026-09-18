import { describe, expect, it } from 'vitest'
import { createSessionUsage } from './sessionUsage'

describe('sessionUsage (F-5.9)', () => {
  it('starts at zero', () => {
    expect(createSessionUsage().totals()).toEqual({ requests: 0, tokens: 0, costUsd: 0 })
  })

  it('sums cost and tokens and counts every spend as one request', () => {
    const session = createSessionUsage()
    session.spend({ costUsd: 0.0012, tokens: 300 })
    session.spend({ costUsd: 0.0008, tokens: 120 })
    // A cache hit: a free request, exactly as the daily tally counts it.
    session.spend({ costUsd: 0, tokens: 0 })
    const totals = session.totals()
    expect(totals).toMatchObject({ requests: 3, tokens: 420 })
    expect(totals.costUsd).toBeCloseTo(0.002, 8)
  })

  it('keeps each session separate', () => {
    const a = createSessionUsage()
    const b = createSessionUsage()
    a.spend({ costUsd: 0.5, tokens: 10 })
    expect(b.totals()).toEqual({ requests: 0, tokens: 0, costUsd: 0 })
  })
})
