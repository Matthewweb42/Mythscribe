import { describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import {
  ageAsOf,
  ageYears,
  birthSource,
  birthYear,
  bornLine,
  changesSince,
  elapsedBreaks,
  hintWords,
  recordAge,
  sinceNodeId,
  statedAge,
  storyYears,
  yearCalendar,
  yearIn,
  type AgeClaim,
  type YearRow
} from './years'

/** A card's elapsed hint whose value is its own quote (the reader quoted the words exactly). */
const elapsedHint = (words: string, para = 0): NonNullable<YearRow['elapsed']> => ({
  value: words,
  quote: words,
  para
})

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
      'Half a year had passed',
      'Fifteen months later',
      'twenty-four months later',
      'twenty four months on',
      'thirteen months on',
      'nineteen months after',
      'an eighteen-month voyage later',
      'Months later',
      'Some months later',
      'after several months',
      'In the months that followed'
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
      'a fortnight on',
      'a few months later',
      'a couple of months on',
      'five months later',
      'That month',
      'a month later',
      'the next month'
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
      row('s2', { flashback: true, elapsed: elapsedHint('Ten years earlier') }),
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
      row('s2', { elapsed: elapsedHint('The next morning') }),
      row('s3', { elapsed: elapsedHint('Three winters later') }),
      row('s4'),
      row('s5', { typedYear: 1815 })
    ])
    expect(years[1]?.year).toMatchObject({ kind: 'carried', value: 1811 })
    expect(years[1]?.elapsed).toMatchObject({ text: 'The next morning', breaks: false })
    const ended = {
      text: 'Three winters later',
      quote: 'Three winters later',
      para: 0,
      nodeId: 's3',
      ref: '1.3',
      breaks: true
    }
    expect(years[2]?.year).toEqual({ kind: 'unknown', hint: ended })
    expect(years[3]?.year).toEqual({ kind: 'unknown', hint: ended })
    expect(years[4]?.year).toMatchObject({ kind: 'typed', value: 1815 })
  })

  it('applies a quoted year to its own scene only, and lets a typed year win over it', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2', { quotedYear: '1813', elapsed: elapsedHint('A year later') }),
      row('s3'),
      row('s4', { typedYear: 1820, quotedYear: '1819' })
    ])
    expect(years[1]?.year).toMatchObject({ kind: 'quoted', value: 1813 })
    expect(years[2]?.year).toMatchObject({ kind: 'unknown', hint: { text: 'A year later' } })
    expect(years[3]?.year).toMatchObject({ kind: 'typed', value: 1820 })
  })

  it('shows a hint in the book’s words and ends the carry on its quote too (review of P2b slice 5)', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      // The reader's vague value cannot keep a false carry over a quote that crosses years.
      row('s2', {
        elapsed: { value: 'some time', quote: 'Three winters later, Mara found the heir', para: 2 }
      }),
      // A value the quote holds is shown as the quote has it; one it does not, as the quote.
      row('s3', {
        elapsed: { value: 'a year later', quote: 'A year later, the quay burned', para: 0 }
      }),
      row('s4', {
        typedYear: 1820,
        elapsed: { value: 'three years', quote: 'The ice came again', para: 1 }
      })
    ])
    expect(years[1]?.year).toMatchObject({ kind: 'unknown', hint: { nodeId: 's2' } })
    expect(years[1]?.elapsed).toEqual({
      text: 'Three winters later, Mara found the heir',
      quote: 'Three winters later, Mara found the heir',
      para: 2,
      nodeId: 's2',
      ref: '1.2',
      breaks: true
    })
    expect(years[2]?.elapsed).toMatchObject({ text: 'A year later', breaks: true })
    // "three years" is the reader's word, never shown; its value alone still ends a carry.
    expect(years[3]?.elapsed).toMatchObject({ text: 'The ice came again', breaks: true })
  })

  it('finds the hint’s words in its quote', () => {
    expect(
      hintWords({ value: 'three winters later', quote: 'Three winters later, Mara wept', para: 0 })
    ).toBe('Three winters later')
    expect(hintWords({ value: 'some time', quote: 'Long after, Mara wept', para: 0 })).toBe(
      'Long after, Mara wept'
    )
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
    // A canon sentence that merely opens with "Born" is not a birth-year line.
    expect(
      birthYear([], ['Born and raised in Thornmere: she left in 1801.'], READING, null)
    ).toBeNull()
  })
})

describe('birthSource (what birthYear and C4 read)', () => {
  it('names the claim or the Pinned paragraph the year comes from, and its words', () => {
    const claims = [claim({ nodeId: 's1', value: 'in 1792 AR' })]
    expect(birthSource(claims, [], READING, null)).toEqual({
      year: 1792,
      value: 'in 1792 AR',
      claim: claims[0],
      pinnedAt: null
    })
    expect(birthSource([], ['Eyes: grey', 'Born: 1790'], READING, null)).toEqual({
      year: 1790,
      value: '1790',
      claim: null,
      pinnedAt: 1
    })
  })

  it('takes the claims its caller says set it (C4 holds a stale one rather than skip it)', () => {
    const stale = [claim({ nodeId: 's1', value: 'in 1792', state: 'stale' })]
    expect(birthSource(stale, ['Born: 1790'], READING, null)?.year).toBe(1790)
    expect(
      birthSource(stale, ['Born: 1790'], READING, null, (each) => each.mode === 'now')?.year
    ).toBe(1792)
  })
})

describe('ageAsOf (decision 5)', () => {
  const born = { year: 1792, source: 'text' as const, claimId: 'b', nodeId: 's1', ref: '1.1' }
  const carried = { kind: 'carried' as const, value: 1811, from: { nodeId: 's1', ref: '1.1' } }

  it('computes about-ages from a birth year and the scene’s year', () => {
    expect(ageAsOf({ born, year: carried, stated: null, since: [] })).toEqual({
      kind: 'computed',
      age: 19,
      born,
      year: carried
    })
  })

  it('says not born yet for a negative age', () => {
    expect(
      ageAsOf({ born: { ...born, year: 1820 }, year: carried, stated: null, since: [] })?.kind
    ).toBe('notBorn')
  })

  it('falls back to the last stated age, listing the hints since and never adding them up', () => {
    const stated = claim({ nodeId: 's2', value: 'nineteen' })
    const since = [
      {
        kind: 'hint' as const,
        hint: {
          text: 'Three winters later',
          quote: 'Three winters later',
          para: 0,
          nodeId: 's3',
          ref: '1.3',
          breaks: true
        }
      }
    ]
    expect(
      ageAsOf({
        born,
        year: { kind: 'unknown', hint: null },
        stated: { claim: stated, ref: '1.2' },
        since
      })
    ).toEqual({
      kind: 'stated',
      value: 'nineteen',
      claimId: stated.id,
      nodeId: 's2',
      ref: '1.2',
      since
    })
    expect(ageAsOf({ born: null, year: carried, stated: null, since: [] })).toBeNull()
  })

  it('gives the birth year alone when the scene’s year is not known and no age is stated', () => {
    const ended = {
      text: 'Three winters later',
      quote: 'Three winters later',
      para: 0,
      nodeId: 's3',
      ref: '1.3',
      breaks: true
    }
    expect(
      ageAsOf({ born, year: { kind: 'unknown', hint: ended }, stated: null, since: [] })
    ).toEqual({ kind: 'bornOnly', born, hint: ended })
    // Before the first typed year: no hint to give.
    expect(ageAsOf({ born, year: null, stated: null, since: [] })).toEqual({
      kind: 'bornOnly',
      born,
      hint: null
    })
  })

  it('reads the last stated age and the hints since through recordAge', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2'),
      row('s3', { elapsed: elapsedHint('Three winters later') }),
      row('s4', { elapsed: elapsedHint('A year later') })
    ])
    const ages = [claim({ nodeId: 's2', value: 'nineteen' })]
    expect(statedAge(ages, READING, 's1')).toBeNull()
    expect(
      changesSince(years, 's2', 's4').map((entry) =>
        entry.kind === 'hint' ? entry.hint.text : entry.value
      )
    ).toEqual(['Three winters later', 'A year later'])
    const at = (atId: string | null): ReturnType<typeof recordAge> =>
      recordAge({ born: [], ages, pinned: [], years, reading: READING, atId })
    expect(at('s2')).toMatchObject({ kind: 'stated', value: 'nineteen', ref: '1.2', since: [] })
    expect(at('s4')).toMatchObject({
      kind: 'stated',
      since: [
        { kind: 'hint', hint: { text: 'Three winters later' } },
        { kind: 'hint', hint: { text: 'A year later' } }
      ]
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

  it('lists a later typed or quoted year after a stated age, never adding it up', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2'),
      row('s3', { typedYear: 1820 }),
      row('s4', { quotedYear: '1820' })
    ])
    const ages = [claim({ nodeId: 's2', value: 'nineteen' })]
    const at = recordAge({ born: [], ages, pinned: [], years, reading: READING, atId: 's4' })
    expect(at).toMatchObject({
      kind: 'stated',
      value: 'nineteen',
      since: [{ kind: 'year', value: 1820, nodeId: 's3', ref: '1.3' }]
    })
    expect(at?.kind === 'stated' ? at.since.map(sinceNodeId) : null).toEqual(['s3'])
  })

  it('gives the birth year alone where the scene’s year is not known', () => {
    const years = storyYears([
      row('s1', { typedYear: 1811 }),
      row('s2', { elapsed: elapsedHint('three years') })
    ])
    const born = [claim({ nodeId: 's1', value: '1792' })]
    const at = (atId: string): ReturnType<typeof recordAge> =>
      recordAge({ born, ages: [], pinned: [], years, reading: READING, atId })
    expect(at('s1')).toMatchObject({ kind: 'computed', age: 19 })
    expect(at('s2')).toMatchObject({
      kind: 'bornOnly',
      born: { year: 1792, ref: '1.1' },
      hint: { text: 'three years', ref: '1.2' }
    })
    // Before any typed year, with only the author's Pinned line.
    expect(
      recordAge({
        born: [],
        ages: [],
        pinned: ['Born: 1790'],
        years: storyYears([row('s1'), row('s2')]),
        reading: READING,
        atId: 's2'
      })
    ).toMatchObject({ kind: 'bornOnly', born: { year: 1790, source: 'pinned' }, hint: null })
  })

  it('never takes an age stated in a flashback as the age after it (story time)', () => {
    const years = storyYears([row('s1'), row('s2'), row('s3', { flashback: true }), row('s4')])
    const ages = [
      claim({ nodeId: 's1', value: 'nineteen' }),
      claim({ nodeId: 's3', value: 'nine' })
    ]
    const at = (atId: string): ReturnType<typeof recordAge> =>
      recordAge({ born: [], ages, pinned: [], years, reading: READING, atId })
    expect(at('s4')).toMatchObject({ kind: 'stated', value: 'nineteen', ref: '1.1' })
    // In the flashback, its own stated age stands; a flashback with none shows none.
    expect(at('s3')).toMatchObject({ kind: 'stated', value: 'nine', ref: '1.3', since: [] })
    expect(
      recordAge({
        born: [],
        ages: ages.slice(0, 1),
        pinned: [],
        years,
        reading: READING,
        atId: 's3'
      })
    ).toBeNull()
  })
})

describe('ages and years as C4 reads them (F-16.27)', () => {
  it('reads a stated age in digits or words', () => {
    expect(ageYears('17')).toBe(17)
    expect(ageYears('about 40')).toBe(40)
    expect(ageYears('seventeen')).toBe(17)
    expect(ageYears('nineteen')).toBe(19)
    expect(ageYears('twenty-four')).toBe(24)
    expect(ageYears('twenty four')).toBe(24)
    expect(ageYears('seven-and-twenty')).toBe(27)
    expect(ageYears('two-and-twenty')).toBe(22)
    expect(ageYears('a girl')).toBeNull()
    expect(ageYears('old')).toBeNull()
    expect(ageYears('two years old')).toBe(2)
    // Months, weeks and days are never read as years.
    expect(ageYears('six months old')).toBeNull()
    expect(ageYears('eighteen months')).toBeNull()
    expect(ageYears('three weeks old')).toBeNull()
    expect(ageYears('10 days')).toBeNull()
    expect(ageYears('twenty four hours')).toBeNull()
  })

  it('reads a Pinned Born line as a year and its words', () => {
    expect(bornLine('Born: 1792')).toEqual({ year: 1792, value: '1792' })
    expect(bornLine('Born (story year): spring 1790')).toEqual({ year: 1790, value: 'spring 1790' })
    expect(bornLine('Born in the north')).toBeNull()
  })

  it('reads the calendar beside a year: era marks only', () => {
    expect(yearCalendar('1812')).toBe('')
    expect(yearCalendar('the spring of 1812')).toBe('')
    expect(yearCalendar('in 1795')).toBe('')
    expect(yearCalendar('1812 AR')).toBe('AR')
    expect(yearCalendar('in 300 B.C.')).toBe('BC')
  })
})
