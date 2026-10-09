import { describe, expect, it } from 'vitest'
import type { Fact } from './facts'
import type { ThreadView } from './threads'
import {
  TODO_WRITTEN_SCENES_MIN,
  continuityFindingIdOf,
  continuityTodoId,
  factConflicts,
  isEmptyRecord,
  parseTodoSuggestions,
  parseTodoTarget,
  recentWindow,
  sentenceAround,
  staleThreads,
  todoCounts,
  todoKey,
  vanishedRecords
} from './todo'

const scenes = (n: number): string[] => Array.from({ length: n }, (_, at) => `s${at + 1}`)

const fact = (over: Partial<Fact>): Fact => ({
  id: over.id ?? 'f',
  entityId: 'mara',
  attribute: 'age',
  value: '30',
  objectEntityId: null,
  nodeId: 's1',
  quote: 'she was thirty',
  origin: 'ai',
  status: 'canon',
  hidden: false,
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  ...over
})

const thread = (nodeIds: string[], over: Partial<ThreadView> = {}): ThreadView => {
  const events = nodeIds.map((nodeId, at) => ({
    factId: `e${at}`,
    event: at === 0 ? ('opened' as const) : ('advanced' as const),
    note: '',
    nodeId,
    quote: 'the oath',
    origin: 'ai' as const,
    status: 'canon' as const
  }))
  return {
    entityId: 'oath',
    name: 'The Oath',
    origin: 'ai',
    status: 'open',
    question: '',
    setup: events[0] ?? null,
    payoff: null,
    events,
    ...over
  }
}

describe('recentWindow', () => {
  it('is at least 8 scenes, else a quarter of the book', () => {
    expect(recentWindow(12)).toBe(8)
    expect(recentWindow(32)).toBe(8)
    expect(recentWindow(40)).toBe(10)
    expect(recentWindow(41)).toBe(11)
  })
})

describe('staleThreads (Q5)', () => {
  it('needs 12 written scenes', () => {
    const order = scenes(TODO_WRITTEN_SCENES_MIN - 1)
    expect(staleThreads([thread(['s1'])], order)).toEqual([])
  })

  it('flags an open thread with no canon event in the last max(8, 25 %) scenes', () => {
    const order = scenes(12)
    // The window is the last 8: s5–s12.
    expect(staleThreads([thread(['s1', 's4'])], order).map((t) => t.entityId)).toEqual(['oath'])
    expect(staleThreads([thread(['s1', 's5'])], order)).toEqual([])
  })

  it('ignores closed threads, threads with no event, and plan events', () => {
    const order = scenes(12)
    expect(staleThreads([thread(['s1'], { status: 'resolved' })], order)).toEqual([])
    expect(staleThreads([thread([])], order)).toEqual([])
    const planned = thread(['s1', 's10'])
    planned.events[1] = { ...planned.events[1]!, status: 'plan' }
    expect(staleThreads([planned], order)).toHaveLength(1)
  })
})

describe('vanishedRecords (Q5)', () => {
  it('flags a record in 3+ scenes and none of the last window', () => {
    const order = scenes(12)
    expect(vanishedRecords([{ entityId: 'kael', nodeIds: ['s1', 's2', 's4'] }], order)).toEqual([
      { entityId: 'kael', scenes: 3, lastNodeId: 's4' }
    ])
    expect(vanishedRecords([{ entityId: 'kael', nodeIds: ['s1', 's2', 's5'] }], order)).toEqual([])
    expect(vanishedRecords([{ entityId: 'kael', nodeIds: ['s1', 's2'] }], order)).toEqual([])
    expect(
      vanishedRecords([{ entityId: 'kael', nodeIds: ['s1', 's2', 's3'] }], scenes(11))
    ).toEqual([])
  })
})

describe('factConflicts', () => {
  const order = scenes(4)

  it('finds two values of a replace field stated in one scene', () => {
    const found = factConflicts(
      [
        fact({ id: 'a', attribute: 'role', value: 'Captain', nodeId: 's2' }),
        fact({ id: 'b', attribute: 'role', value: 'captain ', nodeId: 's2' }),
        fact({ id: 'c', attribute: 'role', value: 'Smuggler', nodeId: 's2', quote: 'a smuggler' })
      ],
      order
    )
    expect(found).toEqual([
      {
        entityId: 'mara',
        attribute: 'role',
        nodeId: 's2',
        values: ['Captain', 'Smuggler'],
        quote: 'a smuggler',
        reason: 'sameScene'
      }
    ])
  })

  it('finds an age that goes down in reading order', () => {
    const found = factConflicts(
      [
        fact({ id: 'a', value: '31', nodeId: 's3', quote: 'thirty-one' }),
        fact({ id: 'b', value: '30', nodeId: 's1' }),
        fact({ id: 'c', value: 'about 29', nodeId: 's4', quote: 'twenty-nine' })
      ],
      order
    )
    expect(found).toEqual([
      expect.objectContaining({
        nodeId: 's4',
        values: ['31', 'about 29'],
        quote: 'twenty-nine',
        reason: 'ageDecrease'
      })
    ])
  })

  it('ignores plan, idea, hidden, author, accumulate, and unwritten-scene facts', () => {
    const found = factConflicts(
      [
        fact({ id: 'a', value: '40', nodeId: 's1' }),
        fact({ id: 'b', value: '20', nodeId: 's2', status: 'plan' }),
        fact({ id: 'c', value: '20', nodeId: 's2', status: 'idea' }),
        fact({ id: 'd', value: '20', nodeId: 's2', hidden: true }),
        fact({ id: 'e', value: '20', nodeId: 's2', origin: 'author' }),
        fact({ id: 'f', value: '20', nodeId: 'gone' }),
        fact({ id: 'g', attribute: 'appearance', value: 'Grey eyes', nodeId: 's3' }),
        fact({ id: 'h', attribute: 'appearance', value: 'Blue eyes', nodeId: 's3' })
      ],
      order
    )
    expect(found).toEqual([])
  })
})

describe('isEmptyRecord', () => {
  it('is empty with no filled field, no page, and no visible field fact', () => {
    expect(isEmptyRecord({ fields: {}, body: null }, [])).toBe(true)
    expect(isEmptyRecord({ fields: { age: '  ' }, body: ' ' }, [])).toBe(true)
    expect(isEmptyRecord({ fields: { age: '31' }, body: null }, [])).toBe(false)
    expect(isEmptyRecord({ fields: {}, body: 'A smuggler.' }, [])).toBe(false)
    expect(isEmptyRecord({ fields: {}, body: null }, [fact({})])).toBe(false)
    expect(isEmptyRecord({ fields: {}, body: null }, [fact({ hidden: true })])).toBe(true)
    expect(isEmptyRecord({ fields: {}, body: null }, [fact({ attribute: 'thread:opened' })])).toBe(
      true
    )
  })
})

describe('sentenceAround', () => {
  const text = 'The ferry was late. Mara waited by the Hollowing gate! Nobody came.'

  it('answers the sentence the range sits in, verbatim', () => {
    const at = text.indexOf('Hollowing')
    expect(sentenceAround(text, at, at + 9)).toBe('Mara waited by the Hollowing gate!')
    expect(sentenceAround(text, 0, 3)).toBe('The ferry was late.')
    expect(sentenceAround(text, text.length - 3)).toBe('Nobody came.')
  })

  it('cuts a long sentence to a window that is still a substring', () => {
    const long = `${'word '.repeat(80)}Hollowing ${'word '.repeat(80)}end.`
    const at = long.indexOf('Hollowing')
    const quote = sentenceAround(long, at, at + 9)
    expect(quote.length).toBeLessThanOrEqual(240)
    expect(quote).toContain('Hollowing')
    expect(long.includes(quote)).toBe(true)
  })
})

describe('keys, ids, and stored cells', () => {
  it('builds keys and maps a contradiction id both ways', () => {
    expect(todoKey('noGoal', 'mara')).toBe('noGoal:mara')
    expect(continuityFindingIdOf(continuityTodoId('f1'))).toBe('f1')
    expect(continuityFindingIdOf('plain')).toBeNull()
  })

  it('reads an unreadable target as none and caps the suggestions', () => {
    expect(parseTodoTarget('{"kind":"later"}')).toEqual({ kind: 'none' })
    expect(parseTodoTarget('nope')).toEqual({ kind: 'none' })
    expect(parseTodoTarget('{"kind":"notes","nodeId":"s1"}')).toEqual({
      kind: 'notes',
      nodeId: 's1'
    })
    expect(parseTodoSuggestions('["a","",1,"b","c","d"]')).toEqual(['a', 'b', 'c'])
    expect(parseTodoSuggestions('{}')).toEqual([])
  })

  it('counts by kind', () => {
    expect(todoCounts([{ kind: 'gap' }, { kind: 'gap' }, { kind: 'undefined' }])).toEqual({
      undefined: 1,
      contradiction: 0,
      looseEnd: 0,
      gap: 2
    })
  })
})
