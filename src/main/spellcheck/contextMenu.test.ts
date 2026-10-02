import { describe, expect, it } from 'vitest'
import { MAX_SPELL_SUGGESTIONS } from '@shared/dictionary'
import { spellMenuPayload } from './contextMenu'

describe('spellMenuPayload (F-3.11)', () => {
  it('answers the word and its suggestions for a misspelled word in an editable', () => {
    expect(
      spellMenuPayload({
        misspelledWord: 'recieve',
        dictionarySuggestions: ['receive', 'relieve'],
        isEditable: true
      })
    ).toEqual({ word: 'recieve', suggestions: ['receive', 'relieve'] })
  })

  it('keeps a word with no suggestions, so it can still be added to the dictionary', () => {
    expect(
      spellMenuPayload({ misspelledWord: 'Zorvath', dictionarySuggestions: [], isEditable: true })
    ).toEqual({ word: 'Zorvath', suggestions: [] })
  })

  it('caps the suggestions', () => {
    const many = Array.from({ length: MAX_SPELL_SUGGESTIONS + 4 }, (_, i) => `word${i}`)
    const payload = spellMenuPayload({
      misspelledWord: 'wrd',
      dictionarySuggestions: many,
      isEditable: true
    })
    expect(payload?.suggestions).toEqual(many.slice(0, MAX_SPELL_SUGGESTIONS))
  })

  it('answers nothing when the click was not on a misspelled word', () => {
    expect(
      spellMenuPayload({ misspelledWord: '', dictionarySuggestions: [], isEditable: true })
    ).toBeNull()
  })

  it('answers nothing outside an editable', () => {
    expect(
      spellMenuPayload({
        misspelledWord: 'recieve',
        dictionarySuggestions: ['receive'],
        isEditable: false
      })
    ).toBeNull()
  })
})
