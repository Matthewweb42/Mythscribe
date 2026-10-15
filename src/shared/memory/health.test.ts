import { describe, expect, it } from 'vitest'
import { modelHealth, probeDue, type HealthReading } from './health'

const good: HealthReading = { items: 4, quotesFound: 4, verifySent: 2, verified: 2 }

describe('modelHealth (F-16.17, P2a-D16)', () => {
  it('does not judge a model before 10 readings with 30 items', () => {
    const few = Array.from({ length: 9 }, () => ({ ...good, quotesFound: 0 }))
    expect(modelHealth(few)).toMatchObject({ judged: false, paused: false, reason: null })
    const thin = Array.from({ length: 12 }, () => ({
      items: 2,
      quotesFound: 0,
      verifySent: 0,
      verified: 0
    }))
    expect(modelHealth(thin)).toMatchObject({ judged: false, items: 24 })
  })

  it('pauses below 90 % of quotes found or 80 % verified', () => {
    const healthy = Array.from({ length: 10 }, () => good)
    expect(modelHealth(healthy)).toMatchObject({
      judged: true,
      paused: false,
      quotes: 1,
      verified: 1
    })
    const misses = Array.from({ length: 10 }, () => ({ ...good, quotesFound: 3 }))
    expect(modelHealth(misses)).toMatchObject({ paused: true, reason: 'quotes', quotes: 0.75 })
    const rejects = Array.from({ length: 10 }, () => ({ ...good, verifySent: 4, verified: 3 }))
    expect(modelHealth(rejects)).toMatchObject({ paused: true, reason: 'verified', verified: 0.75 })
  })

  it('leaves the items refused for a slot no longer read out of the quotes (plan ReaderNarrow.md)', () => {
    // 6 proposed, 2 of them traits refused before their quotes were looked for: 4 of 4 found.
    const narrowed = Array.from({ length: 10 }, () => ({
      ...good,
      items: 6,
      rejections: { notRead: 2 }
    }))
    expect(modelHealth(narrowed)).toMatchObject({ paused: false, quotes: 1, items: 40 })
    // A quote really missing still counts against it.
    const missing = narrowed.map((each) => ({ ...each, quotesFound: 3 }))
    expect(modelHealth(missing)).toMatchObject({ paused: true, reason: 'quotes', quotes: 0.75 })
  })

  it('reads only the newest 20 readings', () => {
    const recent = Array.from({ length: 20 }, () => good)
    const old = Array.from({ length: 20 }, () => ({ ...good, quotesFound: 0 }))
    expect(modelHealth([...recent, ...old])).toMatchObject({ readings: 20, paused: false })
  })

  it('probes the tenth due scene while paused', () => {
    expect(probeDue(0)).toBe(false)
    expect(probeDue(8)).toBe(false)
    expect(probeDue(9)).toBe(true)
  })
})
