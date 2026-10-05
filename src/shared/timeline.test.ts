import { describe, expect, it } from 'vitest'
import { SCENE_META_TIMELINE_MAX, emptySceneMeta, parseStoredSceneMeta } from './sceneMeta'
import {
  ProjectTimeline,
  TIMELINE_EVENTS_MAX,
  TIMELINE_EVENT_TEXT_MAX,
  addEvent,
  defaultProjectTimeline,
  eventForText,
  eventText,
  moveEvent,
  removeEvent,
  timelineProblem,
  updateEvent,
  type TimelineEvent
} from './timeline'

const event = (id: string, label: string, when = '', year: number | null = null): TimelineEvent => ({
  id,
  label,
  when,
  year,
  note: ''
})

describe('ProjectTimeline', () => {
  it('parses an empty timeline and trims labels and whens', () => {
    expect(ProjectTimeline.parse(defaultProjectTimeline())).toEqual({ events: [] })
    expect(
      ProjectTimeline.parse({ events: [{ ...event('a', '  The fall '), when: ' Spring ' }] })
    ).toEqual({ events: [event('a', 'The fall', 'Spring')] })
  })

  it('refuses a blank label, a fractional or far year, duplicate ids, and duplicate labels', () => {
    expect(ProjectTimeline.safeParse({ events: [event('a', '   ')] }).success).toBe(false)
    expect(ProjectTimeline.safeParse({ events: [event('a', 'A', '', 1.5)] }).success).toBe(false)
    expect(ProjectTimeline.safeParse({ events: [event('a', 'A', '', 2e6)] }).success).toBe(false)
    expect(
      ProjectTimeline.safeParse({ events: [event('a', 'A'), event('a', 'B')] }).success
    ).toBe(false)
    expect(
      ProjectTimeline.safeParse({ events: [event('a', 'The Fall'), event('b', ' the  fall')] })
        .success
    ).toBe(false)
  })

  it('caps the list', () => {
    const events = Array.from({ length: TIMELINE_EVENTS_MAX + 1 }, (_, i) => event(`e${i}`, `E${i}`))
    expect(ProjectTimeline.safeParse({ events }).success).toBe(false)
  })
})

describe('timelineProblem', () => {
  it('names the duplicate label, and answers null for a clean list', () => {
    expect(timelineProblem([event('a', 'Siege'), event('b', 'Fall')])).toBeNull()
    expect(timelineProblem([event('a', 'Siege'), event('b', 'SIEGE ')])).toBe(
      'There is already an event called "SIEGE"'
    )
    expect(timelineProblem([event('a', 'Siege'), event('a', 'Fall')])).toBe(
      'Two timeline events share one id'
    )
  })
})

describe('eventText / eventForText', () => {
  it('prefixes the when when there is one', () => {
    expect(eventText(event('a', 'The siege begins', 'Spring'))).toBe('Spring: The siege begins')
    expect(eventText(event('a', 'The fall'))).toBe('The fall')
  })

  it('always fits the scene timeline field', () => {
    expect(TIMELINE_EVENT_TEXT_MAX).toBeLessThanOrEqual(SCENE_META_TIMELINE_MAX)
  })

  it('finds an event by its exact text only', () => {
    const events = [event('a', 'The siege begins', 'Spring'), event('b', 'The fall')]
    expect(eventForText(events, 'Spring: The siege begins')?.id).toBe('a')
    expect(eventForText(events, 'The fall')?.id).toBe('b')
    expect(eventForText(events, 'The siege begins')).toBeNull()
    expect(eventForText(events, 'the fall')).toBeNull()
  })
})

describe('list helpers', () => {
  const events = [event('a', 'A'), event('b', 'B'), event('c', 'C')]

  it('adds a new event and answers the same array for a known id', () => {
    expect(addEvent(events, event('d', 'D')).map((e) => e.id)).toEqual(['a', 'b', 'c', 'd'])
    expect(addEvent(events, event('a', 'Again'))).toBe(events)
  })

  it('updates one event, and answers the same array when nothing changes', () => {
    expect(updateEvent(events, 'b', { when: 'Day 2' })[1]).toEqual(event('b', 'B', 'Day 2'))
    expect(updateEvent(events, 'b', { label: 'B' })).toBe(events)
    expect(updateEvent(events, 'zz', { label: 'Z' })).toBe(events)
  })

  it('removes and moves', () => {
    expect(removeEvent(events, 'b').map((e) => e.id)).toEqual(['a', 'c'])
    expect(removeEvent(events, 'zz')).toBe(events)
    expect(moveEvent(events, 2, 0).map((e) => e.id)).toEqual(['c', 'a', 'b'])
    expect(moveEvent(events, 0, -5)).toBe(events)
  })
})

describe('SceneMeta.eventId', () => {
  it('round-trips through the stored column and stays absent for an older row', () => {
    const linked = { ...emptySceneMeta(), timeline: 'The fall', eventId: 'b' }
    expect(parseStoredSceneMeta(JSON.stringify(linked))).toEqual(linked)
    const older = parseStoredSceneMeta(JSON.stringify({ location: '', pov: '', timeline: 'x' }))
    expect('eventId' in older).toBe(false)
  })
})
