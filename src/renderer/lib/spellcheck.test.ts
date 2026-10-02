import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isWordMisspelled, setSpellChecker } from './spellcheck'

beforeEach(() => {
  setSpellChecker(null)
})
afterEach(() => {
  setSpellChecker(null)
})

describe('isWordMisspelled (F-3.14)', () => {
  it('is false while there is no bridge to ask', () => {
    expect(isWordMisspelled('Marra')).toBe(false)
  })

  it('answers what the replaced checker answers', () => {
    setSpellChecker((word) => word === 'Marra')
    expect(isWordMisspelled('Marra')).toBe(true)
    expect(isWordMisspelled('Mara')).toBe(false)
  })

  it('is false when the checker throws', () => {
    setSpellChecker(() => {
      throw new Error('no dictionary')
    })
    expect(isWordMisspelled('Marra')).toBe(false)
  })
})
