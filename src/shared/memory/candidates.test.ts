import { beforeEach, describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import {
  backgroundCandidates,
  candidatesC1,
  candidatesC2Body,
  candidatesC2Dead,
  candidatesC3,
  candidatesC4Birth,
  candidatesC4Falls,
  candidatesC5,
  candidatesC6,
  candidatesC7,
  C7_PAIRS_PER_CLAIM,
  deathWord,
  lifeWord,
  type Candidate,
  type CandidateClaim,
  type CandidateInputs,
  type CandidateRecord,
  type SceneFacts,
  type TypedScene
} from './candidates'
import { valueKey } from './claims'
import type { NoteParagraph } from './noteValues'

const SCENES = Array.from({ length: 12 }, (_, i) => `s${i + 1}`)
const READING: ReadingOrder = {
  order: new Map(SCENES.map((id, i) => [id, i])),
  at: new Map(SCENES.map((id, i) => [id, i])),
  refs: new Map(SCENES.map((id, i) => [id, `1.${i + 1}`]))
}

const record = (
  id: string,
  name: string,
  kind: CandidateRecord['kind'] = 'character'
): CandidateRecord => ({
  id,
  kind,
  name,
  names: [{ text: name, caseRule: 'auto', shared: false }]
})

const RECORDS = new Map<string, CandidateRecord>(
  [
    record('mara', 'Mara'),
    record('tomas', 'Tomas'),
    record('hobb', 'Hobb'),
    record('bel', 'Bel'),
    record('orrin', 'Orrin'),
    record('guild', 'the Guild', 'group'),
    record('secret', 'the sold map', 'secret'),
    record('heir', 'the missing heir', 'thread')
  ].map((each) => [each.id, each])
)

let next = 0
const claim = (
  over: Partial<CandidateClaim> & Pick<CandidateClaim, 'recordId' | 'slot' | 'value' | 'nodeId'>
): CandidateClaim => {
  next += 1
  return {
    id: `c${String(next).padStart(3, '0')}`,
    valueKey: valueKey(over.value),
    objectId: null,
    how: null,
    fromId: null,
    voice: 'narration',
    speakerId: null,
    mode: 'now',
    para: 0,
    state: 'live',
    change: false,
    created: '2026-10-13T00:00:00.000Z',
    quote: 'a quote',
    anchor: [],
    ...over
  }
}

const NO_FACTS: SceneFacts = { present: new Set(), flashback: false, quotedYear: null }

const inputs = (
  over: Partial<CandidateInputs> & { facts?: Record<string, Partial<SceneFacts>> } = {}
): CandidateInputs => {
  const { facts = {}, ...rest } = over
  return {
    reading: READING,
    claims: [],
    onPage: new Map(),
    typed: new Map(),
    scene: (nodeId) => ({ ...NO_FACTS, ...facts[nodeId] }),
    knewBefore: [],
    records: RECORDS,
    notes: [],
    scenes: SCENES.map((nodeId, i) => ({ nodeId, ref: `1.${i + 1}`, title: `Scene ${i + 1}` })),
    dismissed: new Set(),
    ...rest
  }
}

/** A candidate as two "scene:value" sides, for reading assertions. */
const sides = (each: Candidate): string[] =>
  [each.a, each.b].map((side) =>
    side.kind === 'claim'
      ? `${side.nodeId}:${side.valueKey}`
      : side.kind === 'presence'
        ? `${side.nodeId}:here`
        : `note:${side.value}`
  )

beforeEach(() => {
  next = 0
})

describe('C1: two values in a fixed slot (P4-D2)', () => {
  it('groups agreeing values and pairs each other group with the earliest narrated one', () => {
    const found = candidatesC1(
      inputs({
        claims: [
          claim({ recordId: 'mara', slot: 'eyes', value: 'grey', nodeId: 's1' }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'grey-blue', nodeId: 's3' }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'brown', nodeId: 's5' })
        ]
      })
    )
    expect(found.map(sides)).toEqual([['s1:grey', 's5:brown']])
    expect(found[0]).toMatchObject({ rule: 'C1', recordId: 'mara', slot: 'eyes', held: false })
  })

  it('makes k−1 pairs for k disagreeing groups', () => {
    const found = candidatesC1(
      inputs({
        claims: [
          claim({ recordId: 'mara', slot: 'eyes', value: 'grey', nodeId: 's2' }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'brown', nodeId: 's4' }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'green', nodeId: 's6' })
        ]
      })
    )
    expect(found.map(sides)).toEqual([
      ['s2:grey', 's4:brown'],
      ['s2:grey', 's6:green']
    ])
  })

  it('pairs a value in speech against the narration, and never two values in speech alone (P4-D1)', () => {
    const lie = candidatesC1(
      inputs({
        claims: [
          claim({
            recordId: 'mara',
            slot: 'eyes',
            value: 'brown',
            nodeId: 's1',
            voice: 'dialogue',
            speakerId: 'tomas'
          }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'grey', nodeId: 's3' })
        ]
      })
    )
    expect(lie.map(sides)).toEqual([['s1:brown', 's3:grey']])
    expect(
      candidatesC1(
        inputs({
          claims: [
            claim({
              recordId: 'mara',
              slot: 'eyes',
              value: 'brown',
              nodeId: 's1',
              voice: 'dialogue'
            }),
            claim({
              recordId: 'mara',
              slot: 'eyes',
              value: 'grey',
              nodeId: 's3',
              voice: 'dialogue'
            })
          ]
        })
      )
    ).toEqual([])
  })

  it('compares kinship per object, keyed by it', () => {
    const found = candidatesC1(
      inputs({
        claims: [
          claim({
            recordId: 'mara',
            slot: 'kinship',
            value: 'sister',
            objectId: 'tomas',
            nodeId: 's1'
          }),
          claim({
            recordId: 'mara',
            slot: 'kinship',
            value: 'daughter',
            objectId: 'orrin',
            nodeId: 's2'
          }),
          claim({
            recordId: 'mara',
            slot: 'kinship',
            value: 'cousin',
            objectId: 'tomas',
            nodeId: 's3'
          })
        ]
      })
    )
    expect(found.map(sides)).toEqual([['s1:sister', 's3:cousin']])
    expect(found[0]?.slot).toBe('kinship:tomas')
  })

  it('never lets a bridging value merge two that disagree', () => {
    const found = candidatesC1(
      inputs({
        claims: [
          claim({ recordId: 'mara', slot: 'eyes', value: 'grey', nodeId: 's1' }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'grey-blue', nodeId: 's2' }),
          claim({ recordId: 'mara', slot: 'eyes', value: 'blue', nodeId: 's3' })
        ]
      })
    )
    expect(found.map(sides)).toEqual([['s1:grey', 's3:blue']])
  })

  it('pairs kinship to an unnamed relative only under one kin word, and reads named kin by its kin word', () => {
    expect(
      candidatesC1(
        inputs({
          claims: [
            claim({
              recordId: 'mara',
              slot: 'kinship',
              value: 'daughter of a miller',
              nodeId: 's1'
            }),
            claim({ recordId: 'mara', slot: 'kinship', value: 'mother of two boys', nodeId: 's2' }),
            claim({ recordId: 'mara', slot: 'kinship', value: 'a widow', nodeId: 's3' }),
            claim({ recordId: 'mara', slot: 'kinship', value: 'the eldest', nodeId: 's4' })
          ]
        })
      )
    ).toEqual([])
    // Dunmore's lie: the same relation (son), two fathers, one of them in his own speech.
    const lie = candidatesC1(
      inputs({
        claims: [
          claim({
            recordId: 'tomas',
            slot: 'kinship',
            value: 'son of a clergyman in Elsdale',
            voice: 'dialogue',
            speakerId: 'tomas',
            nodeId: 's2'
          }),
          claim({
            recordId: 'tomas',
            slot: 'kinship',
            value: 'son of the late steward at Greyhallow',
            nodeId: 's5'
          })
        ]
      })
    )
    expect(lie.map(sides)).toEqual([
      ['s2:son of a clergyman in elsdale', 's5:son of the late steward at greyhallow']
    ])
    expect(lie[0]?.slot).toBe('kinship')
    expect(
      candidatesC1(
        inputs({
          claims: [
            claim({
              recordId: 'mara',
              slot: 'kinship',
              value: "Tomas's sister",
              objectId: 'tomas',
              nodeId: 's1'
            }),
            claim({
              recordId: 'mara',
              slot: 'kinship',
              value: 'his younger sister',
              objectId: 'tomas',
              nodeId: 's2'
            })
          ]
        })
      )
    ).toEqual([])
  })

  it('leaves lasting slots to the other rules', () => {
    expect(
      candidatesC1(
        inputs({
          claims: [
            claim({ recordId: 'mara', slot: 'hair', value: 'dark', nodeId: 's1' }),
            claim({ recordId: 'mara', slot: 'hair', value: 'fair', nodeId: 's9' })
          ]
        })
      )
    ).toEqual([])
  })
})

describe('C2 dead: a dead character on the page later (P4-D3)', () => {
  const death = (over: Partial<CandidateClaim> = {}): CandidateClaim =>
    claim({ recordId: 'hobb', slot: 'alive', value: 'dead', nodeId: 's2', ...over })
  const onPage = new Map([['s5', new Set(['hobb'])]])
  const present = { s5: { present: new Set(['hobb']) } }

  it('reads a closed list of death words', () => {
    expect(deathWord('dead')).toBe(true)
    expect(deathWord('drowned at sea')).toBe(true)
    expect(deathWord('passed away in the night')).toBe(true)
    expect(deathWord('alive')).toBe(false)
    expect(deathWord('deadly tired')).toBe(false)
    expect(deathWord('had died in the war')).toBe(true)
    // Negated, hedged or qualified: no death.
    expect(deathWord('not dead')).toBe(false)
    expect(deathWord('nearly killed')).toBe(false)
    expect(deathWord('buried alive')).toBe(false)
    expect(deathWord('presumed dead')).toBe(false)
    expect(deathWord('might be dead')).toBe(false)
    expect(deathWord('rumoured dead')).toBe(false)
    expect(lifeWord('alive')).toBe(true)
    expect(lifeWord('presumed dead')).toBe(false)
    expect(lifeWord('not alive')).toBe(false)
  })

  it('never raises a death from a qualified value', () => {
    expect(
      candidatesC2Dead(
        inputs({ claims: [death({ value: 'nearly killed' })], onPage, facts: present })
      )
    ).toEqual([])
  })

  it('is not cancelled by a living value in a flashback, or by a value that is neither', () => {
    const then = claim({ recordId: 'hobb', slot: 'alive', value: 'alive', nodeId: 's4' })
    expect(
      candidatesC2Dead(
        inputs({
          claims: [death(), then],
          onPage,
          facts: { ...present, s4: { flashback: true } }
        })
      ).map(sides)
    ).toEqual([['s2:dead', 's5:here']])
    const unsure = claim({ recordId: 'hobb', slot: 'alive', value: 'presumed dead', nodeId: 's4' })
    expect(
      candidatesC2Dead(inputs({ claims: [death(), unsure], onPage, facts: present })).map(sides)
    ).toEqual([['s2:dead', 's5:here']])
  })

  it('pairs the death with a later presence quoted on the page', () => {
    const found = candidatesC2Dead(inputs({ claims: [death()], onPage, facts: present }))
    expect(found.map(sides)).toEqual([['s2:dead', 's5:here']])
    expect(found[0]).toMatchObject({ rule: 'C2', variant: 'dead', slot: 'alive', hidden: false })
  })

  it('never from a dream, a presence not quoted, or a typed POV alone', () => {
    expect(
      candidatesC2Dead(inputs({ claims: [death({ mode: 'dream' })], onPage, facts: present }))
    ).toEqual([])
    // The card names him but no verified quote stands: no presence.
    expect(candidatesC2Dead(inputs({ claims: [death()], onPage }))).toEqual([])
    expect(
      candidatesC2Dead(
        inputs({
          claims: [death()],
          typed: new Map([['s5', { pov: 'hobb', alsoHere: ['hobb'], year: null, flashback: null }]])
        })
      )
    ).toEqual([])
  })

  it('is cancelled by a later sentence bringing him back', () => {
    const back = claim({ recordId: 'hobb', slot: 'alive', value: 'alive', nodeId: 's4' })
    expect(candidatesC2Dead(inputs({ claims: [death(), back], onPage, facts: present }))).toEqual(
      []
    )
  })

  it('hides it when the later scene is a flashback, and holds it when the death changed', () => {
    const hidden = candidatesC2Dead(
      inputs({
        claims: [death()],
        onPage,
        facts: { s5: { present: new Set(['hobb']), flashback: true } }
      })
    )
    expect(hidden[0]?.hidden).toBe(true)
    const held = candidatesC2Dead(
      inputs({ claims: [death({ state: 'stale' })], onPage, facts: present })
    )
    expect(held[0]?.held).toBe(true)
  })
})

describe('C2 body: hair or scars changed between appearances (P4-D4)', () => {
  const hair = (
    nodeId: string,
    value: string,
    over: Partial<CandidateClaim> = {}
  ): CandidateClaim => claim({ recordId: 'mara', slot: 'hair', value, nodeId, ...over })

  it('pairs two values of consecutive appearances with no change stated', () => {
    const found = candidatesC2Body(inputs({ claims: [hair('s2', 'dark'), hair('s4', 'fair')] }))
    expect(found.map(sides)).toEqual([['s2:dark', 's4:fair']])
    expect(found[0]).toMatchObject({ variant: 'body', slot: 'hair' })
    // Within one scene too.
    expect(
      candidatesC2Body(inputs({ claims: [hair('s2', 'dark'), hair('s2', 'fair', { para: 4 })] }))
    ).toHaveLength(1)
  })

  it('is cancelled by a change claim, or by an appearance between them', () => {
    expect(
      candidatesC2Body(
        inputs({ claims: [hair('s2', 'long'), hair('s4', 'short', { change: true })] })
      )
    ).toEqual([])
    expect(
      candidatesC2Body(
        inputs({
          claims: [hair('s2', 'dark'), hair('s5', 'fair')],
          typed: new Map([['s3', { pov: 'mara', alsoHere: [], year: null, flashback: null }]])
        })
      )
    ).toEqual([])
    expect(
      candidatesC2Body(
        inputs({
          claims: [hair('s2', 'dark'), hair('s5', 'fair')],
          onPage: new Map([['s4', new Set(['mara'])]])
        })
      )
    ).toEqual([])
  })

  it('hides it when either scene is a flashback; agreeing values make none', () => {
    const found = candidatesC2Body(
      inputs({
        claims: [hair('s2', 'dark'), hair('s4', 'fair')],
        facts: { s2: { flashback: true } }
      })
    )
    expect(found[0]?.hidden).toBe(true)
    expect(
      candidatesC2Body(inputs({ claims: [hair('s2', 'dark'), hair('s4', 'dark brown')] }))
    ).toEqual([])
  })
})

describe('C3: passing on a secret before learning it', () => {
  const line = (nodeId: string, how: string, over: Partial<CandidateClaim> = {}): CandidateClaim =>
    claim({ recordId: 'bel', slot: 'knows', value: how, how, objectId: 'secret', nodeId, ...over })

  it('pairs an earliest tells or refers with a later learning line, always two quotes', () => {
    const found = candidatesC3(inputs({ claims: [line('s2', 'tells'), line('s4', 'told')] }))
    expect(found.map(sides)).toEqual([['s2:tells', 's4:told']])
    expect(found[0]).toMatchObject({ rule: 'C3', recordId: 'bel', slot: 'knows:secret' })
  })

  it('needs a later learning line that is not a memory', () => {
    expect(candidatesC3(inputs({ claims: [line('s2', 'tells')] }))).toEqual([])
    expect(
      candidatesC3(
        inputs({ claims: [line('s2', 'tells'), line('s4', 'told', { mode: 'memory' })] })
      )
    ).toEqual([])
    expect(candidatesC3(inputs({ claims: [line('s4', 'told'), line('s6', 'tells')] }))).toEqual([])
  })

  it('hides it when the learning line is in a flashback scene (a memory in story time)', () => {
    const found = candidatesC3(
      inputs({
        claims: [line('s2', 'tells'), line('s4', 'told')],
        facts: { s4: { flashback: true } }
      })
    )
    expect(found.map((each) => each.hidden)).toEqual([true])
    // Only the learning line's scene hides it (`flashbackSides`): a flashback where she tells it
    // leaves the pair to judge (review 2026-10-14).
    expect(
      candidatesC3(
        inputs({
          claims: [line('s2', 'tells'), line('s4', 'told')],
          facts: { s2: { flashback: true } }
        })
      ).map((each) => each.hidden)
    ).toEqual([false])
  })

  it('is skipped when she knew before the book, or her group knew it earlier (P4-D5)', () => {
    const claims = [line('s2', 'tells'), line('s4', 'told')]
    expect(
      candidatesC3(inputs({ claims, knewBefore: [{ secretId: 'secret', recordId: 'bel' }] }))
    ).toEqual([])
    const member = claim({
      recordId: 'bel',
      slot: 'role',
      value: 'a clerk of the Guild',
      nodeId: 's1'
    })
    const guild = claim({
      recordId: 'guild',
      slot: 'knows',
      value: 'saw',
      how: 'saw',
      objectId: 'secret',
      nodeId: 's1'
    })
    expect(candidatesC3(inputs({ claims: [...claims, member, guild] }))).toEqual([])
    // Her group learning it only later skips nothing.
    const later = { ...guild, id: 'late', nodeId: 's8' }
    expect(candidatesC3(inputs({ claims: [...claims, member, later] }))).toHaveLength(1)
    expect(
      candidatesC3(inputs({ claims, knewBefore: [{ secretId: 'secret', recordId: 'guild' }] }))
    ).toHaveLength(1)
  })
})

describe('C4 birth: a stated age against the birth year and that scene’s year (P4-D6)', () => {
  const born = claim({ recordId: 'mara', slot: 'born', value: 'in 1795', nodeId: 's1' })
  const age = (value: string, nodeId = 's6'): CandidateClaim =>
    claim({ recordId: 'mara', slot: 'age', value, nodeId })
  const typed = (year: number, nodeId = 's6'): Map<string, TypedScene> =>
    new Map([[nodeId, { pov: null, alsoHere: [], year, flashback: null }]])

  it('flags an age more than a year off, with the year it used', () => {
    const found = candidatesC4Birth(
      inputs({ claims: [born, age('seventeen')], typed: typed(1815) })
    )
    expect(found.map(sides)).toEqual([['s6:seventeen', 's1:in 1795']])
    expect(found[0]).toMatchObject({
      variant: 'birth',
      slot: 'age',
      extra: { year: { value: 1815, source: 'typed', nodeId: 's6' } }
    })
  })

  it('tolerates a year either way, and never uses a carried year', () => {
    expect(
      candidatesC4Birth(inputs({ claims: [born, age('nineteen')], typed: typed(1815) }))
    ).toEqual([])
    expect(candidatesC4Birth(inputs({ claims: [born, age('21')], typed: typed(1815) }))).toEqual([])
    // A year typed in an earlier scene carries, but C4 never reads a carried year.
    expect(
      candidatesC4Birth(inputs({ claims: [born, age('seventeen')], typed: typed(1815, 's3') }))
    ).toEqual([])
  })

  it('reads a year the scene states, in the same calendar only', () => {
    const quoted = { s6: { quotedYear: 'the spring of 1815' } }
    expect(
      candidatesC4Birth(inputs({ claims: [born, age('seventeen')], facts: quoted }))
    ).toHaveLength(1)
    const other = { s6: { quotedYear: '1815 AR' } }
    expect(candidatesC4Birth(inputs({ claims: [born, age('seventeen')], facts: other }))).toEqual(
      []
    )
  })

  it('reads a Pinned "Born:" line when the book gives no birth year', () => {
    const notes: NoteParagraph[] = [
      { ownerKind: 'record', ownerId: 'mara', page: 'pinned', para: 1, text: 'Born: 1795' }
    ]
    const found = candidatesC4Birth(
      inputs({ claims: [age('seventeen')], typed: typed(1815), notes })
    )
    expect(found[0]?.b).toEqual({
      kind: 'note',
      ownerKind: 'record',
      ownerId: 'mara',
      page: 'pinned',
      para: 1,
      sentence: 0,
      value: '1795',
      datedNodeId: null
    })
  })

  it('never compares an age in months, weeks or days', () => {
    expect(
      candidatesC4Birth(inputs({ claims: [born, age('eighteen months')], typed: typed(1797) }))
    ).toEqual([])
    expect(
      candidatesC4Falls(
        inputs({ claims: [age('six months old', 's2'), age('two years old', 's4')] })
      )
    ).toEqual([])
    expect(
      candidatesC4Falls(inputs({ claims: [age('three', 's2'), age('three weeks old', 's4')] }))
    ).toEqual([])
  })

  it('hides it in a flashback', () => {
    const found = candidatesC4Birth(
      inputs({
        claims: [born, age('seventeen')],
        typed: typed(1815),
        facts: { s6: { flashback: true } }
      })
    )
    expect(found[0]?.hidden).toBe(true)
  })
})

describe('C4 falls: a stated age lower than the one before it', () => {
  const age = (value: string, nodeId: string): CandidateClaim =>
    claim({ recordId: 'mara', slot: 'age', value, nodeId })

  it('pairs a falling age with the age before it', () => {
    const found = candidatesC4Falls(
      inputs({ claims: [age('18', 's2'), age('nineteen', 's4'), age('17', 's6')] })
    )
    expect(found.map(sides)).toEqual([['s4:nineteen', 's6:17']])
    expect(found[0]?.variant).toBe('falls')
  })

  it('hides an age in a flashback, which never becomes the age to beat', () => {
    const found = candidatesC4Falls(
      inputs({
        claims: [age('19', 's2'), age('ten', 's4'), age('20', 's6')],
        facts: { s4: { flashback: true } }
      })
    )
    expect(found.map((each) => [...sides(each), each.hidden])).toEqual([['s2:19', 's4:ten', true]])
  })
})

describe('C5: a thread advancing after it was resolved (P4-D7)', () => {
  const step = (nodeId: string, how: string, over: Partial<CandidateClaim> = {}): CandidateClaim =>
    claim({ recordId: 'heir', slot: 'thread', value: `${how} here`, how, nodeId, ...over })

  it('pairs a resolve with a later advance', () => {
    const found = candidatesC5(
      inputs({ claims: [step('s1', 'opens'), step('s3', 'resolves'), step('s6', 'advances')] })
    )
    expect(found.map(sides)).toEqual([['s3:resolves here', 's6:advances here']])
  })

  it('never in one scene, never after a re-opening, never from a rumour', () => {
    expect(
      candidatesC5(
        inputs({ claims: [step('s3', 'advances'), step('s3', 'resolves', { para: 0 })] })
      )
    ).toEqual([])
    expect(
      candidatesC5(
        inputs({ claims: [step('s3', 'resolves'), step('s4', 'opens'), step('s6', 'advances')] })
      )
    ).toEqual([])
    expect(
      candidatesC5(
        inputs({ claims: [step('s3', 'resolves'), step('s6', 'advances', { voice: 'rumour' })] })
      )
    ).toEqual([])
    // Re-opened in the advancing scene itself, before the advance.
    expect(
      candidatesC5(
        inputs({
          claims: [
            step('s1', 'resolves'),
            step('s2', 'opens', { para: 0 }),
            step('s2', 'advances', { para: 2 })
          ]
        })
      )
    ).toEqual([])
    // An opening after the advance does not excuse it.
    expect(
      candidatesC5(
        inputs({
          claims: [
            step('s1', 'resolves'),
            step('s2', 'advances', { para: 0 }),
            step('s2', 'opens', { para: 2 })
          ]
        })
      )
    ).toHaveLength(1)
  })

  it('hides an advance told in a flashback scene', () => {
    const found = candidatesC5(
      inputs({
        claims: [step('s3', 'resolves'), step('s6', 'advances')],
        facts: { s6: { flashback: true } }
      })
    )
    expect(found.map((each) => each.hidden)).toEqual([true])
    // A resolve told in a flashback hides nothing: only the advance's scene does.
    expect(
      candidatesC5(
        inputs({
          claims: [step('s3', 'resolves'), step('s6', 'advances')],
          facts: { s3: { flashback: true } }
        })
      ).map((each) => each.hidden)
    ).toEqual([false])
  })
})

describe('C6: the book against the author’s notes (P4-D8)', () => {
  const pinned = (ownerId: string, text: string, para = 0): NoteParagraph => ({
    ownerKind: 'record',
    ownerId,
    page: 'pinned',
    para,
    text
  })
  const research = (text: string, para = 0): NoteParagraph => ({
    ownerKind: 'research',
    ownerId: 'doc',
    page: null,
    para,
    text
  })
  const eyes = (value: string, over: Partial<CandidateClaim> = {}): CandidateClaim =>
    claim({ recordId: 'orrin', slot: 'eyes', value, nodeId: 's3', ...over })

  it('pairs a claim with its own sheet’s line, and with a Research sentence naming it', () => {
    const own = candidatesC6(
      inputs({ claims: [eyes('brown')], notes: [pinned('orrin', 'Eyes: green')] })
    )
    expect(own.map(sides)).toEqual([['s3:brown', 'note:green']])
    expect(own[0]).toMatchObject({ rule: 'C6', slot: 'eyes' })
    const elsewhere = candidatesC6(
      inputs({
        claims: [eyes('brown')],
        notes: [research('Orrin has green eyes.')]
      })
    )
    expect(elsewhere.map(sides)).toEqual([['s3:brown', 'note:green']])
  })

  it('makes one finding per value the book gives, not one per scene that repeats it', () => {
    const found = candidatesC6(
      inputs({
        claims: [
          eyes('grey', { nodeId: 's2', voice: 'dialogue' }),
          eyes('grey', { nodeId: 's4' }),
          eyes('grey', { nodeId: 's6' }),
          eyes('brown', { nodeId: 's8' })
        ],
        notes: [pinned('orrin', 'Eyes: blue')]
      })
    )
    // Each value's earliest narration-now claim stands for it.
    expect(found.map(sides)).toEqual([
      ['s4:grey', 'note:blue'],
      ['s8:brown', 'note:blue']
    ])
  })

  it('pairs any voice and mode in the book: the note is the canon side', () => {
    expect(
      candidatesC6(
        inputs({
          claims: [eyes('blue', { mode: 'memory' })],
          notes: [pinned('orrin', 'Eyes: brown')]
        })
      )
    ).toHaveLength(1)
  })

  it('compares nothing it cannot read, nothing that agrees, nothing that names no one', () => {
    const notes = [
      research('Orrin perhaps has green eyes.'),
      research('His eyes are green.'),
      pinned('mara', 'Eyes: green'),
      pinned('orrin', 'Eyes: brown, flecked with gold')
    ]
    expect(candidatesC6(inputs({ claims: [eyes('brown')], notes }))).toEqual([])
  })

  it('reads at most two sentences per claim, its own sheet’s first', () => {
    const notes = [
      research('Orrin has green eyes.', 0),
      research('Orrin has hazel eyes.', 1),
      pinned('orrin', 'Eyes: blue', 2)
    ]
    const found = candidatesC6(inputs({ claims: [eyes('brown')], notes }))
    expect(found.map(sides)).toEqual([
      ['s3:brown', 'note:blue'],
      ['s3:brown', 'note:green']
    ])
  })

  it('compares a state slot only with a dated line naming the claim’s own scene', () => {
    const where = claim({ recordId: 'orrin', slot: 'location', value: 'at the quay', nodeId: 's3' })
    const dated = (scene: string): NoteParagraph =>
      pinned('orrin', `Location (from ${scene}): the harbour`)
    expect(candidatesC6(inputs({ claims: [where], notes: [dated("1.3 'Scene 3'")] }))).toHaveLength(
      1
    )
    expect(candidatesC6(inputs({ claims: [where], notes: [dated("1.4 'Scene 4'")] }))).toEqual([])
    expect(
      candidatesC6(inputs({ claims: [where], notes: [pinned('orrin', 'Location: the harbour')] }))
    ).toEqual([])
    // A note about the future sets no state: never compared.
    const alive = claim({ recordId: 'orrin', slot: 'alive', value: 'alive', nodeId: 's3' })
    expect(
      candidatesC6(inputs({ claims: [alive], notes: [pinned('orrin', 'Dies at Waterloo, 1815.')] }))
    ).toEqual([])
  })

  it('compares kinship only where the note names the object, kin word against kin word', () => {
    const kin = claim({
      recordId: 'orrin',
      slot: 'kinship',
      value: "Tomas's brother",
      objectId: 'tomas',
      nodeId: 's3'
    })
    expect(
      candidatesC6(inputs({ claims: [kin], notes: [research("Orrin is Tomas's cousin.")] }))
    ).toHaveLength(1)
    expect(
      candidatesC6(inputs({ claims: [kin], notes: [research("Orrin is Tomas's brother.")] }))
    ).toEqual([])
    expect(
      candidatesC6(inputs({ claims: [kin], notes: [research('Orrin is a cousin.')] }))
    ).toEqual([])
    // A kin word followed by "of" counts only when the object follows it directly.
    expect(
      candidatesC6(
        inputs({ claims: [kin], notes: [research('Orrin, cousin of Mara and brother of Tomas.')] })
      )
    ).toEqual([])
    expect(
      candidatesC6(
        inputs({
          claims: [kin],
          notes: [research('Orrin, a nephew of the old vicar, met Tomas in Bath.')]
        })
      )
    ).toEqual([])
    expect(
      candidatesC6(inputs({ claims: [kin], notes: [research('Orrin, cousin of Tomas.')] }))
    ).toHaveLength(1)
  })
})

describe('C7: history and details (Check the book only, P4-D9)', () => {
  const history = (
    value: string,
    nodeId: string,
    over: Partial<CandidateClaim> = {}
  ): CandidateClaim => claim({ recordId: 'tomas', slot: 'history', value, nodeId, ...over })

  it('pairs two that share two content words, or one object', () => {
    const found = candidatesC7(
      inputs({
        claims: [
          history('his father was a merchant in Vellmouth', 's2'),
          history('his father was a clergyman in Vellmouth', 's8'),
          history('fought a duel at dawn', 's9')
        ]
      })
    )
    expect(found.map(sides)).toEqual([
      ['s2:his father was a merchant in vellmouth', 's8:his father was a clergyman in vellmouth']
    ])
    const object = candidatesC7(
      inputs({
        claims: [
          history('sold a horse to', 's2', { objectId: 'orrin' }),
          history('bought a ship from', 's5', { objectId: 'orrin' })
        ]
      })
    )
    expect(object).toHaveLength(1)
  })

  it('takes at most five pairs per claim, the nearest first, and none from speech alone', () => {
    const claims = [
      history('the fire at the mill killed three men', 's1'),
      ...Array.from({ length: 8 }, (_, i) =>
        history(`the fire at the mill spared ${i + 2} of them`, `s${i + 2}`, { voice: 'dialogue' })
      )
    ]
    const found = candidatesC7(inputs({ claims }))
    expect(found).toHaveLength(C7_PAIRS_PER_CLAIM)
    expect(found.map((each) => sides(each)[1]?.split(':')[0])).toEqual([
      's2',
      's3',
      's4',
      's5',
      's6'
    ])
  })

  it('is never a background candidate', () => {
    const claims = [
      history('his father was a merchant in Vellmouth', 's2'),
      history('his father was a clergyman in Vellmouth', 's8')
    ]
    expect(backgroundCandidates(inputs({ claims }))).toEqual([])
  })
})

describe('the background set', () => {
  const claims = (): CandidateClaim[] => [
    claim({ recordId: 'mara', slot: 'eyes', value: 'grey', nodeId: 's1' }),
    claim({ recordId: 'mara', slot: 'eyes', value: 'brown', nodeId: 's5' })
  ]

  it('holds a candidate whose side changed since it was read (P4-D13)', () => {
    const [grey, brown] = claims()
    if (grey === undefined || brown === undefined) throw new Error('no claims')
    const found = backgroundCandidates(inputs({ claims: [grey, { ...brown, state: 'stale' }] }))
    expect(found).toHaveLength(1)
    expect(found[0]?.held).toBe(true)
  })

  it('drops what is on the Dismissed list, by its Not a problem key', () => {
    const found = backgroundCandidates(inputs({ claims: claims() }))
    expect(found).toHaveLength(1)
    const key = found[0]?.npKey ?? ''
    expect(backgroundCandidates(inputs({ claims: claims(), dismissed: new Set([key]) }))).toEqual(
      []
    )
  })

  it('lists the rules in RULE_ORDER, each key once', () => {
    const found = backgroundCandidates(
      inputs({
        claims: [
          ...claims(),
          claim({ recordId: 'orrin', slot: 'eyes', value: 'brown', nodeId: 's3' }),
          claim({ recordId: 'mara', slot: 'age', value: '18', nodeId: 's2' }),
          claim({ recordId: 'mara', slot: 'age', value: '16', nodeId: 's7' })
        ],
        notes: [
          { ownerKind: 'record', ownerId: 'orrin', page: 'pinned', para: 0, text: 'Eyes: green' }
        ]
      })
    )
    expect(found.map((each) => each.rule)).toEqual(['C1', 'C6', 'C4'])
    expect(new Set(found.map((each) => each.key)).size).toBe(found.length)
  })
})
