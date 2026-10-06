import { describe, expect, it } from 'vitest'
import type { TimelineEvent } from '@shared/timeline'
import {
  appearancesOf,
  appearsBy,
  inStoryOrder,
  locationConflicts,
  namesEntity,
  scenesSetAt,
  type UsageEntity
} from './usageLog'

const event = (id: string, label: string): TimelineEvent => ({
  id,
  label,
  when: '',
  year: null,
  note: ''
})

const rowan: UsageEntity = { id: 'e-rowan', kind: 'character', name: 'Rowan', tagId: 't-rowan' }
const keep: UsageEntity = { id: 'e-keep', kind: 'setting', name: 'The Keep', tagId: null }

const lookup =
  <T>(map: Record<string, T>) =>
  (id: string): T | undefined =>
    map[id]

describe('usageLog (F-11.2c)', () => {
  it('namesEntity compares name keys and never matches blank text', () => {
    expect(namesEntity('  rowan ', 'Rowan')).toBe(true)
    expect(namesEntity('Rowan Ash', 'Rowan')).toBe(false)
    expect(namesEntity('', '')).toBe(false)
    expect(namesEntity(undefined, 'Rowan')).toBe(false)
  })

  it('appearancesOf lists linked, mentioned, and POV documents in reading order', () => {
    const rows = appearancesOf(
      rowan,
      ['a', 'b', 'c', 'd'],
      lookup({ c: ['t-rowan'], d: ['t-other'] }),
      (id) => (id === 'a' ? 2 : 0),
      lookup({ b: 'ROWAN', c: 'Rowan' })
    )
    expect(rows).toEqual([
      { nodeId: 'a', how: { linked: false, mentions: 2, pov: false } },
      { nodeId: 'b', how: { linked: false, mentions: 0, pov: true } },
      { nodeId: 'c', how: { linked: true, mentions: 0, pov: true } }
    ])
  })

  it('appearancesOf ignores the POV for a setting and tags for an entity without one', () => {
    expect(
      appearancesOf(
        keep,
        ['a'],
        () => ['t-keep'],
        () => 3,
        () => 'The Keep'
      )
    ).toEqual([])
  })

  it('scenesSetAt matches Location by name key', () => {
    expect(
      scenesSetAt('The Keep', ['a', 'b', 'c'], lookup({ a: 'the keep', b: 'Harbor', c: '' }))
    ).toEqual(['a'])
  })

  it('inStoryOrder groups by event in story order, the unplaced last', () => {
    const events = [event('e1', 'Siege'), event('e2', 'Flood'), event('e3', 'Empty')]
    const eventOf = lookup<string>({ a: 'e2', b: 'e1', c: 'gone', d: 'e2' })
    const groups = inStoryOrder(
      ['a', 'b', 'c', 'd', 'e'].map((nodeId) => ({ nodeId })),
      events,
      eventOf
    )
    expect(groups.map((g) => [g.event?.label ?? null, g.rows.map((r) => r.nodeId)])).toEqual([
      ['Siege', ['b']],
      ['Flood', ['a', 'd']],
      [null, ['c', 'e']]
    ])
  })

  it('locationConflicts flags a character in two locations at one event', () => {
    const events = [event('e1', 'Siege'), event('e2', 'Flood')]
    const linked = new Map([
      ['e1', ['a', 'b', 'c']],
      ['e2', ['d', 'e']]
    ])
    const locations = lookup({ a: 'Keep', b: 'Harbor', c: ' keep ', d: 'Keep', e: 'keep' })
    const appears = appearsBy(
      lookup({ a: ['t-rowan'], d: ['t-rowan'] }),
      (tagId, nodeId) => tagId === 't-rowan' && nodeId === 'e',
      lookup({ b: 'Rowan', c: 'Rowan' })
    )
    expect(locationConflicts(events, linked, [rowan, keep], appears, locations)).toEqual([
      { eventId: 'e1', entityId: 'e-rowan', name: 'Rowan', locations: ['Keep', 'Harbor'] }
    ])
  })

  it('locationConflicts skips blank locations and scenes the character is not in', () => {
    const linked = new Map([['e1', ['a', 'b', 'c']]])
    const appears = appearsBy(
      () => undefined,
      () => false,
      lookup({ a: 'Rowan', b: 'Rowan' })
    )
    expect(
      locationConflicts(
        [event('e1', 'Siege')],
        linked,
        [rowan],
        appears,
        lookup({ a: 'Keep', b: '  ', c: 'Harbor' })
      )
    ).toEqual([])
  })
})
