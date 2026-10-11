import { describe, expect, it } from 'vitest'
import { sceneSentences } from './anchor'
import {
  checkMemoryInvariants,
  type InvariantAlias,
  type InvariantClaim,
  type InvariantInput
} from './invariants'

const SCENE = ['Mara climbed the ridge. Her eyes were grey.', 'Tomas waited below.']
const SENTENCES = sceneSentences(SCENE)
const PRESENT = new Set(SENTENCES.map((sentence) => sentence.hash))

const CLAIM: InvariantClaim = {
  id: 'c1',
  sceneId: 's1',
  source: 'scene',
  state: 'live',
  proof: 'literal',
  anchor: SENTENCES.slice(0, 3).map((sentence) => sentence.hash)
}

const ALIASES: InvariantAlias[] = [
  { recordId: 'mara', norm: 'mara', shared: false },
  { recordId: 'tomas', norm: 'tomas', shared: false },
  { recordId: 'mr-vell', norm: 'vell', shared: true },
  { recordId: 'mrs-vell', norm: 'vell', shared: true }
]

function input(over: Partial<InvariantInput> = {}): InvariantInput {
  return {
    claims: [CLAIM],
    sceneHashes: new Map([['s1', PRESENT]]),
    aliases: ALIASES,
    citations: [{ answerId: 'a1', target: 'passage', ref: 's1:0' }],
    ...over
  }
}

describe('checkMemoryInvariants (F-16.3)', () => {
  it('reports nothing for a clean memory', () => {
    expect(checkMemoryInvariants(input())).toEqual([])
    // A stale or waiting claim may have lost its sentences; only live ones must hold.
    expect(
      checkMemoryInvariants(
        input({ claims: [{ ...CLAIM, state: 'stale', anchor: ['00000000000000'] }] })
      )
    ).toEqual([])
  })

  it('reports a live claim whose anchor sentences are gone', () => {
    expect(
      checkMemoryInvariants(input({ claims: [{ ...CLAIM, anchor: ['00000000000000'] }] }))
    ).toEqual([
      { kind: 'anchorMissing', claimId: 'c1', sceneId: 's1', missing: ['00000000000000'] }
    ])
    // A scene with no hashes at all (deleted) breaks every live anchor in it.
    expect(checkMemoryInvariants(input({ sceneHashes: new Map() }))[0]).toMatchObject({
      kind: 'anchorMissing'
    })
  })

  it('reports a claim that is neither literal nor verified', () => {
    expect(checkMemoryInvariants(input({ claims: [{ ...CLAIM, proof: 'guessed' }] }))).toEqual([
      { kind: 'unproved', claimId: 'c1', proof: 'guessed' }
    ])
    expect(checkMemoryInvariants(input({ claims: [{ ...CLAIM, proof: 'verified' }] }))).toEqual([])
  })

  it('reports one norm belonging to two records unless every alias of it is shared', () => {
    expect(
      checkMemoryInvariants(
        input({ aliases: [...ALIASES, { recordId: 'mara-two', norm: 'mara', shared: false }] })
      )
    ).toEqual([{ kind: 'aliasClash', norm: 'mara', recordIds: ['mara', 'mara-two'] }])
    expect(
      checkMemoryInvariants(
        input({ aliases: [...ALIASES, { recordId: 'vell-boy', norm: 'vell', shared: false }] })
      )
    ).toEqual([
      { kind: 'aliasClash', norm: 'vell', recordIds: ['mr-vell', 'mrs-vell', 'vell-boy'] }
    ])
    // Two aliases of one record with the same norm are not a clash.
    expect(
      checkMemoryInvariants(
        input({ aliases: [...ALIASES, { recordId: 'mara', norm: 'mara', shared: false }] })
      )
    ).toEqual([])
  })

  it('reports a claim from anything but a manuscript scene', () => {
    for (const source of ['try', 'chat', 'inactiveDraft', 'ideaScene', 'notCanon'] as const) {
      expect(checkMemoryInvariants(input({ claims: [{ ...CLAIM, source }] }))).toEqual([
        { kind: 'unreadableSource', claimId: 'c1', source }
      ])
    }
  })

  it('reports an answer that cites a card', () => {
    expect(
      checkMemoryInvariants(
        input({ citations: [{ answerId: 'a2', target: 'card', ref: 'card:s1' }] })
      )
    ).toEqual([{ kind: 'citesCard', answerId: 'a2', ref: 'card:s1' }])
  })
})
