import { describe, expect, it } from 'vitest'
import { dismissedKey } from './dismissed'
import {
  containsValue,
  reconcile,
  type FreshClaim,
  type ReconcileInput,
  type StoredClaim
} from './reconcile'

const PRESENT = new Set(['h1', 'h2', 'h3', 'h4'])

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
  voice: 'narration',
  speakerId: null,
  mode: 'now',
  quote: "Mara's eyes were grey",
  para: 1,
  anchor: ['h1', 'h2'],
  proof: 'literal',
  change: false,
  ...over
})

const input = (over: Partial<ReconcileInput>): ReconcileInput => ({
  stored: [],
  window: { paras: new Set([0, 1, 2]), full: false },
  present: PRESENT,
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
          stored({ id: 'c3', state: 'stale', para: 9 })
        ],
        same: ['c1', 'c2', 'c3']
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
      anchor: ['h1', 'h2']
    })
    const result = reconcile(
      input({
        fresh: [fresh(), fresh({ anchor: ['h3'], quote: 'Her eyes were grey' })],
        dismissed: new Set([key])
      })
    )
    expect(result.dismissed).toBe(1)
    expect(result.inserts.map((item) => item.anchor)).toEqual([['h3']])
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
})
