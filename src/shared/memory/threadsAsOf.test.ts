import { describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import { stepCounts, threadsAsOf, type ThreadStepClaim, type ThreadsAsOfInput } from './threadsAsOf'
import type { TopicQuoteInput } from './whoKnows'

const SCENES = ['s1', 's2', 's3', 's4']
const READING: ReadingOrder = {
  order: new Map(SCENES.map((id, i) => [id, i])),
  at: new Map([...SCENES.map((id, i): [string, number] => [id, i]), ['idea', 1]]),
  refs: new Map([...SCENES.map((id, i): [string, string] => [id, `2.${i + 1}`]), ['idea', 'Idea']])
}

let next = 0
const step = (
  over: Partial<ThreadStepClaim> & { nodeId: string; how: string }
): ThreadStepClaim => {
  next += 1
  return {
    id: `t${String(next).padStart(3, '0')}`,
    recordId: 'heir',
    value: 'something happens',
    voice: 'narration',
    mode: 'now',
    para: 0,
    state: 'live',
    ...over
  }
}

const input = (over: Partial<ThreadsAsOfInput> = {}): ThreadsAsOfInput => ({
  threads: [{ recordId: 'heir', label: 'the missing heir', origin: 'ai' }],
  claims: [],
  quotes: [],
  reading: READING,
  atId: null,
  ...over
})

describe('threadsAsOf (F-16.23, P2b-D22)', () => {
  const claims = [
    step({ nodeId: 's1', how: 'opens', value: 'Mara swears to find the heir' }),
    step({ nodeId: 's2', how: 'advances', value: 'a letter names the heir' }),
    step({ nodeId: 's4', how: 'resolves', value: 'Mara finds the heir' })
  ]

  it('is not yet before its first step, open after it, resolved after a resolve', () => {
    const at = (atId: string | null): string | undefined =>
      threadsAsOf(input({ claims, atId }))[0]?.status
    expect(threadsAsOf(input({ claims: claims.slice(1), atId: 's1' }))[0]?.status).toBe('notYet')
    expect(at('s1')).toBe('open')
    expect(at('s3')).toBe('open')
    expect(at('s4')).toBe('resolved')
    expect(at(null)).toBe('resolved')
  })

  it('gives where it opened, its last step, where it resolved, its steps and the later count', () => {
    const [thread] = threadsAsOf(input({ claims, atId: 's3' }))
    expect(thread?.opened).toEqual({ nodeId: 's1', ref: '2.1' })
    expect(thread?.last).toEqual({ nodeId: 's2', ref: '2.2' })
    expect(thread?.resolved).toBeNull()
    expect(thread?.steps.map((each) => [each.step, each.ref])).toEqual([
      ['opens', '2.1'],
      ['advances', '2.2']
    ])
    expect(thread?.later).toBe(1)
    const [end] = threadsAsOf(input({ claims }))
    expect(end?.resolved).toEqual({ nodeId: 's4', ref: '2.4' })
  })

  it('reads a resolve and an advance in one scene as resolved, whatever their order', () => {
    const [thread] = threadsAsOf(
      input({
        claims: [
          step({ nodeId: 's1', how: 'opens' }),
          step({ nodeId: 's3', how: 'resolves', para: 1 }),
          step({ nodeId: 's3', how: 'advances', para: 4 })
        ]
      })
    )
    expect(thread?.status).toBe('resolved')
    expect(thread?.steps.map((each) => each.step)).toEqual(['opens', 'advances', 'resolves'])
  })

  it('lists a rumoured or remembered step muted, and never lets it move the status', () => {
    expect(stepCounts({ voice: 'rumour', mode: 'now' })).toBe(false)
    expect(stepCounts({ voice: 'narration', mode: 'memory' })).toBe(false)
    const [thread] = threadsAsOf(
      input({
        claims: [
          step({ nodeId: 's1', how: 'opens' }),
          step({ nodeId: 's2', how: 'resolves', voice: 'rumour' }),
          step({ nodeId: 's3', how: 'resolves', mode: 'memory' })
        ]
      })
    )
    expect(thread?.status).toBe('open')
    expect(thread?.steps.map((each) => [each.step, each.counted])).toEqual([
      ['opens', true],
      ['resolves', false],
      ['resolves', false]
    ])
  })

  it('opens a thread at its verified reveal, before any step', () => {
    const reveal: TopicQuoteInput = {
      id: 'q1',
      recordId: 'heir',
      nodeId: 's2',
      para: 0,
      role: 'defining',
      label: 'the missing heir',
      quote: 'Somewhere an heir was waiting.',
      state: 'live'
    }
    const [thread] = threadsAsOf(input({ quotes: [reveal], atId: 's3' }))
    expect(thread?.status).toBe('open')
    expect(thread?.opened).toEqual({ nodeId: 's2', ref: '2.2' })
    expect(thread?.defining?.quote).toBe('Somewhere an heir was waiting.')
    expect(threadsAsOf(input({ quotes: [reveal], atId: 's1' }))[0]?.status).toBe('notYet')
  })

  it('reads an author’s thread with no step as not yet, and skips waiting, unknown and other lines', () => {
    const [thread] = threadsAsOf(
      input({
        threads: [{ recordId: 'heir', label: 'the missing heir', origin: 'author' }],
        claims: [
          step({ nodeId: 's1', how: 'opens', state: 'waiting' }),
          step({ nodeId: 's1', how: 'closes' }),
          step({ nodeId: 's1', how: 'opens', recordId: 'other' }),
          step({ nodeId: 'idea', how: 'opens' })
        ]
      })
    )
    expect(thread).toMatchObject({ status: 'notYet', opened: null, last: null, steps: [] })
  })
})
