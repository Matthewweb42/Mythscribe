import { describe, expect, it } from 'vitest'
import { cardFlashback, isFlashback, sceneFlashback } from './flashback'

/**
 * The one flashback resolver (F-16.11, F-16.23; the author's decision 2026-10-14): the author's
 * switch wins over the card in both directions; unset, a checked card counts and an unchecked one
 * counts for nothing; else not a flashback.
 */

const yes = { value: 'yes', verified: true }
const no = { value: 'no', verified: true }
const guessed = { value: 'yes', verified: false }

describe('sceneFlashback', () => {
  it('takes the author’s switch over the card, both ways', () => {
    expect(sceneFlashback(true, no)).toEqual({ flashback: true, source: 'typed' })
    expect(sceneFlashback(true, null)).toEqual({ flashback: true, source: 'typed' })
    expect(sceneFlashback(false, yes)).toEqual({ flashback: false, source: 'typed' })
    expect(sceneFlashback(false, undefined)).toEqual({ flashback: false, source: 'typed' })
  })

  it('follows a checked card when the switch is unset', () => {
    expect(sceneFlashback(null, yes)).toEqual({ flashback: true, source: 'card' })
    expect(sceneFlashback(null, no)).toEqual({ flashback: false, source: 'card' })
  })

  it('ignores an unchecked card, as before the switch', () => {
    expect(sceneFlashback(null, guessed)).toEqual({ flashback: false, source: 'none' })
    expect(sceneFlashback(null, null)).toEqual({ flashback: false, source: 'none' })
    expect(sceneFlashback(null, undefined)).toEqual({ flashback: false, source: 'none' })
  })

  it('answers the flag alone through isFlashback', () => {
    expect(isFlashback(null, yes)).toBe(true)
    expect(isFlashback(false, yes)).toBe(false)
    expect(isFlashback(true, guessed)).toBe(true)
  })
})

describe('cardFlashback', () => {
  it('reads only a checked field: yes, no, or nothing', () => {
    expect(cardFlashback(yes)).toBe(true)
    expect(cardFlashback(no)).toBe(false)
    expect(cardFlashback(guessed)).toBeNull()
    expect(cardFlashback(null)).toBeNull()
  })
})
