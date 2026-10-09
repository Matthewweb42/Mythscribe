import { describe, expect, it } from 'vitest'
import { classifyTagTerm, mayAutoCreateTag, termUses } from './tagTerms'

/** Two scenes in the voice of a real manuscript: names, a coined phrase, ordinary words. */
const SCENES = [
  'Marta found the memorial fragments where the river bent. The custom in Greywater was to ' +
    'leave them be, but Marta had never cared for custom. She wrapped the memorial fragments ' +
    'in oilcloth and walked home before the Tide Reckoning.',
  'At the Tide Reckoning the whole town came down to the shore. Marta laid the memorial ' +
    'fragments on the stones. Her trial would come later; tonight the memorial fragments spoke ' +
    'first. Old Reed watched from the wall, and the lantern guttered.',
  '"You know the Trial is coming," said Reed. They had talked of the Trial all winter, of the ' +
    'Trial and its price, and Marta had stopped listening. The Trial took one of them every year.'
]

describe('classifyTagTerm (the author’s tag rule, 2026-10-08)', () => {
  it('reads a name the text always capitalises as a name, wherever it stands', () => {
    expect(classifyTagTerm('marta', SCENES)).toBe('name')
    expect(classifyTagTerm('greywater', SCENES)).toBe('name')
    // "the" is a linking word: the name is the Tide Reckoning, capitalised every time.
    expect(classifyTagTerm('the-tide-reckoning', SCENES)).toBe('name')
    expect(classifyTagTerm('tide-reckoning', SCENES)).toBe('name')
  })

  it('reads a phrase of ordinary words the text keeps repeating as a coined term', () => {
    expect(termUses('memorial-fragments', SCENES)).toEqual({ mid: 0, start: 0, lower: 4 })
    expect(
      classifyTagTerm('memorial-fragments', [...SCENES, 'The memorial fragments hummed.'])
    ).toBe('term')
    expect(classifyTagTerm('memorial-fragments', SCENES)).toBe('term')
  })

  it('reads ordinary words used normally as ordinary, whatever the model called them', () => {
    expect(classifyTagTerm('custom', SCENES)).toBe('ordinary')
    expect(classifyTagTerm('lantern', SCENES)).toBe('ordinary')
    // "the river" once is not a coined term.
    expect(classifyTagTerm('the-river', SCENES)).toBe('ordinary')
  })

  it('reads an ordinary word capitalised mid-sentence again and again as unusual, not a name', () => {
    expect(termUses('trial', SCENES)).toEqual({ mid: 4, start: 0, lower: 1 })
    expect(classifyTagTerm('trial', SCENES)).toBe('unusual')
    // Without the lower-case "trial", the Trial is simply a name of the story.
    expect(classifyTagTerm('trial', [SCENES[2] ?? ''])).toBe('name')
  })

  it('says absent for a term the text never holds, and keeps the stoplist out of names', () => {
    expect(classifyTagTerm('loneliness', SCENES)).toBe('absent')
    expect(classifyTagTerm('the', SCENES)).toBe('ordinary')
    expect(classifyTagTerm('tuesday', ['They met on Tuesday, and again on Tuesday.'])).toBe(
      'ordinary'
    )
  })

  it('matches a name joined by an apostrophe or a hyphen, and a possessive', () => {
    expect(
      classifyTagTerm('o-rourke', ['They waited for O’Rourke. O’Rourke’s boat was late.'])
    ).toBe('name')
    expect(classifyTagTerm('reed', SCENES)).toBe('name')
  })

  it('lets background tagging create only names and coined terms', () => {
    expect(mayAutoCreateTag('name')).toBe(true)
    expect(mayAutoCreateTag('term')).toBe(true)
    expect(mayAutoCreateTag('unusual')).toBe(false)
    expect(mayAutoCreateTag('ordinary')).toBe(false)
    expect(mayAutoCreateTag('absent')).toBe(false)
  })
})
