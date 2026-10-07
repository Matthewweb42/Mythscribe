import { describe, expect, it } from 'vitest'
import { creditWarningText, runOutText, wordsLeftText } from './creditMeter'

describe('creditWarningText (F-15.5)', () => {
  it('says what is wrong, and names the balance only when it is the reason', () => {
    expect(creditWarningText('empty', { balanceMicros: -40, daysLeft: 0 })).toBe(
      'MythScribe Cloud balance used up'
    )
    expect(creditWarningText('low', { balanceMicros: 420_000, daysLeft: 9 })).toBe(
      'MythScribe Cloud balance low: $0.42'
    )
    expect(creditWarningText('runOut', { balanceMicros: 5_000_000, daysLeft: 2 })).toBe(
      'MythScribe Cloud balance: about 2 days left'
    )
  })

  it('keeps the day singular', () => {
    expect(creditWarningText('runOut', { balanceMicros: 5_000_000, daysLeft: 1 })).toBe(
      'MythScribe Cloud balance: about 1 day left'
    )
  })
})

describe('wordsLeftText (AI-BILLING-SPEC E2)', () => {
  it('names the words, or hides the line while the constant is unmeasured', () => {
    expect(wordsLeftText(140_000, 'line editing')).toBe('About 140,000 words of line editing left')
    expect(wordsLeftText(null, 'line editing')).toBeNull()
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
