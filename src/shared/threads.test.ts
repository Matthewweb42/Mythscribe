import { describe, expect, it } from 'vitest'
import type { Fact } from './facts'
import { deriveThreads, threadAttribute, threadEventOf } from './threads'

let n = 0
function event(
  entityId: string,
  name: 'opened' | 'advanced' | 'resolved' | 'dropped',
  nodeId: string | null,
  over: Partial<Fact> = {}
): Fact {
  n += 1
  return {
    id: `f${n}`,
    entityId,
    attribute: threadAttribute(name),
    value: '',
    objectEntityId: null,
    nodeId,
    quote: 'q',
    origin: 'ai',
    status: 'canon',
    hidden: false,
    createdAt: `2026-10-09T00:00:${String(n).padStart(2, '0')}Z`,
    updatedAt: '',
    ...over
  }
}

const ORDER = ['s1', 's2', 's3']
const DEBT = { id: 't1', name: 'The Debt', origin: 'ai' as const }
const BELL = { id: 't2', name: 'The Bell', origin: 'author' as const }

describe('thread vocabulary (F-9.14)', () => {
  it('round-trips an event through its attribute and refuses anything else', () => {
    expect(threadEventOf(threadAttribute('resolved'))).toBe('resolved')
    expect(threadEventOf('thread:paused')).toBeNull()
    expect(threadEventOf('age')).toBeNull()
  })
})

describe('deriveThreads (F-9.14)', () => {
  it('derives the status from the last canon event in reading order', () => {
    const facts = [
      event('t1', 'resolved', 's3'),
      event('t1', 'opened', 's1', { value: 'Will Mara pay?' }),
      event('t2', 'opened', 's2'),
      event('t2', 'dropped', 's3')
    ]
    const [debt, bell] = deriveThreads([BELL, DEBT], facts, ORDER)
    expect(debt).toMatchObject({ name: 'The Debt', status: 'resolved', question: 'Will Mara pay?' })
    expect(debt?.setup).toMatchObject({ event: 'opened', nodeId: 's1' })
    expect(debt?.payoff).toMatchObject({ event: 'resolved', nodeId: 's3' })
    expect(debt?.events.map((each) => each.nodeId)).toEqual(['s1', 's3'])
    expect(bell).toMatchObject({ status: 'dropped', origin: 'author' })
  })

  it('reads a thread with no event as open and lists it last; plan, idea, and hidden events never decide', () => {
    const facts = [
      event('t1', 'opened', 's1'),
      event('t1', 'resolved', 's2', { status: 'idea' }),
      event('t1', 'dropped', 's3', { hidden: true })
    ]
    const [debt, bell] = deriveThreads([BELL, DEBT], facts, ORDER)
    expect(debt?.status).toBe('open')
    expect(debt?.payoff).toBeNull()
    expect(debt?.events).toHaveLength(2)
    expect(bell).toMatchObject({ name: 'The Bell', status: 'open', setup: null, events: [] })
  })

  it('ignores facts that are no thread event', () => {
    const fact = event('t1', 'opened', 's1', { attribute: 'description' })
    expect(deriveThreads([DEBT], [fact], ORDER)[0]?.events).toEqual([])
  })
})
