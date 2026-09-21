import { describe, expect, it } from 'vitest'
import { creditWarningText, runOutText } from './creditMeter'

describe('creditWarningText (F-15.5)', () => {
  it('says what is wrong, and names the balance only when it is the reason', () => {
    expect(creditWarningText('empty', { balanceMicros: -40, daysLeft: 0 })).toBe(
      'Cloud credits used up'
    )
    expect(creditWarningText('low', { balanceMicros: 420_000, daysLeft: 9 })).toBe(
      'Cloud credits low: $0.42'
    )
    expect(creditWarningText('runOut', { balanceMicros: 5_000_000, daysLeft: 2 })).toBe(
      'Cloud credits: about 2 days left'
    )
  })

  it('keeps the day singular', () => {
    expect(creditWarningText('runOut', { balanceMicros: 5_000_000, daysLeft: 1 })).toBe(
      'Cloud credits: about 1 day left'
    )
  })
})

describe('runOutText (F-15.5)', () => {
  it('projects, or says why it cannot', () => {
    expect(runOutText(12)).toBe('About 12 days left at this pace')
    expect(runOutText(1)).toBe('About 1 day left at this pace')
    expect(runOutText(null)).toBe('Not enough usage to project yet')
    expect(runOutText(0)).toBe('Used up')
  })
})
