import { describe, expect, it } from 'vitest'
import { twinGate, twinPairs, type TwinRosterRecord } from './twinGate'

const ROSTER: TwinRosterRecord[] = [
  { id: 'rynna', names: ['Rynna Falsire', 'Rynna'] },
  { id: 'harrow-mrs', names: ['Mrs. Harrow'] },
  { id: 'thornmere', names: ['Thornmere'] },
  { id: 'liesel', names: ['Liesel Harrow', 'Liesel', 'Lise'] }
]

const rule = (name: string, dismissed: string[] = []): string => {
  const result = twinGate(name, ROSTER, dismissed)
  return result.outcome === 'clear' ? 'clear' : `${result.rule}:${result.recordId ?? '-'}`
}

describe('twinGate (F-16.4, identity rule 5)', () => {
  it('blocks a name that is an alias once case, diacritics, possessive and titles are folded', () => {
    expect(rule('rynna')).toBe('alias:rynna')
    expect(rule('Rynná’s')).toBe('alias:rynna')
    expect(rule('Mrs Harrow')).toBe('alias:harrow-mrs')
    // Titles out of both sides when nothing matched with them.
    expect(rule('Lady Thornmere')).toBe('alias:thornmere')
  })

  it('blocks a word subset either way, titles removed', () => {
    expect(rule('Falsire')).toBe('subset:rynna')
    expect(rule('Rynna Falsire Vane')).toBe('subset:rynna')
  })

  it('blocks a prefix of a name word of 4+ letters, from 2 letters on', () => {
    expect(rule('Ry')).toBe('prefix:rynna')
    expect(rule('Thorn')).toBe('prefix:thornmere')
    expect(rule('R')).toBe('clear')
  })

  it('blocks by edit distance, scaled to the known name’s length', () => {
    // "Rynna" has 5 letters: one edit.
    expect(rule('Rinna')).toBe('edit:rynna')
    expect(rule('Rinne')).toBe('clear')
    // "Thornmere" has 9: two edits.
    expect(rule('Thornmore')).toBe('edit:thornmere')
    expect(rule('Thornbury')).toBe('clear')
    // A one-word name is compared with each word of a longer one.
    expect(rule('Falsyre')).toBe('edit:rynna')
  })

  it('blocks a dismissed name silently, with no record', () => {
    expect(twinGate('Michaelmas', ROSTER, ['michaelmas'])).toEqual({
      outcome: 'blocked',
      rule: 'dismissed',
      recordId: null,
      matched: 'michaelmas'
    })
  })

  it('clears a new name, and a name made of nothing but punctuation', () => {
    expect(rule('Hesk')).toBe('clear')
    expect(rule('Captain Brand')).toBe('clear')
    expect(rule('...')).toBe('clear')
  })

  it('lists the existing pairs the gate would have kept apart, once per pair', () => {
    expect(
      twinPairs([
        ...ROSTER,
        { id: 'liesl', names: ['Liesl'] },
        { id: 'rynna-2', names: ['Rynna'] }
      ]).map((pair) => [pair.a, pair.b, pair.rule, pair.name])
    ).toEqual([
      // Each record's names are tested in order, so the first name that runs into the other wins.
      ['rynna', 'rynna-2', 'subset', 'Rynna Falsire'],
      // A shared surname is a subset too: the merge list offers it, unticked, for the author.
      ['harrow-mrs', 'liesel', 'subset', 'Mrs. Harrow'],
      ['liesel', 'liesl', 'edit', 'Liesel']
    ])
  })
})
