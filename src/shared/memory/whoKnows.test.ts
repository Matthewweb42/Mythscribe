import { describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import {
  checkedUpTo,
  knowsAsOf,
  knowsGrid,
  readersSince,
  sceneSecrets,
  type KnowsAsOfInput,
  type KnowsClaim,
  type SceneFlags,
  type TopicQuoteInput
} from './whoKnows'

const SCENES = ['s1', 's2', 's3', 's4', 's5']
/** s1–s5 are readable; `idea` (an Idea scene between s2 and s3) reads as of s2. */
const READING: ReadingOrder = {
  order: new Map(SCENES.map((id, i) => [id, i])),
  at: new Map([...SCENES.map((id, i): [string, number] => [id, i]), ['idea', 1]]),
  refs: new Map([...SCENES.map((id, i): [string, string] => [id, `1.${i + 1}`]), ['idea', 'Idea']])
}

let next = 0
const knows = (over: Partial<KnowsClaim> & { nodeId: string; recordId: string }): KnowsClaim => {
  next += 1
  return {
    id: `k${String(next).padStart(3, '0')}`,
    objectId: 'map',
    how: 'saw',
    fromId: null,
    voice: 'narration',
    speakerId: null,
    mode: 'now',
    para: 0,
    state: 'live',
    created: '2026-10-12T00:00:00.000Z',
    ...over
  }
}

const reveal = (over: Partial<TopicQuoteInput> & { nodeId: string }): TopicQuoteInput => ({
  id: `q-${over.nodeId}-${over.role ?? 'defining'}`,
  recordId: 'map',
  para: 0,
  role: 'defining',
  label: 'the sold map',
  quote: 'Tomas sold the map.',
  state: 'live',
  ...over
})

const ALL_CHECKED = new Map<string, SceneFlags>(
  SCENES.map((id) => [id, { topicsRead: true, settled: true }])
)

const input = (over: Partial<KnowsAsOfInput> = {}): KnowsAsOfInput => ({
  secrets: [{ recordId: 'map', label: 'the sold map', origin: 'ai' }],
  claims: [],
  quotes: [],
  knewBefore: [],
  reading: READING,
  flags: ALL_CHECKED,
  atId: null,
  ...over
})

describe('checkedUpTo (P2b-D9)', () => {
  it('reaches the scene asked about when every scene up to it is checked', () => {
    expect(checkedUpTo(READING, ALL_CHECKED, 's4')).toEqual({ nodeId: 's4', ref: '1.4' })
    expect(checkedUpTo(READING, ALL_CHECKED, null)).toEqual({ nodeId: 's5', ref: '1.5' })
  })

  it('stops before the first gap, and is null when the first scene is not checked', () => {
    const gap = new Map(ALL_CHECKED)
    gap.set('s3', { topicsRead: true, settled: false })
    expect(checkedUpTo(READING, gap, 's5')).toEqual({ nodeId: 's2', ref: '1.2' })
    const first = new Map(ALL_CHECKED)
    first.delete('s1')
    expect(checkedUpTo(READING, first, 's5')).toBeNull()
  })

  it('counts a scene read only by the first reader as not checked', () => {
    const v1 = new Map(ALL_CHECKED)
    v1.set('s2', { topicsRead: false, settled: true })
    expect(checkedUpTo(READING, v1, 's5')).toEqual({ nodeId: 's1', ref: '1.1' })
  })

  it('skips an Idea scene (it is not in the reading order) and reads it as of the scene before', () => {
    expect(checkedUpTo(READING, ALL_CHECKED, 'idea')).toEqual({ nodeId: 's2', ref: '1.2' })
  })
})

describe('readersSince (P2b-D7)', () => {
  it('is the earliest reveal or counted line, never a suspicion', () => {
    const claims = [
      knows({ nodeId: 's1', recordId: 'johanna', how: 'suspects' }),
      knows({ nodeId: 's3', recordId: 'orrin', how: 'overheard', fromId: 'tomas' })
    ]
    expect(readersSince('map', claims, [], READING)).toEqual({ nodeId: 's3', ref: '1.3' })
    expect(readersSince('map', claims, [reveal({ nodeId: 's2' })], READING)).toEqual({
      nodeId: 's2',
      ref: '1.2'
    })
  })

  it('ignores rumours, dreams, waiting lines and other secrets; null when nothing shows it', () => {
    const claims = [
      knows({ nodeId: 's1', recordId: 'lise', voice: 'rumour' }),
      knows({ nodeId: 's1', recordId: 'lise', mode: 'dream' }),
      knows({ nodeId: 's1', recordId: 'lise', state: 'waiting' }),
      knows({ nodeId: 's1', recordId: 'lise', objectId: 'debts' })
    ]
    expect(readersSince('map', claims, [], READING)).toBeNull()
  })
})

describe('knowsAsOf (F-16.22)', () => {
  const claims = [
    knows({ nodeId: 's1', recordId: 'tomas', how: 'knewBefore' }),
    knows({ nodeId: 's2', recordId: 'johanna', how: 'suspects' }),
    knows({ nodeId: 's3', recordId: 'orrin', how: 'overheard', fromId: 'tomas' }),
    knows({ nodeId: 's4', recordId: 'johanna', how: 'told', fromId: 'orrin' }),
    knows({ nodeId: 's5', recordId: 'mara', how: 'deduced' }),
    knows({
      nodeId: 's2',
      recordId: 'lise',
      how: 'told',
      voice: 'rumour'
    })
  ]

  it('gives each knower’s strongest line as of the scene, later ones flagged, others apart', () => {
    const view = knowsAsOf(input({ claims, quotes: [reveal({ nodeId: 's1' })], atId: 's3' }))
    const [secret] = view.secrets
    expect(view.asOfRef).toBe('1.3')
    expect(view.checkedUpTo).toEqual({ nodeId: 's3', ref: '1.3' })
    expect(secret?.readersSince).toEqual({ nodeId: 's1', ref: '1.1' })
    expect(secret?.known).toBe(true)
    expect(secret?.defining?.quote).toBe('Tomas sold the map.')
    expect(
      secret?.cells.map((cell) => [cell.knowerId, cell.how, cell.line, cell.ref, cell.later])
    ).toEqual([
      ['tomas', 'knewBefore', 'counts', '1.1', false],
      ['johanna', 'suspects', 'partial', '1.2', false],
      ['orrin', 'overheard', 'counts', '1.3', false],
      ['mara', 'deduced', 'counts', '1.5', true]
    ])
    expect(secret?.others.map((cell) => [cell.knowerId, cell.voice])).toEqual([['lise', 'rumour']])
  })

  it('lets a counted line win over an earlier suspicion once the scene is past it', () => {
    const view = knowsAsOf(input({ claims, atId: 's4' }))
    const johanna = view.secrets[0]?.cells.find((cell) => cell.knowerId === 'johanna')
    expect([johanna?.how, johanna?.fromId, johanna?.ref]).toEqual(['told', 'orrin', '1.4'])
  })

  it('puts the author’s knew-before first, and never makes a "doesn\'t know" cell', () => {
    const view = knowsAsOf(
      input({ claims, knewBefore: [{ secretId: 'map', recordId: 'mara' }], atId: 's2' })
    )
    const [secret] = view.secrets
    expect(secret?.cells[0]).toMatchObject({
      knowerId: 'mara',
      source: 'author',
      how: 'knewBefore',
      ref: null
    })
    expect(secret?.knewBefore).toEqual(['mara'])
    // Orrin learns later; nobody else has a cell at all.
    expect(secret?.cells.map((cell) => cell.knowerId).sort()).toEqual(
      ['johanna', 'mara', 'orrin', 'tomas'].sort()
    )
    expect(JSON.stringify(view)).not.toMatch(/doesn.?t know|does not know|unknown/i)
  })

  it('reads a secret readers learn after the scene as not known yet', () => {
    const view = knowsAsOf(
      input({ claims: [knows({ nodeId: 's4', recordId: 'orrin' })], atId: 's2' })
    )
    expect(view.secrets[0]?.known).toBe(false)
    expect(view.secrets[0]?.readersSince?.ref).toBe('1.4')
  })

  it('orders secrets newest reveal first, unrevealed last', () => {
    const view = knowsAsOf(
      input({
        secrets: [
          { recordId: 'map', label: 'the sold map', origin: 'ai' },
          { recordId: 'debts', label: 'the Captain’s debts', origin: 'ai' },
          { recordId: 'cousin', label: 'the cousin', origin: 'author' }
        ],
        quotes: [reveal({ nodeId: 's1' }), reveal({ nodeId: 's3', recordId: 'debts' })]
      })
    )
    expect(view.secrets.map((secret) => secret.recordId)).toEqual(['debts', 'map', 'cousin'])
  })

  it('lists merged reveals apart from the defining one', () => {
    const view = knowsAsOf(
      input({
        quotes: [
          reveal({ nodeId: 's3', role: 'merged', label: 'the map sale' }),
          reveal({ nodeId: 's1' })
        ]
      })
    )
    expect(view.secrets[0]?.defining?.ref).toBe('1.1')
    expect(view.secrets[0]?.merged.map((quote) => [quote.label, quote.ref])).toEqual([
      ['the map sale', '1.3']
    ])
  })
})

describe('knowsGrid (P2b-D20)', () => {
  it('rows the known secrets (and the author’s unrevealed ones), counts later ones, orders columns', () => {
    const view = knowsAsOf(
      input({
        secrets: [
          { recordId: 'map', label: 'the sold map', origin: 'ai' },
          { recordId: 'debts', label: 'the debts', origin: 'ai' },
          { recordId: 'cousin', label: 'the cousin', origin: 'author' }
        ],
        claims: [
          knows({ nodeId: 's1', recordId: 'tomas', how: 'knewBefore' }),
          knows({ nodeId: 's2', recordId: 'orrin', how: 'overheard', fromId: 'tomas' }),
          knows({ nodeId: 's5', recordId: 'lise', how: 'deduced', objectId: 'debts' })
        ],
        atId: 's3'
      })
    )
    const grid = knowsGrid(view, {
      pov: 'mara',
      named: new Map([
        ['orrin', 9],
        ['tomas', 4]
      ])
    })
    expect(grid.rows.map((row) => row.recordId)).toEqual(['map', 'cousin'])
    expect(grid.later).toBe(1)
    expect(grid.columns).toEqual(['orrin', 'tomas', 'mara'])
    expect(grid.checkedUpTo?.ref).toBe('1.3')
  })
})

describe('sceneSecrets (P2b-D21)', () => {
  const claims = [
    knows({ nodeId: 's1', recordId: 'tomas', how: 'knewBefore' }),
    knows({ nodeId: 's1', recordId: 'orrin', how: 'overheard', fromId: 'tomas' }),
    knows({ nodeId: 's2', recordId: 'orrin', how: 'tells', objectId: 'debts' }),
    knows({ nodeId: 's2', recordId: 'lise', how: 'told', fromId: 'orrin', objectId: 'debts' })
  ]
  const secrets = [
    { recordId: 'map', label: 'the sold map', origin: 'ai' as const },
    { recordId: 'debts', label: 'the debts', origin: 'ai' as const },
    { recordId: 'heir', label: 'the heir', origin: 'ai' as const }
  ]
  const quotes = [reveal({ nodeId: 's1' }), reveal({ nodeId: 's1', recordId: 'heir' })]

  it('shows the secrets touched here, with the Here characters that have no counted line', () => {
    const view = knowsAsOf(input({ secrets, claims, quotes, atId: 's1' }))
    const scene = sceneSecrets(view, 's1', ['mara', 'orrin', 'tomas'], 'mara')
    expect(scene.touched.map((each) => each.secret.recordId).sort()).toEqual(['heir', 'map'])
    expect(scene.touched.find((each) => each.secret.recordId === 'map')?.without).toEqual(['mara'])
    expect(scene.checkedUpTo?.ref).toBe('1.1')
  })

  it('puts the POV’s tension lines first, caps them at 3, and counts the grid’s other rows', () => {
    const view = knowsAsOf(input({ secrets, claims, quotes, atId: 's2' }))
    const scene = sceneSecrets(view, 's2', ['mara', 'lise', 'orrin'], 'mara')
    expect(scene.touched.map((each) => each.secret.recordId)).toEqual(['debts'])
    expect(scene.tension.length).toBe(3)
    expect(scene.tension.slice(0, 3).every((line) => line.kind === 'readersKnow')).toBe(true)
    expect(scene.tension[0]).toEqual({ kind: 'readersKnow', secretId: 'debts', recordId: 'mara' })
    expect(scene.more).toBe(2)
  })

  it('names someone Here who holds it and another Here who has none', () => {
    const view = knowsAsOf(input({ secrets: secrets.slice(0, 1), claims, quotes, atId: 's2' }))
    const scene = sceneSecrets(view, 's2', ['lise', 'orrin'], null)
    expect(scene.tension).toEqual([
      { kind: 'hereKnows', secretId: 'map', holderId: 'orrin', recordId: 'lise' }
    ])
  })

  it('has no tension when the POV and everyone Here hold it, and the author’s mark counts', () => {
    const view = knowsAsOf(
      input({
        secrets: secrets.slice(0, 1),
        claims,
        quotes,
        knewBefore: [{ secretId: 'map', recordId: 'mara' }],
        atId: 's2'
      })
    )
    expect(sceneSecrets(view, 's2', ['mara', 'orrin', 'tomas'], 'mara').tension).toEqual([])
  })

  it('is empty when the scene touches nothing and nobody lacks anything', () => {
    const view = knowsAsOf(input({ secrets: [], atId: 's3' }))
    expect(sceneSecrets(view, 's3', ['mara'], 'mara')).toEqual({
      touched: [],
      tension: [],
      more: 0,
      checkedUpTo: { nodeId: 's3', ref: '1.3' }
    })
  })
})
