import { describe, expect, it } from 'vitest'
import { dismissedKey, statingKey } from './dismissed'

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

  it('keys a Not right line by record, slot, value key and the quote’s own sentences (F-16.18)', () => {
    const key = dismissedKey({
      kind: 'notRight',
      recordId: 'mara',
      slot: 'eyes',
      value: ' The Grey ',
      stating: ["⟨mara⟩'s eyes were grey."]
    })
    expect(key).toBe(`mara|eyes|grey|${statingKey(["⟨mara⟩'s eyes were grey."])}`)
    // The same value stated by a new sentence is new evidence: another key.
    expect(
      dismissedKey({
        kind: 'notRight',
        recordId: 'mara',
        slot: 'eyes',
        value: 'grey',
        stating: ['her eyes were grey again.']
      })
    ).not.toBe(key)
    // A rename or a merge moves the record tokens in the gate text, never the key.
    expect(statingKey(["⟨mara⟩'s eyes were grey."])).toBe(
      statingKey(["⟨kept|mara⟩'s eyes were grey."])
    )
    expect(statingKey(['a.', 'b.'])).not.toBe(statingKey(['b.', 'a.']))
  })

  it('keys a stale line by its anchor, and a card value by scene, field and value (F-16.18)', () => {
    const stale = dismissedKey({
      kind: 'notRight',
      recordId: 'mara',
      slot: 'eyes',
      value: 'grey',
      anchor: ['h1', 'h2']
    })
    expect(stale.startsWith('mara|eyes|grey|a')).toBe(true)
    // Never the key a fresh item's sentences make.
    expect(stale).not.toBe(
      dismissedKey({ kind: 'notRight', recordId: 'mara', slot: 'eyes', value: 'grey', stating: [] })
    )
    // A record value starts with its record, so a merge re-keys it.
    expect(
      dismissedKey({ kind: 'notRight', card: { nodeId: 'n1', field: 'pov', value: 'mara' } })
    ).toBe('mara|card|n1|pov')
    expect(
      dismissedKey({ kind: 'notRight', card: { nodeId: 'n1', field: 'where', value: 'The Quay' } })
    ).toBe('card|n1|where|quay')
  })

  it('keys an AI topic the author said is not one by its kind and its reveal (P2b-D13)', () => {
    const a = dismissedKey({
      kind: 'notRight',
      topic: { kind: 'secret', stating: ['⟨r1⟩ sold the map'] }
    })
    expect(a).toMatch(/^topic\|secret\|/)
    // Names fold, so a rename never moves it; the kind keeps a secret and a thread apart.
    expect(
      dismissedKey({ kind: 'notRight', topic: { kind: 'secret', stating: ['⟨r9⟩ sold the map'] } })
    ).toBe(a)
    expect(
      dismissedKey({ kind: 'notRight', topic: { kind: 'thread', stating: ['⟨r1⟩ sold the map'] } })
    ).not.toBe(a)
  })

  it('keys a knows line under its learner with the secret in the slot (P2b-D6)', () => {
    expect(
      dismissedKey({
        kind: 'notRight',
        recordId: 'orrin',
        slot: 'knows:s1',
        value: 'overheard',
        stating: ['⟨r2⟩ overheard ⟨r3⟩']
      })
    ).toMatch(/^orrin\|knows:s1\|overheard\|/)
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
