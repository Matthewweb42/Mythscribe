import { describe, expect, it } from 'vitest'
import {
  DICTIONARY_WORD_MAX,
  DictionaryWord,
  ProjectDictionary,
  addWord,
  defaultProjectDictionary,
  removeWord
} from './dictionary'

describe('DictionaryWord (F-3.11)', () => {
  it('trims the word and accepts letters, apostrophes, and hyphens', () => {
    expect(DictionaryWord.parse('  Zorvath ')).toBe('Zorvath')
    expect(DictionaryWord.parse("K'thar-el")).toBe("K'thar-el")
  })

  it('refuses an empty word, a phrase, and a word over the cap', () => {
    expect(DictionaryWord.safeParse('   ').success).toBe(false)
    expect(DictionaryWord.safeParse('salt marsh').success).toBe(false)
    expect(DictionaryWord.safeParse('a'.repeat(DICTIONARY_WORD_MAX)).success).toBe(true)
    expect(DictionaryWord.safeParse('a'.repeat(DICTIONARY_WORD_MAX + 1)).success).toBe(false)
  })
})

describe('ProjectDictionary (F-3.11)', () => {
  it('defaults to no words', () => {
    expect(ProjectDictionary.parse({})).toEqual(defaultProjectDictionary())
    expect(defaultProjectDictionary()).toEqual({ words: [] })
  })
})

describe('addWord / removeWord (F-3.11)', () => {
  it('adds a word and keeps the list sorted', () => {
    const dict = addWord(addWord(addWord(defaultProjectDictionary(), 'Zorvath'), 'Mara'), 'Tash')
    expect(dict.words).toEqual(['Mara', 'Tash', 'Zorvath'])
  })

  it('is case-sensitive and keeps each spelling once', () => {
    const once = addWord(defaultProjectDictionary(), 'Mara')
    expect(addWord(once, 'Mara')).toBe(once)
    expect(addWord(once, 'mara').words).toHaveLength(2)
  })

  it('removes a word, and answers the same object when it was not there', () => {
    const dict = { words: ['Mara', 'Tash'] }
    expect(removeWord(dict, 'Mara')).toEqual({ words: ['Tash'] })
    expect(removeWord(dict, 'mara')).toBe(dict)
  })

  it('never changes the dictionary it was given', () => {
    const dict = { words: ['Tash'] }
    addWord(dict, 'Mara')
    removeWord(dict, 'Tash')
    expect(dict).toEqual({ words: ['Tash'] })
  })
})
