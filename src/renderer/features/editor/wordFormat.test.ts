import { describe, expect, it } from 'vitest'
import { formatCompactWords } from './wordFormat'

describe('formatCompactWords', () => {
  it('shortens a count for a tree row (F-10.3)', () => {
    expect(formatCompactWords(950)).toBe('950')
    expect(formatCompactWords(1000)).toBe('1k')
    expect(formatCompactWords(1234)).toBe('1.2k')
    expect(formatCompactWords(12_345)).toBe('12k')
    expect(formatCompactWords(1_500_000)).toBe('1.5M')
    expect(formatCompactWords(-2500)).toBe('−2.5k')
  })
})
