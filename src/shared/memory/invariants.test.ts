import { describe, expect, it } from 'vitest'
import { sceneSentences } from './anchor'
import {
  checkMemoryInvariants,
  type InvariantAlias,
  type InvariantClaim,
  type InvariantFinding,
  type InvariantInput,
  type InvariantKnows,
  type InvariantTopic
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

  it('reports a live claim with an empty anchor, which could otherwise never go stale', () => {
    expect(checkMemoryInvariants(input({ claims: [{ ...CLAIM, anchor: [] }] }))).toEqual([
      { kind: 'anchorEmpty', claimId: 'c1', sceneId: 's1' }
    ])
    // Not reported twice as a missing anchor, and a stale claim may have lost its anchor.
    expect(
      checkMemoryInvariants(input({ claims: [{ ...CLAIM, state: 'stale', anchor: [] }] }))
    ).toEqual([])
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

  it('reports a knows claim about anything but a secret, or learnt by anything but a person or group (P2b)', () => {
    const knows = (over: Partial<InvariantKnows>): InvariantKnows => ({
      claimId: 'k1',
      state: 'live',
      learnerKind: 'character',
      objectKind: 'secret',
      ...over
    })
    expect(
      checkMemoryInvariants(input({ knows: [knows({}), knows({ learnerKind: 'group' })] }))
    ).toEqual([])
    expect(checkMemoryInvariants(input({ knows: [knows({ objectKind: null })] }))).toEqual([
      { kind: 'knowsObject', claimId: 'k1' }
    ])
    expect(checkMemoryInvariants(input({ knows: [knows({ objectKind: 'character' })] }))).toEqual([
      { kind: 'knowsObject', claimId: 'k1' }
    ])
    expect(checkMemoryInvariants(input({ knows: [knows({ learnerKind: 'place' })] }))).toEqual([
      { kind: 'knowsLearner', claimId: 'k1' }
    ])
    // A line waiting on its learner has none yet.
    expect(
      checkMemoryInvariants(input({ knows: [knows({ state: 'waiting', learnerKind: null })] }))
    ).toEqual([])
  })

  it('reports an AI topic nothing backs, and a topic in the name index (P2b)', () => {
    const topic = (over: Partial<InvariantTopic>): InvariantTopic => ({
      recordId: 's1',
      origin: 'ai',
      quotes: 0,
      claims: 0,
      authorTouched: false,
      ...over
    })
    expect(checkMemoryInvariants(input({ topics: [topic({})] }))).toEqual([
      { kind: 'topicEmpty', recordId: 's1' }
    ])
    for (const backed of [
      topic({ quotes: 1 }),
      topic({ claims: 2 }),
      topic({ authorTouched: true }),
      topic({ origin: 'author' })
    ]) {
      expect(checkMemoryInvariants(input({ topics: [backed] }))).toEqual([])
    }
    expect(
      checkMemoryInvariants(
        input({
          indexed: [
            { recordId: 'mara', kind: 'character' },
            { recordId: 't1', kind: 'thread' },
            { recordId: 't1', kind: 'thread' },
            { recordId: 's1', kind: 'secret' }
          ]
        })
      )
    ).toEqual([
      { kind: 'topicName', recordId: 't1' },
      { kind: 'topicName', recordId: 's1' }
    ])
  })
})

describe('finding invariants (P4, F-16.27)', () => {
  const finding = (over: Partial<InvariantFinding> = {}): InvariantFinding => ({
    id: 'f1',
    state: 'open',
    verdictAb: 'c',
    verdictBa: 'c',
    npKey: 'finding|mara|eyes|s1|grey|s2|brown',
    claimSides: [
      { claimId: 'c1', live: true },
      { claimId: 'c2', live: true }
    ],
    ...over
  })

  it('passes an open finding judged a contradiction both ways on live claims', () => {
    expect(checkMemoryInvariants(input({ findings: [finding()] }))).toEqual([])
    expect(
      checkMemoryInvariants(input({ findings: [finding({ state: 'unjudged', verdictAb: null })] }))
    ).toEqual([])
  })

  it('reports an open finding without two contradiction verdicts', () => {
    expect(checkMemoryInvariants(input({ findings: [finding({ verdictBa: 'u' })] }))).toEqual([
      { kind: 'findingUnjudged', findingId: 'f1' }
    ])
  })

  it('reports a stored finding the author said is not a problem', () => {
    const row = finding({ state: 'unjudged', verdictAb: null, verdictBa: null })
    expect(
      checkMemoryInvariants(input({ findings: [row], dismissedFindings: new Set([row.npKey]) }))
    ).toEqual([{ kind: 'findingDismissed', findingId: 'f1' }])
  })

  it('reports an open finding whose claim side is no live claim', () => {
    const row = finding({
      claimSides: [
        { claimId: 'c1', live: true },
        { claimId: 'c9', live: false }
      ]
    })
    expect(checkMemoryInvariants(input({ findings: [row] }))).toEqual([
      { kind: 'findingSide', findingId: 'f1', claimId: 'c9' }
    ])
    // A held one waits for its re-read.
    expect(checkMemoryInvariants(input({ findings: [{ ...row, state: 'held' }] }))).toEqual([])
  })
})
