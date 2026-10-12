import { describe, expect, it } from 'vitest'
import { MemoryNotice, SceneMemory, SheetMemory } from './views'

const none = { outcome: 'none', typed: null, text: null, quote: null } as const

describe('the reading views (F-16.18)', () => {
  it('parse a scene with no card yet and an empty sheet', () => {
    expect(
      SceneMemory.safeParse({
        nodeId: 'n1',
        ref: '1.1',
        card: null,
        here: [{ recordId: 'mara', why: 'pov', quote: null, p: null, typedPov: null }],
        mentioned: [{ recordId: 'tomas', count: 2 }],
        trueNow: [],
        typed: { pov: none, place: none, time: none, year: none },
        lastRead: null,
        unread: 3,
        paused: null,
        claims: []
      }).success
    ).toBe(true)
    expect(
      SheetMemory.safeParse({
        recordId: 'mara',
        asOf: null,
        asOfRef: null,
        fixed: [],
        lasting: [],
        transient: [],
        accumulating: [],
        others: [],
        later: 0
      }).success
    ).toBe(true)
  })

  it('tells the notices apart by kind', () => {
    expect(
      MemoryNotice.safeParse({ id: 'b', kind: 'backlog', scenes: 37, priceUsd: 0.03 }).success
    ).toBe(true)
    expect(
      MemoryNotice.safeParse({
        id: 'd',
        kind: 'detailConflict',
        nodeId: 'n1',
        field: 'place',
        typed: 'the harbour',
        text: 'the quay',
        quote: 'She walked to the quay'
      }).success
    ).toBe(true)
    expect(
      MemoryNotice.safeParse({ id: 'x', kind: 'backlog', scenes: 0, priceUsd: 0 }).success
    ).toBe(false)
  })
})
