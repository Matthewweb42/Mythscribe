import { describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import {
  ageAsOf,
  birthYear,
  elapsedBreaks,
  hintsSince,
  recordAge,
  statedAge,
  storyYears,
  yearIn,
  type AgeClaim,
  type YearRow
} from './years'

const row = (nodeId: string, over: Partial<YearRow> = {}): YearRow => ({
  nodeId,
  ref: nodeId.replace('s', '1.'),
  typedYear: null,
  quotedYear: null,
  flashback: false,
  elapsed: null,
  ...over
})

describe('elapsedBreaks (P2b-D14)', () => {
  it('breaks on spans that can cross a year', () => {
    for (const hint of [
      'Three winters later',
      'A year later,',
      'six months later',
      'Eighteen months on',
      '18 months later',
      'Years later',
      'Long after',
      'much later',
      'The next spring',
      'two decades on',
      'a generation later',
      'Half a year had passed'
    ]) {
      expect(elapsedBreaks(hint), hint).toBe(true)
    }
  })

  it('never breaks on hours, days, weeks, a few months, the next morning or that evening', () => {
    for (const hint of [
      'The next morning',
      'That evening',
      'A week later',
      'three days later',
      'an hour later',
      'two months later',
      'a fortnight on'
    ]) {
      expect(elapsedBreaks(hint), hint).toBe(false)
    }
  })
})

describe('yearIn', () => {
  it('reads one 3- or 4-digit year, else null', () => {
    expect(yearIn('1812')).toBe(1812)
    expect(yearIn('the spring of 1812')).toBe(1812)
    expect(yearIn('in 812 they came')).toBe(812)
    expect(yearIn('1811 or 1812')).toBeNull()
    expect(yearIn('twelve')).toBeNull()
    expect(yearIn('18')).toBeNull()
  })
})

describe('storyYears (decision 5)', () => {
  it('carries a typed year forward until the next typed year', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2'),
      row('s3', { typedYear: 1812 }),
      row('s4')
    ])
    expect(years.map((each) => each.year)).toEqual([
      { kind: 'typed', value: 1811, from: { nodeId: 's1', ref: '1.1' } },
      { kind: 'carried', value: 1811, from: { nodeId: 's1', ref: '1.1' } },
      { kind: 'typed', value: 1812, from: { nodeId: 's3', ref: '1.3' } },
      { kind: 'carried', value: 1812, from: { nodeId: 's3', ref: '1.3' } }
    ])
  })

  it('skips a flashback in both directions, and gives it its own year alone', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2', { flashback: true, elapsed: 'Ten years earlier' }),
      row('s3'),
      row('s4', { flashback: true, quotedYear: 'in 1798' }),
      row('s5')
    ])
    expect(years[1]?.year).toEqual({ kind: 'unknown', hint: null })
    expect(years[1]?.flashback).toBe(true)
    expect(years[2]?.year).toMatchObject({ kind: 'carried', value: 1811 })
    expect(years[3]?.year).toMatchObject({ kind: 'quoted', value: 1798 })
    expect(years[4]?.year).toMatchObject({ kind: 'carried', value: 1811 })
  })

  it('ends the carry at a breaking hint, and not at one that cannot cross a year', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2', { elapsed: 'The next morning' }),
      row('s3', { elapsed: 'Three winters later' }),
      row('s4'),
      row('s5', { typedYear: 1815 })
    ])
    expect(years[1]?.year).toMatchObject({ kind: 'carried', value: 1811 })
    expect(years[1]?.elapsed).toMatchObject({ text: 'The next morning', breaks: false })
    const hint = { text: 'Three winters later', nodeId: 's3', ref: '1.3', breaks: true }
    expect(years[2]?.year).toEqual({ kind: 'unknown', hint })
    expect(years[3]?.year).toEqual({ kind: 'unknown', hint })
    expect(years[4]?.year).toMatchObject({ kind: 'typed', value: 1815 })
  })

  it('applies a quoted year to its own scene only, and lets a typed year win over it', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2', { quotedYear: '1813', elapsed: 'A year later' }),
      row('s3'),
      row('s4', { typedYear: 1820, quotedYear: '1819' })
    ])
    expect(years[1]?.year).toMatchObject({ kind: 'quoted', value: 1813 })
    expect(years[2]?.year).toMatchObject({ kind: 'unknown', hint: { text: 'A year later' } })
    expect(years[3]?.year).toMatchObject({ kind: 'typed', value: 1820 })
  })

  it('knows no year before the first typed one', () => {
    expect(storyYears([row('s1'), row('s2', { typedYear: 1811 })])[0]?.year).toEqual({
      kind: 'unknown',
      hint: null
    })
  })
})

const SCENES = ['s1', 's2', 's3', 's4']
const READING: ReadingOrder = {
  order: new Map(SCENES.map((id, i) => [id, i])),
  at: new Map([...SCENES.map((id, i): [string, number] => [id, i]), ['idea', 1]]),
  refs: new Map([...SCENES.map((id, i): [string, string] => [id, `1.${i + 1}`]), ['idea', 'Idea']])
}

let next = 0
const claim = (over: Partial<AgeClaim> & { nodeId: string; value: string }): AgeClaim => {
  next += 1
  return {
    id: `a${next}`,
    voice: 'narration',
    mode: 'now',
    state: 'live',
    para: 0,
    ...over
  }
}

describe('birthYear (P2b-D15)', () => {
  it('takes the latest live narration-now born line up to the scene with one year in it', () => {
    const claims = [
      claim({ nodeId: 's1', value: 'in 1792' }),
      claim({ nodeId: 's2', value: 'the winter of 1793', voice: 'dialogue' }),
      claim({ nodeId: 's3', value: 'in 1791' }),
      claim({ nodeId: 's3', value: 'at sea' })
    ]
    expect(birthYear(claims, [], READING, 's2')).toEqual({
      year: 1792,
      source: 'text',
      claimId: claims[0]?.id,
      nodeId: 's1',
      ref: '1.1'
    })
    expect(birthYear(claims, [], READING, null)?.year).toBe(1791)
  })

  it('falls back to a Pinned "Born:" line, in either form', () => {
    expect(birthYear([], ['Eyes: grey', 'Born: 1792'], READING, null)).toEqual({
      year: 1792,
      source: 'pinned',
      claimId: null,
      nodeId: null,
      ref: null
    })
    expect(birthYear([], ['Born (story year): 1790'], READING, null)?.year).toBe(1790)
    expect(birthYear([], ['Born at sea, raised inland'], READING, null)).toBeNull()
  })
})

describe('ageAsOf (decision 5)', () => {
  const born = { year: 1792, source: 'text' as const, claimId: 'b', nodeId: 's1', ref: '1.1' }
  const carried = { kind: 'carried' as const, value: 1811, from: { nodeId: 's1', ref: '1.1' } }

  it('computes about-ages from a birth year and the scene’s year', () => {
    expect(ageAsOf({ born, year: carried, stated: null, hints: [] })).toEqual({
      kind: 'computed',
      age: 19,
      born,
      year: carried
    })
  })

  it('says not born yet for a negative age', () => {
    expect(
      ageAsOf({ born: { ...born, year: 1820 }, year: carried, stated: null, hints: [] })?.kind
    ).toBe('notBorn')
  })

  it('falls back to the last stated age, listing the hints since and never adding them up', () => {
    const stated = claim({ nodeId: 's2', value: 'nineteen' })
    const hints = [{ text: 'Three winters later', nodeId: 's3', ref: '1.3', breaks: true }]
    expect(
      ageAsOf({
        born,
        year: { kind: 'unknown', hint: null },
        stated: { claim: stated, ref: '1.2' },
        hints
      })
    ).toEqual({
      kind: 'stated',
      value: 'nineteen',
      claimId: stated.id,
      nodeId: 's2',
      ref: '1.2',
      since: hints
    })
    expect(ageAsOf({ born: null, year: carried, stated: null, hints: [] })).toBeNull()
  })

  it('reads the last stated age and the hints since through recordAge', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2'),
      row('s3', { elapsed: 'Three winters later' }),
      row('s4', { elapsed: 'A year later' })
    ])
    const ages = [claim({ nodeId: 's2', value: 'nineteen' })]
    expect(statedAge(ages, READING, 's1')).toBeNull()
    expect(hintsSince(years, 's2', 's4').map((hint) => hint.text)).toEqual([
      'Three winters later',
      'A year later'
    ])
    const at = (atId: string | null): ReturnType<typeof recordAge> =>
      recordAge({ born: [], ages, pinned: [], years, reading: READING, atId })
    expect(at('s2')).toMatchObject({ kind: 'stated', value: 'nineteen', ref: '1.2', since: [] })
    expect(at('s4')).toMatchObject({
      kind: 'stated',
      since: [{ text: 'Three winters later' }, { text: 'A year later' }]
    })
    // With a birth year on Pinned, the carried year computes the age where it is known.
    expect(
      recordAge({ born: [], ages, pinned: ['Born: 1792'], years, reading: READING, atId: 's2' })
    ).toMatchObject({ kind: 'computed', age: 19, born: { source: 'pinned' } })
    // An Idea scene reads as the scene before it.
    expect(
      recordAge({ born: [], ages, pinned: ['Born: 1792'], years, reading: READING, atId: 'idea' })
    ).toMatchObject({ kind: 'computed', age: 19, year: { from: { ref: '1.1' } } })
  })
})
