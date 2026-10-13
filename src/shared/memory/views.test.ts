import { describe, expect, it } from 'vitest'
import type { ReadingOrder } from './asOf'
import { threadsAsOf } from './threadsAsOf'
import {
  AgeView,
  KnowsGrid,
  MemoryNotice,
  SceneMemory,
  SceneSecrets,
  SheetMemory,
  ThreadMemoryView,
  TimelineRow
} from './views'
import { knowsAsOf, knowsGrid, sceneSecrets } from './whoKnows'
import { recordAge, storyYears } from './years'

const none = { outcome: 'none', typed: null, text: null, quote: null } as const

describe('the reading views (F-16.18)', () => {
  it('parse a scene with no card yet and an empty sheet', () => {
    expect(
      SceneMemory.safeParse({
        nodeId: 'n1',
        ref: '1.1',
        card: null,
        here: [{ recordId: 'mara', why: 'pov', quote: null, p: null, typedPov: null }],
        mentioned: [{ recordId: 'tomas', count: 2 }],
        trueNow: [],
        typed: { pov: none, place: none, time: none, year: none },
        lastRead: null,
        unread: 3,
        paused: null,
        claims: [],
        secrets: { touched: [], tension: [], more: 0, checkedUpTo: null }
      }).success
    ).toBe(true)
    expect(
      SheetMemory.safeParse({
        recordId: 'mara',
        asOf: null,
        asOfRef: null,
        fixed: [],
        lasting: [],
        transient: [],
        accumulating: [],
        others: [],
        later: 0,
        knows: { lines: [], others: [], later: 2 },
        topic: null
      }).success
    ).toBe(true)
  })

  it('tells the notices apart by kind', () => {
    expect(
      MemoryNotice.safeParse({ id: 'b', kind: 'backlog', scenes: 37, priceUsd: 0.03 }).success
    ).toBe(true)
    expect(
      MemoryNotice.safeParse({
        id: 'd',
        kind: 'detailConflict',
        nodeId: 'n1',
        ref: '14.2',
        field: 'place',
        typed: 'the harbour',
        text: 'the quay',
        textRecordId: null,
        quote: 'She walked to the quay'
      }).success
    ).toBe(true)
    expect(
      MemoryNotice.safeParse({ id: 'x', kind: 'backlog', scenes: 0, priceUsd: 0 }).success
    ).toBe(false)
  })
})

describe('the who-knows-what and time views (F-16.22, F-16.23)', () => {
  const reading: ReadingOrder = {
    order: new Map([
      ['a', 0],
      ['b', 1]
    ]),
    at: new Map([
      ['a', 0],
      ['b', 1]
    ]),
    refs: new Map([
      ['a', '1.1'],
      ['b', '1.2']
    ])
  }
  const claim = {
    id: 'k1',
    recordId: 'orrin',
    objectId: 'map',
    how: 'overheard',
    fromId: 'tomas',
    voice: 'narration' as const,
    speakerId: null,
    mode: 'now' as const,
    nodeId: 'a',
    para: 0,
    state: 'live' as const,
    created: 'x'
  }

  it('are what the pure rules answer', () => {
    const knows = knowsAsOf({
      secrets: [{ recordId: 'map', label: 'the sold map', origin: 'ai' }],
      claims: [claim],
      quotes: [],
      knewBefore: [{ secretId: 'map', recordId: 'mara' }],
      reading,
      flags: new Map([['a', { topicsRead: true, settled: true }]]),
      atId: 'b'
    })
    expect(KnowsGrid.parse(knowsGrid(knows, { pov: 'lise', named: new Map() }))).toBeTruthy()
    expect(SceneSecrets.parse(sceneSecrets(knows, 'a', ['lise', 'orrin'], 'lise'))).toBeTruthy()
    for (const thread of threadsAsOf({
      threads: [{ recordId: 't', label: 'the heir', origin: 'author' }],
      claims: [{ ...claim, recordId: 't', how: 'opens', value: 'Mara swears' }],
      quotes: [],
      reading,
      atId: null
    })) {
      expect(ThreadMemoryView.parse(thread)).toBeTruthy()
    }
    const years = storyYears([
      {
        nodeId: 'a',
        ref: '1.1',
        typedYear: 1811,
        quotedYear: null,
        flashback: false,
        elapsed: null
      },
      {
        nodeId: 'b',
        ref: '1.2',
        typedYear: null,
        quotedYear: null,
        flashback: false,
        elapsed: 'A year later'
      }
    ])
    const age = recordAge({
      born: [],
      ages: [
        {
          id: 'g',
          value: 'nineteen',
          voice: 'narration',
          mode: 'now',
          state: 'live',
          nodeId: 'a',
          para: 0
        }
      ],
      pinned: [],
      years,
      reading,
      atId: 'b'
    })
    expect(AgeView.parse(age)).toMatchObject({ kind: 'stated', since: [{ text: 'A year later' }] })
    expect(
      TimelineRow.parse({
        nodeId: 'b',
        ref: '1.2',
        title: 'Two',
        year: years[1]?.year,
        flashback: false,
        elapsed: years[1]?.elapsed,
        time: '',
        ages: age === null ? [] : [{ recordId: 'mara', age }]
      })
    ).toBeTruthy()
  })
})
