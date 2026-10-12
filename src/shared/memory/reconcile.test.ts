import { describe, expect, it } from 'vitest'
import { dismissedKey } from './dismissed'
import {
  containsValue,
  notRightLine,
  reconcile,
  type FreshClaim,
  type ReconcileInput,
  type StoredClaim
} from './reconcile'

const HASHES = ['h1', 'h2', 'h3', 'h4']

const stored = (over: Partial<StoredClaim> & { id: string }): StoredClaim => ({
  recordId: 'mara',
  pending: null,
  subjectText: 'Mara',
  slot: 'eyes',
  valueKey: 'grey',
  voice: 'narration',
  mode: 'now',
  speakerId: null,
  objectId: null,
  how: null,
  state: 'live',
  quote: "Mara's eyes were grey",
  para: 1,
  anchor: ['h1', 'h2'],
  ...over
})

const fresh = (over: Partial<FreshClaim> = {}): FreshClaim => ({
  recordId: 'mara',
  pending: null,
  subjectText: 'Mara',
  slot: 'eyes',
  value: 'grey',
  valueKey: 'grey',
  objectId: null,
  how: null,
  fromId: null,
  topicQuoteId: null,
  voice: 'narration',
  speakerId: null,
  mode: 'now',
  quote: "Mara's eyes were grey",
  para: 1,
  anchor: ['h1', 'h2'],
  stating: ["⟨mara⟩'s eyes were grey."],
  proof: 'literal',
  change: false,
  ...over
})

const input = (over: Partial<ReconcileInput>): ReconcileInput => ({
  stored: [],
  window: { paras: new Set([0, 1, 2]), full: false },
  hashes: HASHES,
  same: [],
  drop: [],
  rejected: new Set(),
  fresh: [],
  dismissed: new Set(),
  ...over
})

describe('reconcile (F-16.17, design §2.3 Reconciliation)', () => {
  it('inserts what is new and skips what is already stored with the same quote', () => {
    const result = reconcile(
      input({
        stored: [stored({ id: 'c1' })],
        fresh: [
          fresh(),
          fresh({ slot: 'hair', value: 'red', valueKey: 'red', quote: "Mara's hair was red" })
        ]
      })
    )
    expect(result.inserts.map((item) => item.slot)).toEqual(['hair'])
    expect(result.deletes).toEqual([])
  })

  it('counts same only for a live claim whose anchor holds', () => {
    const result = reconcile(
      input({
        stored: [
          stored({ id: 'c1' }),
          stored({ id: 'c2', anchor: ['h1', 'gone'] }),
          stored({ id: 'c3', state: 'stale', para: 9 }),
          // Its sentences are all there, but no longer side by side.
          stored({ id: 'c4', anchor: ['h1', 'h3'] })
        ],
        same: ['c1', 'c2', 'c3', 'c4']
      })
    )
    expect(result.kept).toEqual(['c1'])
  })

  it('revives a stale claim only through a fresh item, which brings its own quote and anchor', () => {
    const result = reconcile(
      input({
        stored: [stored({ id: 'c1', state: 'stale', anchor: ['old'] })],
        fresh: [fresh({ quote: 'Her eyes were grey', anchor: ['h3'], proof: 'verified', para: 2 })]
      })
    )
    expect(result.revivals).toEqual([
      { id: 'c1', quote: 'Her eyes were grey', para: 2, anchor: ['h3'], proof: 'verified' }
    ])
    expect(result.inserts).toEqual([])
    expect(result.deletes).toEqual([])
  })

  it('never revives a waiting claim, nor swallows a fresh item about other candidates', () => {
    const wait = stored({
      id: 'w1',
      state: 'waiting',
      recordId: null,
      subjectText: null,
      pending: { kind: 'subject', candidates: ['a', 'b'] },
      quote: 'her eyes were grey',
      para: 2
    })
    const other = fresh({
      recordId: null,
      subjectText: null,
      pending: { kind: 'subject', candidates: ['c', 'd'] },
      quote: 'her eyes were grey too',
      para: 7,
      anchor: ['h9']
    })
    const result = reconcile(input({ stored: [wait], fresh: [other] }))
    expect(result.revivals).toEqual([])
    expect(result.inserts).toEqual([other])
    // A stale claim with no record is never brought back live either.
    const orphan = stored({ id: 'o1', state: 'stale', recordId: null, pending: null, para: 9 })
    const fromOrphan = reconcile(
      input({ stored: [orphan], fresh: [fresh({ recordId: null, subjectText: null })] })
    )
    expect(fromOrphan.revivals).toEqual([])
  })

  it('keeps a waiting claim a fresh item states again word for word, without a second row', () => {
    const wait = stored({
      id: 'w1',
      state: 'waiting',
      recordId: null,
      subjectText: null,
      pending: { kind: 'subject', candidates: ['b', 'a'] },
      quote: 'her eyes were grey'
    })
    const again = fresh({
      recordId: null,
      subjectText: null,
      pending: { kind: 'subject', candidates: ['a', 'b'] },
      quote: 'her eyes were grey'
    })
    const result = reconcile(
      input({ stored: [wait], fresh: [again], window: { paras: new Set(), full: true } })
    )
    expect(result.inserts).toEqual([])
    expect(result.deletes).toEqual([])
  })

  it('drops only a stale claim or one whose current quote the verifier rejected', () => {
    const result = reconcile(
      input({
        stored: [
          stored({ id: 'live' }),
          stored({ id: 'stale', state: 'stale', para: 9 }),
          stored({ id: 'rejected', slot: 'hair', valueKey: 'red' })
        ],
        drop: ['live', 'stale', 'rejected'],
        rejected: new Set(['rejected']),
        window: { paras: new Set([5]), full: false }
      })
    )
    expect(result.deletes.sort()).toEqual(['rejected', 'stale'])
  })

  it('merges by containment within one reading only, keeping the longer value', () => {
    const result = reconcile(
      input({
        fresh: [
          fresh({ value: 'grey', valueKey: 'grey', quote: 'a' }),
          fresh({ value: 'grey-blue', valueKey: 'grey-blue', quote: 'b' }),
          fresh({ value: 'brown', valueKey: 'brown', quote: 'c' })
        ]
      })
    )
    expect(result.merged).toBe(1)
    expect(result.inserts.map((item) => item.valueKey)).toEqual(['grey-blue', 'brown'])
    expect(containsValue('grey-blue', 'grey')).toBe(true)
    expect(containsValue('greyish', 'grey')).toBe(false)
  })

  it('keeps values side by side across scenes: a stored value never merges with a fresh one', () => {
    const result = reconcile(
      input({
        stored: [stored({ id: 'c1', valueKey: 'grey', quote: 'elsewhere' })],
        fresh: [fresh({ value: 'grey-blue', valueKey: 'grey-blue' })]
      })
    )
    expect(result.inserts.map((item) => item.valueKey)).toEqual(['grey-blue'])
    expect(result.deletes).toEqual([])
  })

  it('drops a fresh item whose key is on the Dismissed list', () => {
    const key = dismissedKey({
      kind: 'notRight',
      recordId: 'mara',
      slot: 'eyes',
      value: 'grey',
      stating: ["⟨mara⟩'s eyes were grey."]
    })
    const result = reconcile(
      input({
        fresh: [
          // The same sentence with new neighbours (a new anchor) is still the dismissed line.
          fresh({ anchor: ['h2', 'h3'] }),
          fresh({ anchor: ['h3'], quote: 'Her eyes were grey', stating: ['her eyes were grey.'] })
        ],
        dismissed: new Set([key])
      })
    )
    expect(result.dismissed).toBe(1)
    expect(result.inserts.map((item) => item.anchor)).toEqual([['h3']])
  })

  it('stores a dismissed fresh item for the record Not about moved it to, and keeps the moved line on a rebuild', () => {
    const key = dismissedKey({
      kind: 'notRight',
      recordId: 'mara',
      slot: 'eyes',
      value: 'grey',
      stating: ["⟨mara⟩'s eyes were grey."]
    })
    const moved = stored({ id: 'moved', recordId: 'ella', subjectText: 'Mara' })
    const result = reconcile(
      input({
        stored: [moved],
        window: { paras: new Set([1]), full: true, replace: true },
        fresh: [fresh()],
        dismissed: new Set([key]),
        movedTo: new Map([[key, 'ella']])
      })
    )
    // Stated again for Ella: the moved line is kept as it is, nothing new, nothing dropped.
    expect(result).toMatchObject({ inserts: [], deletes: [], dismissed: 0 })
    // With the moved line gone, the fresh item is stored for Ella, never for Mara.
    const fresh2 = reconcile(
      input({ fresh: [fresh()], dismissed: new Set([key]), movedTo: new Map([[key, 'ella']]) })
    )
    expect(fresh2.inserts.map((item) => [item.recordId, item.pending])).toEqual([['ella', null]])
  })

  it('deletes a stale claim inside the window read that nothing revived (P2a-D23)', () => {
    const result = reconcile(
      input({
        stored: [
          stored({ id: 'inside', state: 'stale', para: 1 }),
          stored({ id: 'outside', state: 'stale', para: 7 })
        ],
        window: { paras: new Set([0, 1, 2]), full: false }
      })
    )
    expect(result.deletes).toEqual(['inside'])
  })

  it('deletes on a full read every stale and pronoun-waiting claim it did not revive', () => {
    const result = reconcile(
      input({
        stored: [
          stored({ id: 'stale', state: 'stale', para: 7 }),
          stored({
            id: 'pronoun',
            state: 'waiting',
            recordId: null,
            subjectText: null,
            pending: { kind: 'subject', candidates: ['a', 'b'] }
          }),
          stored({
            id: 'shared',
            state: 'waiting',
            recordId: null,
            subjectText: 'Harrow',
            pending: { kind: 'subject', candidates: ['a', 'b'] }
          }),
          stored({
            id: 'name',
            state: 'waiting',
            recordId: null,
            pending: { kind: 'name', norm: 'hesk', text: 'Hesk' }
          })
        ],
        window: { paras: new Set(), full: true }
      })
    )
    expect(result.deletes.sort()).toEqual(['pronoun', 'stale'])
  })

  it('replaces on a rebuild read every claim it did not state, revive or confirm (P2a-D25)', () => {
    const result = reconcile(
      input({
        stored: [
          stored({ id: 'restated' }),
          stored({ id: 'confirmed', slot: 'hair', valueKey: 'red', quote: "Mara's hair was red" }),
          stored({ id: 'unproved', slot: 'age', valueKey: '30', quote: 'Mara was thirty' }),
          stored({
            id: 'shared',
            state: 'waiting',
            recordId: null,
            subjectText: 'Harrow',
            pending: { kind: 'subject', candidates: ['a', 'b'] }
          }),
          stored({
            id: 'name',
            state: 'waiting',
            recordId: null,
            pending: { kind: 'name', norm: 'hesk', text: 'Hesk' }
          })
        ],
        fresh: [fresh()],
        same: ['confirmed'],
        window: { paras: new Set([0, 1, 2]), full: true, replace: true }
      })
    )
    expect(result.deletes).toEqual(['unproved'])
    expect(result.inserts).toEqual([])
  })
})

describe('knows lines in reconciliation (P2b)', () => {
  const knows = (over: Partial<FreshClaim> = {}): FreshClaim =>
    fresh({
      recordId: 'bel',
      subjectText: 'Bel',
      slot: 'knows',
      value: 'tells',
      valueKey: 'tells',
      objectId: 'engagement',
      how: 'tells',
      quote: 'Lottie is to marry Mr. Dunmore',
      ...over
    })

  it('keeps two lines of one sentence apart when their hows differ', () => {
    const result = reconcile(
      input({
        fresh: [
          knows(),
          knows({
            recordId: 'clara',
            subjectText: 'Clara',
            value: 'told',
            valueKey: 'told',
            how: 'told',
            fromId: 'bel'
          }),
          knows({ how: 'refers', value: 'refers', valueKey: 'refers' })
        ]
      })
    )
    expect(result.inserts.map((item) => [item.recordId, item.how])).toEqual([
      ['bel', 'tells'],
      ['clara', 'told'],
      ['bel', 'refers']
    ])
  })

  it('restates a stored knows line only when its how matches', () => {
    const result = reconcile(
      input({
        stored: [
          stored({
            id: 'k1',
            recordId: 'bel',
            subjectText: 'Bel',
            slot: 'knows',
            valueKey: 'tells',
            objectId: 'engagement',
            how: 'tells',
            quote: 'Lottie is to marry Mr. Dunmore'
          })
        ],
        fresh: [knows(), knows({ how: 'refers', value: 'refers', valueKey: 'refers' })]
      })
    )
    expect(result.inserts.map((item) => item.how)).toEqual(['refers'])
  })

  it('drops a knows line the author said is not right, keyed by its secret and how', () => {
    expect(
      notRightLine({ recordId: 'bel', slot: 'knows', value: 'tells', objectId: 's1', how: 'tells' })
    ).toEqual({
      slot: 'knows:s1',
      value: 'tells'
    })
    expect(
      notRightLine({
        recordId: 't1',
        slot: 'thread',
        value: 'he comes back',
        objectId: null,
        how: 'resolves'
      })
    ).toEqual({ slot: 'thread:t1', value: 'resolves' })
    expect(
      notRightLine({ recordId: 'mara', slot: 'eyes', value: 'grey', objectId: null, how: null })
    ).toEqual({
      slot: 'eyes',
      value: 'grey'
    })
    const stating = ['⟨r1⟩ is to marry ⟨r2⟩']
    const key = dismissedKey({
      kind: 'notRight',
      recordId: 'bel',
      slot: 'knows:engagement',
      value: 'tells',
      stating
    })
    const result = reconcile(
      input({
        fresh: [
          knows({ stating }),
          knows({ stating, how: 'refers', value: 'refers', valueKey: 'refers' })
        ],
        dismissed: new Set([key])
      })
    )
    expect(result.dismissed).toBe(1)
    expect(result.inserts.map((item) => item.how)).toEqual(['refers'])
  })
})
