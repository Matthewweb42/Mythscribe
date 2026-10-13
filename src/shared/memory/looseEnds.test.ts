import { describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import {
  LOOSE_ENDS_MAX,
  looseEnds,
  looseKey,
  looseWindow,
  type LooseEndsInput,
  type LooseThread
} from './looseEnds'

const SCENES = Array.from({ length: 20 }, (_, i) => `s${i + 1}`)
const READING: ReadingOrder = {
  order: new Map(SCENES.map((id, i) => [id, i])),
  at: new Map(SCENES.map((id, i) => [id, i])),
  refs: new Map(SCENES.map((id, i) => [id, `${Math.floor(i / 2) + 1}.${(i % 2) + 1}`]))
}
const ref = (nodeId: string) => ({ nodeId, ref: READING.refs.get(nodeId) ?? '' })

const input = (over: Partial<LooseEndsInput> = {}): LooseEndsInput => ({
  reading: READING,
  drafted: new Set(SCENES),
  checkedUpTo: ref('s20'),
  threads: [],
  characters: [],
  planned: [],
  dismissed: new Set(),
  ...over
})

const thread = (over: Partial<LooseThread> = {}): LooseThread => ({
  recordId: 'heir',
  label: 'The missing heir',
  origin: 'ai',
  steps: [
    { nodeId: 's2', step: 'opens' },
    { nodeId: 's4', step: 'advances' }
  ],
  reveals: [],
  ...over
})

/** Words that would state something did not happen (P2b rule 9). */
const NEGATIVE = /\b(?:no|not|never|nothing|none|nobody|doesn['’]t|didn['’]t|hasn['’]t)\b/i

describe('the window (P4-D19)', () => {
  it('is 8 scenes, or a quarter of the book when that is more', () => {
    expect(looseWindow(20)).toBe(8)
    expect(looseWindow(40)).toBe(10)
    expect(looseWindow(41)).toBe(11)
  })
})

describe('looseEnds (F-16.29)', () => {
  it('lists a thread with two counted steps left a window or more behind', () => {
    const view = looseEnds(input({ threads: [thread()] }))
    expect(view.items).toEqual([
      {
        kind: 'thread',
        id: 'heir',
        name: 'The missing heir',
        lastRef: '2.2',
        lastNodeId: 's4',
        horizonRef: '10.2',
        checkedUpTo: ref('s20'),
        ask: 'The missing heir was last advanced in 2.2. Where does it go next?'
      }
    ])
    expect(view.furthest).toEqual(ref('s20'))
  })

  it('needs two steps unless the author made it, and skips a resolved one or one touched lately', () => {
    const one = thread({ steps: [{ nodeId: 's2', step: 'opens' }] })
    expect(looseEnds(input({ threads: [one] })).items).toEqual([])
    expect(looseEnds(input({ threads: [{ ...one, origin: 'author' }] })).items).toHaveLength(1)
    const resolved = thread({ steps: [...thread().steps, { nodeId: 's5', step: 'resolves' }] })
    expect(looseEnds(input({ threads: [resolved] })).items).toEqual([])
    const lately = thread({ reveals: [{ nodeId: 's15' }] })
    expect(looseEnds(input({ threads: [lately] })).items).toEqual([])
    // An author's thread nothing has touched is no loose end.
    expect(looseEnds(input({ threads: [thread({ origin: 'author', steps: [] })] })).items).toEqual(
      []
    )
  })

  it('measures threads only up to "checked up to" (claims exist only for read scenes)', () => {
    expect(looseEnds(input({ threads: [thread()], checkedUpTo: ref('s10') })).items).toEqual([])
    const scoped = looseEnds(input({ threads: [thread()], checkedUpTo: ref('s12') })).items[0]
    expect(scoped?.horizonRef).toBe('6.2')
    // Its question says how far "last" holds: later scenes are not read yet.
    expect(scoped?.ask).toBe(
      'The missing heir was last advanced in 2.2 (as far as the book is read, up to 6.2). Where does it go next?'
    )
    expect(looseEnds(input({ threads: [thread()], checkedUpTo: null })).items).toEqual([])
  })

  it('lists a character named in three scenes, then absent a window, unless dead', () => {
    const orrin = {
      recordId: 'orrin',
      name: 'Orrin',
      namedIn: ['s1', 's3', 's6'],
      deadAt: () => false
    }
    const view = looseEnds(input({ characters: [orrin] }))
    expect(view.items.map((each) => [each.kind, each.lastRef, each.ask])).toEqual([
      ['character', '3.2', 'Orrin is last named in 3.2. Where is Orrin after that?']
    ])
    expect(looseEnds(input({ characters: [{ ...orrin, namedIn: ['s1', 's6'] }] })).items).toEqual(
      []
    )
    expect(looseEnds(input({ characters: [{ ...orrin, deadAt: () => true }] })).items).toEqual([])
    expect(
      looseEnds(input({ characters: [{ ...orrin, namedIn: ['s1', 's3', 's14'] }] })).items
    ).toEqual([])
  })

  it('lists a planned card before the furthest drafted scene', () => {
    const drafted = new Set(SCENES.filter((id) => id !== 's5'))
    const view = looseEnds(
      input({ drafted, planned: [{ nodeId: 's5', title: 'Mara learns about the map' }] })
    )
    expect(view.items.map((each) => [each.kind, each.ask])).toEqual([
      ['planned', "Which drafted scene covers the plan 'Mara learns about the map'?"]
    ])
    // After the furthest drafted scene it is simply still to come.
    const later = new Set(SCENES.slice(0, 10))
    expect(
      looseEnds(input({ drafted: later, planned: [{ nodeId: 's15', title: 'Later' }] })).items
    ).toEqual([])
  })

  it('leaves out what the author dismissed until it is touched again', () => {
    const dismissed = new Set([looseKey('thread', 'heir', 's4')])
    expect(looseEnds(input({ threads: [thread()], dismissed })).items).toEqual([])
    const touched = thread({ steps: [...thread().steps, { nodeId: 's6', step: 'advances' }] })
    expect(looseEnds(input({ threads: [touched], dismissed })).items).toHaveLength(1)
  })

  it('lists the oldest first, at most ten, and counts the rest', () => {
    const characters = Array.from({ length: 12 }, (_, i) => ({
      recordId: `c${i}`,
      name: `Person ${i}`,
      namedIn: ['s1', 's2', `s${3 + (i % 5)}`],
      deadAt: () => false
    }))
    const view = looseEnds(input({ characters }))
    expect(view.items).toHaveLength(LOOSE_ENDS_MAX)
    expect(view.more).toBe(2)
    expect(view.items[0]?.lastRef).toBe('2.1')
  })

  it('asks every question positively: no line says something did not happen', () => {
    const view = looseEnds(
      input({
        drafted: new Set(SCENES.filter((id) => id !== 's5')),
        threads: [thread()],
        characters: [
          { recordId: 'o', name: 'Orrin', namedIn: ['s1', 's2', 's3'], deadAt: () => false }
        ],
        planned: [{ nodeId: 's5', title: 'The duel' }]
      })
    )
    expect(view.items).toHaveLength(3)
    for (const item of view.items) expect(item.ask).not.toMatch(NEGATIVE)
  })

  it('is empty before anything is drafted', () => {
    expect(looseEnds(input({ drafted: new Set(), threads: [thread()] }))).toMatchObject({
      items: [],
      furthest: null
    })
  })
})
