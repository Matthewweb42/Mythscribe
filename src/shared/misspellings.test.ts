import { describe, expect, it } from 'vitest'
import {
  editDistance,
  findMisspellings,
  groupMisspellings,
  isCloseSpelling,
  isMisspeltName,
  type SpellingCandidate
} from './misspellings'
import type { TiptapNodeT } from './tiptap'

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: text === '' ? [] : [{ type: 'text', text }]
  }))
})

const rynna: SpellingCandidate = {
  id: 't-rynna',
  name: 'rynna-falsire',
  category: 'character',
  display: 'Rynna Falsire',
  aliases: ['High Crown Falsire']
}

describe('editDistance and isCloseSpelling (F-4.14)', () => {
  it('counts substitutions, insertions, deletions, and adjacent swaps as one edit each', () => {
    expect(editDistance('falseer', 'falsire')).toBe(2)
    expect(editDistance('rynan', 'rynna')).toBe(1)
    expect(editDistance('kael', 'kael')).toBe(0)
    expect(editDistance('abcdefgh', 'a', 2)).toBe(3)
  })

  it('takes a close word with the same first letter, never an exact one, a short one, or a far one', () => {
    expect(isCloseSpelling('falseer', 'falsire')).toBe(true)
    expect(isCloseSpelling('rynan', 'rynna')).toBe(true)
    expect(isCloseSpelling('falsire', 'falsire')).toBe(false)
    expect(isCloseSpelling('rael', 'kael')).toBe(false)
    expect(isCloseSpelling('ash', 'asg')).toBe(false)
    expect(isCloseSpelling('fortune', 'falsire')).toBe(false)
  })
})

describe('findMisspellings (F-4.14)', () => {
  it('finds a misspelt full name, a lone misspelt surname, and suggests the sheet’s spelling', () => {
    const found = findMisspellings(doc('Rynna Falseer rode in.', 'Later Falseer slept.'), [rynna])
    expect(found).toEqual([
      { tagId: 't-rynna', range: [1, 14], text: 'Rynna Falseer', suggestion: 'Rynna Falsire' },
      { tagId: 't-rynna', range: [31, 38], text: 'Falseer', suggestion: 'Falsire' }
    ])
  })

  it('leaves exact names and aliases alone, and lower-case words, and kept spellings', () => {
    expect(
      findMisspellings(doc('Rynna Falsire and the High Crown Falsire met falseer.'), [rynna])
    ).toEqual([])
    expect(findMisspellings(doc('Falseer again.'), [rynna], new Set(['falseer']))).toEqual([])
  })

  it('checks aliases too, and title-cases a name known only in kebab case', () => {
    const found = findMisspellings(doc('The High Crown Falsier spoke to Marrow.'), [
      rynna,
      { id: 't-morrow', name: 'morrow', category: 'setting' }
    ])
    expect(found.map((item) => [item.text, item.suggestion])).toEqual([
      ['High Crown Falsier', 'High Crown Falsire'],
      ['Marrow', 'Morrow']
    ])
  })

  it('groups the same misspelling into one row with every range', () => {
    const groups = groupMisspellings(
      findMisspellings(doc('Falseer, Falseer, and Rynna Falseer.'), [rynna])
    )
    expect(groups.map((group) => [group.text, group.ranges.length])).toEqual([
      ['Falseer', 2],
      ['Rynna Falseer', 1]
    ])
  })
})

describe('isMisspeltName (F-4.14)', () => {
  it('says whether a proposed name is a close spelling of a word of a bank name', () => {
    expect(isMisspeltName('falseer', ['rynna-falsire'])).toBe(true)
    expect(isMisspeltName('tash', ['rynna-falsire'])).toBe(false)
  })
})
