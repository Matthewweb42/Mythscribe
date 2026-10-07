import { describe, expect, it } from 'vitest'
import {
  ProjectSession,
  SESSION_POSITIONS_MAX,
  defaultProjectSession,
  parseStoredSession,
  withPosition,
  type SessionPosition
} from './session'

const position = (id: string, scrollTop = 0): SessionPosition => ({
  id,
  scrollTop,
  selection: null
})

describe('ProjectSession (F-1.7)', () => {
  it('fills every field of an empty or older row with the defaults', () => {
    expect(ProjectSession.parse({})).toEqual(defaultProjectSession())
    expect(ProjectSession.parse({ selectedNodeId: 'n1' })).toEqual({
      ...defaultProjectSession(),
      selectedNodeId: 'n1'
    })
    expect(ProjectSession.parse({ positions: [{ id: 'd1' }] }).positions).toEqual([
      { id: 'd1', scrollTop: 0, selection: null }
    ])
  })

  it('refuses an unknown sidebar tab, a negative caret, and a bad folder view', () => {
    expect(ProjectSession.safeParse({ sidebarTab: 'nope' }).success).toBe(false)
    expect(
      ProjectSession.safeParse({
        positions: [{ id: 'd', selection: { anchor: -1, head: 0 } }]
      }).success
    ).toBe(false)
    expect(ProjectSession.safeParse({ folderView: 'grid' }).success).toBe(false)
  })
})

describe('parseStoredSession', () => {
  it('answers the defaults for anything unreadable', () => {
    expect(parseStoredSession(null)).toEqual(defaultProjectSession())
    expect(parseStoredSession('text')).toEqual(defaultProjectSession())
    expect(parseStoredSession({ selectedNodeId: 3 })).toEqual(defaultProjectSession())
  })

  it('cuts an over-long position list to its most recent entries', () => {
    const positions = Array.from({ length: SESSION_POSITIONS_MAX + 5 }, (_, i) => position(`d${i}`))
    const parsed = parseStoredSession({ selectedNodeId: 'd0', positions })
    expect(parsed.selectedNodeId).toBe('d0')
    expect(parsed.positions).toHaveLength(SESSION_POSITIONS_MAX)
    expect(parsed.positions[0]?.id).toBe('d0')
  })
})

describe('withPosition', () => {
  it('puts the entry first and replaces the older one of the same document', () => {
    const next = withPosition([position('a'), position('b', 10)], position('b', 40))
    expect(next.map((p) => [p.id, p.scrollTop])).toEqual([
      ['b', 40],
      ['a', 0]
    ])
  })

  it('keeps at most the cap, dropping the least recent', () => {
    const full = Array.from({ length: SESSION_POSITIONS_MAX }, (_, i) => position(`d${i}`))
    const next = withPosition(full, position('new'))
    expect(next).toHaveLength(SESSION_POSITIONS_MAX)
    expect(next[0]?.id).toBe('new')
    expect(next.some((p) => p.id === `d${SESSION_POSITIONS_MAX - 1}`)).toBe(false)
  })
})
