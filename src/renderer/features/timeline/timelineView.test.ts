import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '@shared/timeline'
import {
  linkedEventId,
  nodesByEvent,
  parseYear,
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

  it('reads the year field: blank is none, whole numbers only, within the limit', () => {
    expect(parseYear(' ')).toBeNull()
    expect(parseYear('1201')).toBe(1201)
    expect(parseYear('-40')).toBe(-40)
    expect(parseYear('12.5')).toBe('invalid')
    expect(parseYear('soon')).toBe('invalid')
    expect(parseYear('2000000')).toBe('invalid')
  })
})
