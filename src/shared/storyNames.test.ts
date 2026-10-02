import { describe, expect, it } from 'vitest'
import { buildNameIndex, editDistance, nearName, storyNameWords, wordsIn } from './storyNames'

describe('wordsIn', () => {
  it('finds each word with its range and leaves the possessive ending out', () => {
    expect(wordsIn("Mara's sword, the Vosses’ K'rath")).toEqual([
      { from: 0, to: 4, word: 'Mara' },
      { from: 7, to: 12, word: 'sword' },
      { from: 14, to: 17, word: 'the' },
      { from: 18, to: 24, word: 'Vosses' },
      { from: 26, to: 32, word: "K'rath" }
    ])
  })

  it('splits on hyphens and digits and finds nothing in a text without letters', () => {
    expect(wordsIn('rose-marsh 42').map((w) => w.word)).toEqual(['rose', 'marsh'])
    expect(wordsIn('… 1984 —')).toEqual([])
  })
})

describe('storyNameWords', () => {
  it('gives the words of entity and tag names, unique and sorted, as spelled', () => {
    expect(storyNameWords(['Mara Voss', 'rose-marsh', 'mara-voss', 'Voss'])).toEqual([
      'mara',
      'Mara',
      'marsh',
      'rose',
      'voss',
      'Voss'
    ])
  })

  it('leaves out single letters and words longer than a dictionary word', () => {
    expect(storyNameWords(['A Zorvath', 'x'.repeat(65), '???'])).toEqual(['Zorvath'])
  })
})

describe('editDistance', () => {
  it('counts inserts, deletes, substitutions, and swaps as one each', () => {
    expect(editDistance('mara', 'mara', 2)).toBe(0)
    expect(editDistance('marra', 'mara', 2)).toBe(1)
    expect(editDistance('mra', 'mara', 2)).toBe(1)
    expect(editDistance('mata', 'mara', 2)).toBe(1)
    expect(editDistance('maar', 'mara', 2)).toBe(1)
    expect(editDistance('zorvaht', 'zorvath', 2)).toBe(1)
    expect(editDistance('zorvvat', 'zorvath', 2)).toBe(2)
  })

  it('stops at max + 1 once the words are further apart', () => {
    expect(editDistance('mara', 'zorvath', 2)).toBe(3)
    expect(editDistance('abcdef', 'uvwxyz', 1)).toBe(2)
  })
})

describe('nearName', () => {
  const index = buildNameIndex({
    entityNames: ['Mara Voss', 'Zorvath'],
    nameTagNames: ['mara-voss', 'rose-marsh'],
    accepted: ['foreshadowing', 'Marta', 'zorvaths']
  })

  it('offers the known spelling for a word one letter away', () => {
    expect(nearName('Marra', index)).toBe('Mara')
    expect(nearName('marra', index)).toBe('Mara')
    expect(nearName('Zorvaht', index)).toBe('Zorvath')
  })

  it('allows two letters only for a name of six or more', () => {
    expect(nearName('Zorvvat', index)).toBe('Zorvath')
    expect(nearName('Marrra', index)).toBeNull()
  })

  it('capitalizes a tag name for a capitalized word and keeps it lower-cased otherwise', () => {
    expect(nearName('Marsch', index)).toBe('Marsh')
    expect(nearName('marsch', index)).toBe('marsh')
  })

  it('leaves names, accepted words, short words, and far words alone', () => {
    expect(nearName('Mara', index)).toBeNull()
    expect(nearName('MARA', index)).toBeNull()
    expect(nearName('Marta', index)).toBeNull()
    expect(nearName('Zorvaths', index)).toBeNull()
    expect(nearName('Mar', index)).toBeNull()
    expect(nearName('window', index)).toBeNull()
  })

  it('never compares against a name shorter than four letters', () => {
    const short = buildNameIndex({ entityNames: ['Ann Lee'], nameTagNames: [], accepted: [] })
    expect(nearName('Anna', short)).toBeNull()
  })

  it('prefers the closest name', () => {
    const two = buildNameIndex({
      entityNames: ['Marenne', 'Marienne'],
      nameTagNames: [],
      accepted: []
    })
    expect(nearName('Mariene', two)).toBe('Marienne')
  })
})
