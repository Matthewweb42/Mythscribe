import { describe, expect, it } from 'vitest'
import { formatActiveTime, formatDays } from './goalFormat'

describe('goalFormat (F-10.3)', () => {
  it('formats active time in minutes, then hours and minutes', () => {
    expect(formatActiveTime(0)).toBe('under a minute')
    expect(formatActiveTime(59_999)).toBe('under a minute')
    expect(formatActiveTime(12 * 60_000 + 30_000)).toBe('12 min')
    expect(formatActiveTime(65 * 60_000)).toBe('1 h 05 min')
  })

  it('formats a day count', () => {
    expect(formatDays(1)).toBe('1 day')
    expect(formatDays(12)).toBe('12 days')
  })
})
