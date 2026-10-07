import { describe, expect, it } from 'vitest'
import { shouldTrigger, throttleReason, type ThrottleInput } from './aiThrottle'

const ready: ThrottleInput = {
  idleMs: 1_000,
  minIdleMs: 1_000,
  newChars: 12,
  minNewChars: 12,
  pending: false,
  visible: false,
  requestsToday: 0,
  dailyRequestCap: 200
}

describe('shouldTrigger (F-5.14)', () => {
  it('fires when every gate is at its threshold', () => {
    expect(shouldTrigger(ready)).toBe(true)
  })

  it('waits for the minimum idle interval', () => {
    expect(shouldTrigger({ ...ready, idleMs: 999 })).toBe(false)
    expect(shouldTrigger({ ...ready, idleMs: 5_000 })).toBe(true)
  })

  it('waits for enough new characters since the last request', () => {
    expect(shouldTrigger({ ...ready, newChars: 11 })).toBe(false)
    expect(shouldTrigger({ ...ready, newChars: 0 })).toBe(false)
  })

  it('never fires while a request is pending', () => {
    expect(shouldTrigger({ ...ready, pending: true })).toBe(false)
  })

  it('never fires while a proposal is visible', () => {
    expect(shouldTrigger({ ...ready, visible: true })).toBe(false)
  })

  it('stops at the per-day request cap', () => {
    expect(shouldTrigger({ ...ready, requestsToday: 199 })).toBe(true)
    expect(shouldTrigger({ ...ready, requestsToday: 200 })).toBe(false)
    expect(shouldTrigger({ ...ready, dailyRequestCap: 0 })).toBe(false)
  })
})

describe('throttleReason (developer tools)', () => {
  it('names the first gate that says no, in the order shouldTrigger asks', () => {
    expect(throttleReason(ready)).toBeNull()
    expect(throttleReason({ ...ready, pending: true, visible: true })).toBe('pending')
    expect(throttleReason({ ...ready, visible: true, idleMs: 0 })).toBe('visible')
    expect(throttleReason({ ...ready, idleMs: 999, newChars: 0 })).toBe('idle')
    expect(throttleReason({ ...ready, newChars: 11 })).toBe('newChars')
    expect(throttleReason({ ...ready, requestsToday: 200 })).toBe('dailyCap')
  })
})
