import { describe, expect, it } from 'vitest'
import { sceneSentences } from './anchor'
import { anchorKey, dismissedKey } from './dismissed'

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

  it('keys a Not right line by record, slot, value key and the sentences it rested on (F-16.18)', () => {
    const [a, b] = sceneSentences(["Mara's eyes were grey.", 'Her eyes were grey again.']).map(
      (sentence) => sentence.hash
    )
    const key = dismissedKey({
      kind: 'notRight',
      recordId: 'mara',
      slot: 'eyes',
      value: ' The Grey ',
      anchor: [a ?? '']
    })
    expect(key).toBe(`mara|eyes|grey|${anchorKey([a ?? ''])}`)
    // The same value stated by a new sentence is new evidence: another key.
    expect(
      dismissedKey({
        kind: 'notRight',
        recordId: 'mara',
        slot: 'eyes',
        value: 'grey',
        anchor: [b ?? '']
      })
    ).not.toBe(key)
    expect(anchorKey(['x', 'y'])).not.toBe(anchorKey(['y', 'x']))
  })

  it('keys a kept typed detail by scene, field and the text’s value (decision 4)', () => {
    expect(
      dismissedKey({
        kind: 'notProblem',
        detail: { nodeId: 'n1', field: 'place', value: 'The Quay' }
      })
    ).toBe('detail|n1|place|quay')
  })
})
