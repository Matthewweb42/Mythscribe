import { describe, expect, it } from 'vitest'
import { dismissedKey, rekeyFinding } from './dismissed'
import {
  Finding,
  FindingSide,
  findingKey,
  findingState,
  flashbackSides,
  hidingScenes,
  npKey,
  raisesAlone,
  RULE_ORDER,
  sideAt,
  verdictOf,
  type FindingSide as Side
} from './findings'

const claim = (claimId: string, nodeId: string, valueKey: string): Side => ({
  kind: 'claim',
  claimId,
  nodeId,
  valueKey,
  seen: 'seen'
})

const note: Side = {
  kind: 'note',
  ownerKind: 'record',
  ownerId: 'orrin',
  page: 'pinned',
  para: 2,
  sentence: 0,
  value: 'Green',
  datedNodeId: null
}

describe('findings vocabulary (F-16.27)', () => {
  it('lists the rules in the underline and list priority: fixed values, notes, then the rest', () => {
    expect(RULE_ORDER).toEqual(['C1', 'C6', 'C2', 'C3', 'C4', 'C5', 'C7'])
  })

  it('places a side by its scene, or by its note owner', () => {
    expect(sideAt(claim('c1', 's1', 'grey'))).toBe('s1')
    expect(sideAt({ kind: 'presence', nodeId: 's9', recordId: 'hobb' })).toBe('s9')
    expect(sideAt(note)).toBe('note:record:orrin')
    expect(sideAt({ ...note, ownerKind: 'research', ownerId: 'doc1', page: null })).toBe(
      'note:research:doc1'
    )
  })

  it('keys Not a problem by record, slot and both sides, whichever came first (P4-D14)', () => {
    const a = claim('c1', 's1', 'grey')
    const b = claim('c2', 's9', 'brown')
    const key = npKey('mara', 'eyes', a, b)
    expect(key).toBe('finding|mara|eyes|s1|grey|s9|brown')
    expect(npKey('mara', 'eyes', b, a)).toBe(key)
    // The claim ids are not in it: a re-read claim keeps the finding.
    expect(npKey('mara', 'eyes', claim('c7', 's1', 'grey'), claim('c8', 's9', 'brown'))).toBe(key)
    expect(npKey('orrin', 'eyes', claim('c3', 's2', 'brown'), note)).toBe(
      'finding|orrin|eyes|note:record:orrin|green|s2|brown'
    )
    expect(
      dismissedKey({
        kind: 'notProblem',
        finding: {
          recordId: 'mara',
          slot: 'eyes',
          a: { at: 's9', value: 'Brown' },
          b: { at: 's1', value: 'grey' }
        }
      })
    ).toBe(key)
  })

  it('keys a finding by its rule and variant over its Not a problem key', () => {
    expect(findingKey('C1', null, 'finding|x')).toBe('C1|finding|x')
    expect(findingKey('C2', 'dead', 'finding|x')).toBe('C2:dead|finding|x')
  })

  it('reads two verdicts: both c open, any ok fine, a missing order unjudged, else unclear (P4-D10)', () => {
    expect(verdictOf('c', 'c')).toBe('open')
    expect(verdictOf('c', 'ok')).toBe('fine')
    expect(verdictOf('ok', null)).toBe('fine')
    expect(verdictOf('u', 'ok')).toBe('fine')
    expect(verdictOf('c', null)).toBe('unjudged')
    expect(verdictOf(null, null)).toBe('unjudged')
    expect(verdictOf('c', 'u')).toBe('unclear')
    expect(verdictOf('u', 'u')).toBe('unclear')
  })

  it('holds or hides before the verdicts, and lets the stronger check clear or blur an open one', () => {
    const base = {
      held: false,
      hidden: false,
      verdictAb: 'c',
      verdictBa: 'c',
      confirm: null
    } as const
    expect(findingState(base)).toBe('open')
    expect(findingState({ ...base, held: true })).toBe('held')
    expect(findingState({ ...base, hidden: true })).toBe('hidden')
    expect(findingState({ ...base, confirm: 'ok' })).toBe('fine')
    expect(findingState({ ...base, confirm: 'u' })).toBe('unclear')
    expect(findingState({ ...base, confirm: 'c' })).toBe('open')
    expect(findingState({ ...base, verdictBa: null })).toBe('unjudged')
  })

  it('lets only narration in now mode raise C1, C2 or C6 on its own (P4-D1)', () => {
    expect(raisesAlone({ voice: 'narration', mode: 'now' })).toBe(true)
    expect(raisesAlone({ voice: 'dialogue', mode: 'now' })).toBe(false)
    expect(raisesAlone({ voice: 'narration', mode: 'memory' })).toBe(false)
  })

  it('parses its sides and rows, and refuses an unknown side', () => {
    expect(FindingSide.parse(note)).toEqual(note)
    expect(FindingSide.safeParse({ kind: 'year', nodeId: 's1' }).success).toBe(false)
    const row = {
      id: 'f1',
      draftId: 'd1',
      rule: 'C1',
      variant: null,
      recordId: 'mara',
      slot: 'eyes',
      key: 'C1|k',
      npKey: 'k',
      a: claim('c1', 's1', 'grey'),
      b: claim('c2', 's9', 'brown'),
      extra: null,
      verdictAb: null,
      verdictBa: null,
      why: null,
      confirm: null,
      confirmWhy: null,
      state: 'unjudged',
      costUsd: 0,
      shownAt: null,
      created: 'x',
      judgedAt: null,
      confirmedAt: null,
      rendered: { inputs: 'stamp', keys: { ab: 'k-ab', ba: 'k-ba' } }
    }
    expect(Finding.parse(row)).toEqual(row)
  })
})

describe('Not a problem keys for findings and loose ends (F-16.27, F-16.29)', () => {
  it('keys a loose end by what it is and where it was last touched', () => {
    expect(
      dismissedKey({ kind: 'notProblem', loose: { kind: 'thread', id: 't1', lastNodeId: 's7' } })
    ).toBe('loose|thread|t1|s7')
    expect(
      dismissedKey({ kind: 'notProblem', loose: { kind: 'planned', id: 'p1', lastNodeId: null } })
    ).toBe('loose|planned|p1|')
  })

  it('never lets a value break the key apart', () => {
    const key = dismissedKey({
      kind: 'notProblem',
      finding: {
        recordId: 'mara',
        slot: 'eyes',
        a: { at: 's1', value: 'grey|blue' },
        b: { at: 's2', value: 'brown' }
      }
    })
    expect(key.split('|')).toHaveLength(7)
  })

  it('moves a finding key to the kept record on Same as…, the sides sorted again', () => {
    expect(rekeyFinding('finding|old|eyes|s1|grey|s9|brown', 'old', 'kept')).toBe(
      'finding|kept|eyes|s1|grey|s9|brown'
    )
    expect(rekeyFinding('finding|bel|knows:old|s1|tells|s2|told', 'old', 'kept')).toBe(
      'finding|bel|knows:kept|s1|tells|s2|told'
    )
    expect(rekeyFinding('finding|old|eyes|note:record:old|green|s2|brown', 'old', 'kept')).toBe(
      'finding|kept|eyes|note:record:kept|green|s2|brown'
    )
    expect(rekeyFinding('finding|anne|kinship:old|s1|sister|s2|cousin', 'old', 'kept')).toBe(
      'finding|anne|kinship:kept|s1|sister|s2|cousin'
    )
    expect(rekeyFinding('loose|thread|old|s1', 'old', 'kept')).toBeNull()
  })
})

describe('the sides a flashback hides (review 2026-10-14)', () => {
  it('names each rule’s own sides: C2 dead B, C2 body both, C3 B, C4 birth A, C4 falls B, C5 B', () => {
    expect(flashbackSides('C2', 'dead')).toEqual(['b'])
    expect(flashbackSides('C2', 'body')).toEqual(['a', 'b'])
    expect(flashbackSides('C3', null)).toEqual(['b'])
    expect(flashbackSides('C4', 'birth')).toEqual(['a'])
    expect(flashbackSides('C4', 'falls')).toEqual(['b'])
    expect(flashbackSides('C5', null)).toEqual(['b'])
    for (const rule of ['C1', 'C6', 'C7'] as const) expect(flashbackSides(rule, null)).toEqual([])
  })

  it('answers the flashback scenes among them, each once, never a note', () => {
    const a = claim('c1', 's2', 'tells')
    const b = claim('c2', 's5', 'told')
    const both = (): boolean => true
    // A C3 pair with both scenes flashbacks is hidden by the learning line's scene alone.
    expect(hidingScenes('C3', null, a, b, both)).toEqual(['s5'])
    expect(hidingScenes('C3', null, a, b, (nodeId) => nodeId === 's2')).toEqual([])
    expect(hidingScenes('C2', 'body', a, b, both)).toEqual(['s2', 's5'])
    expect(hidingScenes('C2', 'body', a, claim('c3', 's2', 'x'), both)).toEqual(['s2'])
    expect(hidingScenes('C4', 'birth', a, note, both)).toEqual(['s2'])
    expect(hidingScenes('C1', null, a, b, both)).toEqual([])
  })
})
