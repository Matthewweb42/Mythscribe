import { describe, expect, it } from 'vitest'
import type { AgeView } from '@shared/memory/views'
import { computedAgeFixture, elapsedHintFixture } from '../memoryFixture'
import { ageText, bornText, hintText, noAgeText, statedText, yearText } from './timeView'

const AT = { nodeId: 'sc-1', ref: '1.1' }
const HINT = elapsedHintFixture('sc-3')

/** F-16.23: the words of story years and ages (decision 5, plan P2b §5.2). */
describe('years and ages, in words (F-16.23)', () => {
  it('says where a scene’s year comes from', () => {
    expect(yearText({ kind: 'typed', value: 1811, from: AT }, false)).toBe('1811')
    expect(yearText({ kind: 'carried', value: 1811, from: AT }, false)).toBe('1811 · from 1.1')
    expect(yearText({ kind: 'quoted', value: 1812, from: AT }, false)).toBe('1812 · stated here')
    expect(yearText({ kind: 'quoted', value: 1798, from: AT }, true)).toBe('flashback · 1798')
    expect(yearText({ kind: 'unknown', hint: HINT }, false)).toBe(
      'year not known since “Three winters later” (1.3)'
    )
    expect(yearText({ kind: 'unknown', hint: null }, false)).toBe('year not known')
    expect(yearText({ kind: 'unknown', hint: null }, true)).toBe('flashback · year not known')
    expect(hintText(HINT)).toBe('“Three winters later” (1.3)')
  })

  it('says an age: about, computed; stated, with the hints since listed and never added', () => {
    expect(ageText(computedAgeFixture(19))).toBe('about 19 · year from 1.1')
    const stated: AgeView = {
      kind: 'stated',
      value: '19',
      claimId: 'c',
      nodeId: 'sc-2',
      ref: '1.2',
      since: [{ kind: 'hint', hint: HINT }]
    }
    expect(ageText(stated)).toBe('19, stated in 1.2 · since then: “Three winters later” (1.3)')
    // A later typed year is listed beside the hints, never added up.
    expect(
      ageText({
        ...stated,
        since: [
          { kind: 'hint', hint: HINT },
          { kind: 'year', value: 1820, nodeId: 'sc-4', ref: '1.4' }
        ]
      })
    ).toBe('19, stated in 1.2 · since then: “Three winters later” (1.3), 1820 (1.4)')
    expect(ageText({ ...stated, since: [] })).toBe('19, stated in 1.2')
    expect(statedText(stated)).toBe('Age: 19')
    const fixture = computedAgeFixture(19)
    if (fixture.kind !== 'computed') throw new Error('computed')
    expect(ageText({ kind: 'notBorn', born: fixture.born, year: fixture.year })).toBe(
      'not born yet · year from 1.1'
    )
    expect(bornText(fixture.born)).toBe('Born: 1792')
    expect(bornText({ ...fixture.born, source: 'pinned', claimId: null })).toBe(
      'Born: 1792 (your Pinned line)'
    )
  })

  it('gives the birth year alone where the year is not known, and scopes no age at all', () => {
    const fixture = computedAgeFixture(19)
    if (fixture.kind !== 'computed') throw new Error('computed')
    expect(ageText({ kind: 'bornOnly', born: fixture.born, hint: HINT })).toBe(
      'born 1792 · this scene’s year not known since “Three winters later” (1.3)'
    )
    expect(ageText({ kind: 'bornOnly', born: fixture.born, hint: null })).toBe(
      'born 1792 · no story year known as of this scene'
    )
    expect(noAgeText(AT)).toBe('No birth year or stated age read (checked up to 1.1)')
    expect(noAgeText(null)).toBe('No birth year or stated age read (not checked yet)')
  })
})
