import { describe, expect, it } from 'vitest'
import { Card, Claim, emptyCardFields, emptyYields, Reading, setsState, valueKey } from './claims'

describe('valueKey (F-16.17)', () => {
  it('folds case, quotes, spaces, outer punctuation and a leading article', () => {
    expect(valueKey('  The   Quay. ')).toBe('quay')
    expect(valueKey('“grey-blue”')).toBe('grey-blue')
    expect(valueKey('An  old  map')).toBe('old map')
    expect(valueKey('Theodora')).toBe('theodora')
    expect(valueKey('Café')).toBe(valueKey('Café'))
  })
})

describe('setsState', () => {
  it('lets narration in now mode set state, and nothing else', () => {
    expect(setsState({ voice: 'narration', mode: 'now' })).toBe(true)
    expect(setsState({ voice: 'dialogue', mode: 'now' })).toBe(false)
    expect(setsState({ voice: 'rumour', mode: 'now' })).toBe(false)
    expect(setsState({ voice: 'narration', mode: 'dream' })).toBe(false)
    expect(setsState({ voice: 'narration', mode: 'memory' })).toBe(false)
  })
})

describe('the schemas', () => {
  it('parse a claim, a card and a reading', () => {
    expect(
      Claim.safeParse({
        id: 'c1',
        nodeId: 'n1',
        draftId: 'd1',
        readingId: null,
        recordId: null,
        pending: { kind: 'name', norm: 'hesk', text: 'Hesk' },
        subjectText: 'Hesk',
        slot: 'eyes',
        value: 'grey',
        valueKey: 'grey',
        objectId: null,
        how: null,
        fromId: null,
        voice: 'narration',
        speakerId: null,
        mode: 'now',
        quote: "Hesk's eyes were grey",
        para: 0,
        anchor: ['abc'],
        proof: 'literal',
        change: false,
        state: 'waiting',
        spot: null,
        spotTier: null,
        spotAt: null,
        created: 'x',
        proved: 'x'
      }).success
    ).toBe(true)
    expect(
      Card.safeParse({
        nodeId: 'n1',
        draftId: 'd1',
        readingId: null,
        line: 'Mara waits at the quay.',
        gist: 'A gist.',
        fields: emptyCardFields(),
        present: [{ recordId: 'r1', quote: 'Mara set down the lamp', p: 2, verified: true }],
        mood: null,
        theme: null,
        anchor: [],
        lineHash: null,
        created: 'x'
      }).success
    ).toBe(true)
    expect(
      Reading.safeParse({
        id: 'g1',
        nodeId: 'n1',
        draftId: 'd1',
        purpose: 'window',
        pages: 1,
        paras: [[0, 4]],
        promptVersion: 'reader.v1',
        verifyVersion: 'verify.v1',
        model: 'm',
        tokensIn: 1,
        tokensOut: 1,
        reasoningTokens: 0,
        costUsd: 0.0009,
        cloud: false,
        finishReason: null,
        yields: emptyYields(),
        created: 'x'
      }).success
    ).toBe(true)
  })

  it('refuses a claim with a slot off the list or an unknown proof', () => {
    const base = { slot: 'mood', proof: 'guessed' }
    expect(Claim.shape.slot.safeParse(base.slot).success).toBe(false)
    expect(Claim.shape.proof.safeParse(base.proof).success).toBe(false)
  })
})
