import { describe, expect, it } from 'vitest'
import { dismissedKey } from './dismissed'

describe('dismissedKey (F-16.10)', () => {
  it('keys a name and an alias by their norm', () => {
    expect(dismissedKey({ kind: 'name', name: ' Hesk’s ' })).toBe('hesk')
    expect(dismissedKey({ kind: 'alias', recordId: 'r1', alias: 'Mr. Ry' })).toBe('r1|mr ry')
  })

  it('keys a Not a mention by the record and the phrase around the span', () => {
    expect(dismissedKey({ kind: 'notMention', recordId: 'will', phrase: 'Will  you' })).toBe(
      'will|will you'
    )
  })

  it('keys a pair one way whichever way round it came', () => {
    expect(dismissedKey({ kind: 'split', a: 'b', b: 'a' })).toBe('a|b')
    expect(dismissedKey({ kind: 'notSame', a: 'a', b: 'b' })).toBe('a|b')
  })

  it('passes the caller’s reference through for the later kinds', () => {
    expect(dismissedKey({ kind: 'unlink', planId: 'p', sceneId: 's' })).toBe('p|s')
    expect(dismissedKey({ kind: 'notProblem', ref: 'x:1' })).toBe('x:1')
  })
})
