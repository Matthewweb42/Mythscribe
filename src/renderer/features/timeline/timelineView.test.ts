import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '@shared/timeline'
import {
  ageText,
  agesOnTimeline,
  eventAges,
  linkedEventId,
  nodesByEvent,
  readingOrderRows,
  unplacedCount,
  yearWarnings
} from './timelineView'

const event = (id: string, year: number | null = null): TimelineEvent => ({
  id,
  label: id.toUpperCase(),
  when: '',
  year,
  note: ''
})
const events = [event('a'), event('b'), event('c')]
const links: Record<string, string> = { s1: 'b', s2: 'a', s3: 'gone', s5: 'c', s6: 'b' }
const eventOf = (id: string): string | undefined => links[id]

describe('timelineView (F-11.2)', () => {
  it('treats a link to a deleted event as unlinked', () => {
    expect(linkedEventId(events, 'b')).toBe('b')
    expect(linkedEventId(events, 'gone')).toBeUndefined()
    expect(linkedEventId(events, undefined)).toBeUndefined()
  })

  it('lists each event’s nodes in reading order', () => {
    const map = nodesByEvent(events, ['s1', 's2', 's3', 's4', 's6'], eventOf)
    expect(map.get('a')).toEqual(['s2'])
    expect(map.get('b')).toEqual(['s1', 's6'])
    expect(map.get('c')).toEqual([])
  })

  it('counts the documents on no existing event', () => {
    expect(unplacedCount(events, ['s1', 's2', 's3', 's4'], eventOf)).toBe(2)
  })

  it('warns on a year lower than an earlier event’s, skipping events without one', () => {
    expect(
      yearWarnings([event('a', 1200), event('b', null), event('c', 1199), event('d', 1201)])
    ).toEqual(new Set(['c']))
  })

  it('flags documents set before the latest event read so far', () => {
    expect(readingOrderRows(events, ['s1', 's2', 's4', 's5', 's6'], eventOf)).toEqual([
      { id: 's1', eventIndex: 1, flashback: false },
      { id: 's2', eventIndex: 0, flashback: true },
      { id: 's4', eventIndex: null, flashback: false },
      { id: 's5', eventIndex: 2, flashback: false },
      { id: 's6', eventIndex: 1, flashback: true }
    ])
  })
})

describe('ages on the timeline (F-11.2b)', () => {
  const character = (
    id: string,
    name: string,
    born: string | null,
    tagId: string | null = null
  ) => ({
    id,
    kind: 'character' as const,
    name,
    fields: born === null ? {} : { born },
    tagId
  })
  const dated = [event('a', 1200), event('b'), event('c', 1150)]
  const linked = new Map([
    ['a', ['s1', 's2']],
    ['b', ['s3']],
    ['c', ['s4']]
  ])
  const tags: Record<string, string[]> = { s1: ['t-mara'], s3: ['t-mara'], s4: ['t-mara'] }
  const povs: Record<string, string> = { s2: 'TOBIN', s4: '' }

  it('lists the tagged and POV characters with a birth year per event with a year, by name', () => {
    const ages = eventAges(
      dated,
      linked,
      [
        character('e-tobin', 'Tobin', '1190'),
        character('e-mara', 'Mara', '1170', 't-mara'),
        character('e-ines', 'Ines', '1180', 't-ines'),
        character('e-vell', 'Vell', 'old', 't-mara'),
        { ...character('e-mill', 'Tobin', '1100'), kind: 'setting' as const }
      ],
      (id) => tags[id],
      (id) => povs[id]
    )
    expect(ages).toEqual(
      new Map([
        [
          'a',
          [
            { entityId: 'e-mara', name: 'Mara', age: 30 },
            { entityId: 'e-tobin', name: 'Tobin', age: 10 }
          ]
        ],
        ['c', [{ entityId: 'e-mara', name: 'Mara', age: -20 }]]
      ])
    )
  })

  it('lists a character’s age at every event with a year, in story order', () => {
    expect(agesOnTimeline(dated, 1170).map(({ event: e, year, age }) => [e.id, year, age])).toEqual(
      [
        ['a', 1200, 30],
        ['c', 1150, -20]
      ]
    )
    expect(ageText(-20)).toBe('not born yet')
    expect(ageText(0)).toBe('0')
  })
})
