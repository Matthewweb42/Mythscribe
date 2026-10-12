import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneSentences } from '@shared/memory/anchor'
import { dismissedKey } from '@shared/memory/dismissed'
import { gateSentences, nextReadSet } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { knowsAsOf } from '@shared/memory/whoKnows'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId } from '../../draft/draftStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { projectNameWords } from '../../spellcheck/projectWords'
import { createNode, deleteNode, getNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { dismiss, getDismissedByKey } from '../dismissedStore'
import { invariantIndexed, listNameMentions, scanNamesFor } from '../nameIndexer'
import {
  createRecord,
  deleteRecord,
  invariantAliases,
  pruneTopics,
  requireRecord,
  sameAs,
  savePage,
  splitRecord,
  updateRecord
} from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { runAnchors } from './anchors'
import { noteLateNames } from './backfill'
import { revealIn, sceneTexts, seedClaims } from './claimFixture'
import { getClaim, invariantClaims, invariantKnows, slotClaims } from './claimStore'
import { listKnewBefore, setKnewBefore } from './knewBeforeStore'
import { readerRoster, ROSTER_RECORD_TOKENS } from './rosterCache'
import { getSceneRead, sceneReadFlags, setSceneSettled, writeSceneRead } from './sceneReadStore'
import {
  createTopic,
  deleteTopicEvidence,
  getTopicQuote,
  insertTopicQuote,
  invariantTopics,
  listTopicQuotes,
  listTopics,
  mergeInto,
  recordTopicQuotes,
  sceneTopicQuotes,
  splitTopic
} from './topicStore'
import { readingOrder } from './views'

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let mara: string
let orrin: string
let tomas: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))
const LATER = new Date(Date.UTC(2026, 9, 12, 13, 0, 0))
const LATEST = new Date(Date.UTC(2026, 9, 12, 14, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const SCENE_ONE = [
  'Mara watched from the stair.',
  'Tomas sold the map to a stranger.',
  'Orrin overheard Tomas from the yard.',
  'Mara swore to find the heir.'
]
const SCENE_TWO = ['The map had been sold by Tomas.', 'Mara found the heir at last.']

function character(name: string): string {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** Every memory invariant, P2b's included, over the stored memory and the scenes now. */
function invariants(): ReturnType<typeof checkMemoryInvariants> {
  const scenes = new Map(
    manuscriptDocuments(db).map((row) => [
      row.id,
      new Set(sceneSentences(sceneTexts(db, row.id)).map((sentence) => sentence.hash))
    ])
  )
  return checkMemoryInvariants({
    claims: invariantClaims(db),
    sceneHashes: scenes,
    aliases: invariantAliases(db),
    citations: [],
    knows: invariantKnows(db),
    topics: invariantTopics(db),
    indexed: invariantIndexed(db)
  })
}

/** The secret "the sold map", made from its reveal in scene one. */
function soldMap(): { recordId: string; topicQuoteId: string } {
  return createTopic(
    db,
    {
      kind: 'secret',
      label: 'the sold map',
      quote: revealIn(db, one, { para: 1, quote: 'Tomas sold the map', label: 'the sold map' })
    },
    NOW
  )
}

/** Orrin overheard it from Tomas, and Tomas knew it before (knows lines in scene one). */
function knowsLines(secretId: string): { orrin: string; tomas: string } {
  const [heard, knew] = seedClaims(
    db,
    one,
    [
      {
        recordId: orrin,
        slot: 'knows',
        value: 'overheard',
        how: 'overheard',
        fromId: tomas,
        objectId: secretId,
        quote: 'Orrin overheard Tomas',
        para: 2,
        proof: 'verified'
      },
      {
        recordId: tomas,
        slot: 'knows',
        value: 'knewBefore',
        how: 'knewBefore',
        objectId: secretId,
        quote: 'Tomas sold the map',
        para: 1,
        proof: 'verified'
      }
    ],
    NOW
  )
  return { orrin: heard ?? '', tomas: knew ?? '' }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-topics-'))
  session = createProject(projectFolderFor(tmp, 'Topics'), 'Topics', 'novel', {
    storyMemoryOverride: 'v2'
  })
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  two = createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  saveDocument(db, one, doc(...SCENE_ONE))
  saveDocument(db, two, doc(...SCENE_TWO))
  mara = character('Mara')
  orrin = character('Orrin')
  tomas = character('Tomas')
  scanNamesFor(db, one, NOW)
  scanNamesFor(db, two, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createTopic (F-16.22, P2b-D1, D3)', () => {
  it('makes an AI secret in its own category, with its label and its defining reveal', () => {
    const { recordId, topicQuoteId } = soldMap()
    const secret = requireRecord(db, recordId)
    expect(secret).toMatchObject({
      categoryId: 'secret',
      kind: 'secret',
      origin: 'ai',
      name: 'the sold map'
    })
    expect(getTopicQuote(db, topicQuoteId)).toMatchObject({
      recordId,
      role: 'defining',
      label: 'the sold map',
      quote: 'Tomas sold the map',
      para: 1,
      state: 'live',
      draftId: activeDraftId(db)
    })
    expect(getTopicQuote(db, topicQuoteId)?.stating[0]).toMatch(/sold the map/)
    expect(listTopics(db).map((topic) => [topic.kind, topic.label])).toEqual([
      ['secret', 'the sold map']
    ])
    expect(invariants()).toEqual([])
  })

  it('adds the kind, then the scene, to a label another record holds', () => {
    const quote = revealIn(db, one, { para: 1, quote: 'Tomas sold the map', label: 'Tomas' })
    const first = createTopic(db, { kind: 'secret', label: 'Tomas', quote }, NOW)
    expect(requireRecord(db, first.recordId).name).toBe('Tomas (secret)')
    const second = createTopic(db, { kind: 'secret', label: 'Tomas', quote, ref: () => '1.1' }, NOW)
    expect(requireRecord(db, second.recordId).name).toBe('Tomas (secret, 1.1)')
    expect(invariants()).toEqual([])
  })

  it('makes no mention, no spellcheck word and no back-fill: a topic is not a name (P2b-D2)', () => {
    const quote = revealIn(db, one, { para: 1, quote: 'Tomas sold the map', label: 'Stranger' })
    const { recordId } = createTopic(db, { kind: 'secret', label: 'Stranger', quote }, NOW)
    saveDocument(db, two, doc('A Stranger came. The Stranger left.', ...SCENE_TWO))
    scanNamesFor(db, two, NOW)
    expect(listNameMentions(db, two).some((mention) => mention.recordId === recordId)).toBe(false)
    expect(projectNameWords(db, 'v2')).not.toContain('Stranger')
    expect(projectNameWords(db, 'v2')).toContain('Tomas')
    expect(noteLateNames(db, recordId, ['Stranger'], NOW)).toEqual([])
    expect(invariants()).toEqual([])
  })
})

describe('the author’s secrets and threads (P2b-D1, D19)', () => {
  it('makes a secret with no twin gate, warns on an exact duplicate, and adds the kind when forced', () => {
    const made = createRecord(db, { name: 'Orrin', categoryId: 'secret' }, NOW)
    if (!('record' in made)) throw new Error('blocked')
    expect(made.record).toMatchObject({ name: 'Orrin (secret)', kind: 'secret', origin: 'author' })
    const first = createRecord(db, { name: 'The cellar key', categoryId: 'secret' }, NOW)
    expect('record' in first).toBe(true)
    const twin = createRecord(db, { name: 'the cellar key', categoryId: 'secret' }, NOW)
    expect(twin).toMatchObject({ gate: { outcome: 'blocked', rule: 'alias' } })
    const forced = createRecord(
      db,
      { name: 'the cellar key', categoryId: 'secret', force: true },
      NOW
    )
    expect('record' in forced && forced.record.name).toBe('the cellar key (secret)')
    // A thread may share a secret's label: kinds are apart.
    const thread = createRecord(db, { name: 'The cellar key', categoryId: 'thread' }, NOW)
    expect('record' in thread && thread.record.name).toBe('The cellar key (thread)')
    expect(() =>
      createRecord(db, { name: 'The heir', categoryId: 'thread', aliases: [{ text: 'heir' }] }, NOW)
    ).toThrow(/one label/)
    expect(invariants()).toEqual([])
  })

  it('keeps a topic’s category fixed and splits it by reveal only', () => {
    const { recordId } = soldMap()
    expect(() => updateRecord(db, recordId, { categoryId: 'character' }, NOW)).toThrow(
      /own category/
    )
    expect(() => updateRecord(db, mara, { categoryId: 'secret' }, NOW)).toThrow(/own category/)
    expect(() => updateRecord(db, mara, { categoryId: 'thread' }, NOW)).toThrow(/own category/)
    const alias = requireRecord(db, recordId).aliases[0]?.id ?? ''
    expect(() => splitRecord(db, recordId, [alias], null, NOW)).toThrow(/by its reveals/)
  })
})

describe('mergeInto and splitTopic (P2b-D4, D5)', () => {
  it('stores a reveal judged the same as merged, moves its claims tagged, and Split undoes it', () => {
    const map = soldMap()
    const lines = knowsLines(map.recordId)
    // The second reading read "the map sale" in scene two, with Mara learning it there.
    const [maraLine] = seedClaims(
      db,
      two,
      [
        {
          recordId: mara,
          slot: 'knows',
          value: 'saw',
          how: 'saw',
          objectId: map.recordId,
          quote: 'The map had been sold by Tomas',
          para: 0,
          proof: 'verified'
        }
      ],
      NOW
    )
    const merged = mergeInto(
      db,
      map.recordId,
      revealIn(db, two, {
        para: 0,
        quote: 'The map had been sold by Tomas',
        label: 'the map sale'
      }),
      [maraLine ?? ''],
      NOW
    )
    expect(getTopicQuote(db, merged)).toMatchObject({
      recordId: map.recordId,
      role: 'merged',
      label: 'the map sale'
    })
    expect(getClaim(db, maraLine ?? '')).toMatchObject({
      objectId: map.recordId,
      topicQuoteId: merged
    })
    expect(listTopics(db)).toHaveLength(1)
    expect(invariants()).toEqual([])

    const { recordId: split } = splitTopic(db, merged, NOW)
    expect(requireRecord(db, split)).toMatchObject({
      kind: 'secret',
      origin: 'ai',
      name: 'the map sale'
    })
    expect(getTopicQuote(db, merged)).toMatchObject({ recordId: split, role: 'defining' })
    expect(getClaim(db, maraLine ?? '')).toMatchObject({ objectId: split, topicQuoteId: null })
    // The untagged lines stay with the first secret.
    expect(getClaim(db, lines.orrin)?.objectId).toBe(map.recordId)
    expect(
      getDismissedByKey(db, 'split', dismissedKey({ kind: 'split', a: map.recordId, b: split }))
    ).not.toBeNull()
    expect(() => splitTopic(db, map.topicQuoteId, NOW)).toThrow(/merged into another/)
    expect(invariants()).toEqual([])
  })

  it('moves a thread’s tagged steps by their record', () => {
    const heir = createTopic(
      db,
      {
        kind: 'thread',
        label: 'the missing heir',
        quote: revealIn(db, one, {
          para: 3,
          quote: 'Mara swore to find the heir',
          label: 'the heir'
        })
      },
      NOW
    )
    const [step] = seedClaims(
      db,
      two,
      [
        {
          recordId: heir.recordId,
          slot: 'thread',
          value: 'Mara finds the heir',
          how: 'resolves',
          quote: 'Mara found the heir at last',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    const merged = mergeInto(
      db,
      heir.recordId,
      revealIn(db, two, { para: 1, quote: 'Mara found the heir at last', label: 'the found heir' }),
      [step ?? ''],
      NOW
    )
    const { recordId } = splitTopic(db, merged, NOW)
    expect(getClaim(db, step ?? '')).toMatchObject({ recordId, topicQuoteId: null })
    expect(invariants()).toEqual([])
  })
})

describe('pruneTopics and deleting (P2b-D12)', () => {
  it('deletes an AI topic nothing backs, and keeps one the author touched', () => {
    const map = soldMap()
    const other = createTopic(
      db,
      {
        kind: 'secret',
        label: 'the stranger',
        quote: revealIn(db, one, { para: 1, quote: 'sold the map to a stranger', label: 'x' })
      },
      NOW
    )
    const kept = createTopic(
      db,
      {
        kind: 'thread',
        label: 'the heir',
        quote: revealIn(db, one, { para: 3, quote: 'Mara swore to find the heir', label: 'x' })
      },
      NOW
    )
    expect(pruneTopics(db)).toEqual([])
    deleteTopicEvidence(db, map.recordId)
    deleteTopicEvidence(db, other.recordId)
    deleteTopicEvidence(db, kept.recordId)
    setKnewBefore(db, other.recordId, mara, true, NOW)
    savePage(db, kept.recordId, 'pinned', doc('My own note on the heir.'), NOW)
    expect(invariants()).toEqual([{ kind: 'topicEmpty', recordId: map.recordId }])
    expect(pruneTopics(db)).toEqual([map.recordId])
    expect(
      listTopics(db)
        .map((topic) => topic.recordId)
        .sort()
    ).toEqual([other.recordId, kept.recordId].sort())
    // The author's own topic is never pruned.
    const own = createRecord(db, { name: 'The vow', categoryId: 'thread' }, NOW)
    expect('record' in own).toBe(true)
    expect(pruneTopics(db)).toEqual([])
    expect(invariants()).toEqual([])
  })

  it('deletes a secret with the knows lines about it and its knew-before marks: no orphans', () => {
    const map = soldMap()
    knowsLines(map.recordId)
    setKnewBefore(db, map.recordId, mara, true, NOW)
    deleteRecord(db, map.recordId)
    expect(slotClaims(db, 'knows', activeDraftId(db))).toEqual([])
    expect(listKnewBefore(db)).toEqual([])
    expect(listTopicQuotes(db, activeDraftId(db))).toEqual([])
    expect(invariants()).toEqual([])
  })

  it('takes a deleted learner’s lines, and prunes a topic only they backed', () => {
    const map = soldMap()
    knowsLines(map.recordId)
    deleteRecord(db, orrin)
    expect(slotClaims(db, 'knows', activeDraftId(db)).map((line) => line.recordId)).toEqual([tomas])
    expect(invariants()).toEqual([])
    // A topic with no reveal left, backed only by a learner who goes, goes too.
    deleteTopicEvidence(db, map.recordId)
    seedClaims(
      db,
      one,
      [
        {
          recordId: tomas,
          slot: 'knows',
          value: 'knewBefore',
          how: 'knewBefore',
          objectId: map.recordId,
          quote: 'Tomas sold the map',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    expect(listTopics(db)).toHaveLength(1)
    deleteRecord(db, tomas)
    expect(listTopics(db)).toEqual([])
    expect(slotClaims(db, 'knows', activeDraftId(db))).toEqual([])
    expect(invariants()).toEqual([])
  })

  it('prunes on a scene deleted with the only reveal', () => {
    const map = soldMap()
    deleteNode(db, one)
    expect(pruneTopics(db)).toEqual([map.recordId])
  })
})

describe('Same as… with topics (P2b, F-16.4)', () => {
  it('merges two secrets: lines, reveals, knew-before (twins dropped) and Not right keys follow', () => {
    const map = soldMap()
    const sale = createTopic(
      db,
      {
        kind: 'secret',
        label: 'the map sale',
        quote: revealIn(db, two, { para: 0, quote: 'The map had been sold by Tomas', label: 'x' })
      },
      NOW
    )
    const lines = knowsLines(sale.recordId)
    setKnewBefore(db, map.recordId, mara, true, NOW)
    setKnewBefore(db, sale.recordId, mara, true, NOW)
    setKnewBefore(db, sale.recordId, tomas, true, NOW)
    const stating = ['⟨r1⟩ overheard ⟨r2⟩']
    const key = dismissedKey({
      kind: 'notRight',
      recordId: orrin,
      slot: `knows:${sale.recordId}`,
      value: 'overheard',
      stating
    })
    dismiss(db, { kind: 'notRight', key, recordId: orrin, label: 'x', quote: null }, NOW)

    sameAs(db, map.recordId, sale.recordId, NOW)
    expect(getClaim(db, lines.orrin)?.objectId).toBe(map.recordId)
    expect(recordTopicQuotes(db, map.recordId).map((quote) => quote.role)).toEqual([
      'defining',
      'defining'
    ])
    expect(listKnewBefore(db).map((row) => [row.secretId, row.recordId])).toEqual([
      [map.recordId, mara],
      [map.recordId, tomas]
    ])
    const moved = dismissedKey({
      kind: 'notRight',
      recordId: orrin,
      slot: `knows:${map.recordId}`,
      value: 'overheard',
      stating
    })
    expect(getDismissedByKey(db, 'notRight', moved)).not.toBeNull()
    expect(getDismissedByKey(db, 'notRight', key)).toBeNull()
    expect(invariants()).toEqual([])
  })

  it('merges two characters: knows learners, sources and knew-before follow', () => {
    const map = soldMap()
    const lines = knowsLines(map.recordId)
    const tom = character('Tom')
    setKnewBefore(db, map.recordId, tom, true, NOW)
    setKnewBefore(db, map.recordId, tomas, true, NOW)
    sameAs(db, tom, tomas, NOW)
    expect(getClaim(db, lines.orrin)?.fromId).toBe(tom)
    expect(getClaim(db, lines.tomas)?.recordId).toBe(tom)
    expect(listKnewBefore(db)).toEqual([{ secretId: map.recordId, recordId: tom }])
    expect(invariants()).toEqual([])
  })

  it('refuses a secret with a character, and a secret with a thread', () => {
    const map = soldMap()
    const thread = createRecord(db, { name: 'The heir', categoryId: 'thread' }, NOW)
    if (!('record' in thread)) throw new Error('blocked')
    expect(() => sameAs(db, map.recordId, mara, NOW)).toThrow(/two secrets/)
    expect(() => sameAs(db, thread.record.id, map.recordId, NOW)).toThrow(/two secrets/)
  })
})

describe('knew before the book (F-16.22)', () => {
  it('marks and unmarks a character or group, and refuses anything else', () => {
    const map = soldMap()
    const crew = createRecord(db, { name: 'The crew', categoryId: 'faction', force: true }, NOW)
    if (!('record' in crew)) throw new Error('blocked')
    expect(setKnewBefore(db, map.recordId, mara, true, NOW)).toBe(true)
    expect(setKnewBefore(db, map.recordId, mara, true, NOW)).toBe(false)
    expect(setKnewBefore(db, map.recordId, crew.record.id, true, NOW)).toBe(true)
    expect(listKnewBefore(db)).toHaveLength(2)
    expect(setKnewBefore(db, map.recordId, mara, false, NOW)).toBe(true)
    expect(listKnewBefore(db)).toEqual([{ secretId: map.recordId, recordId: crew.record.id }])
    expect(() => setKnewBefore(db, mara, orrin, true, NOW)).toThrow(/Only a secret/)
    const place = createRecord(db, { name: 'The quay', categoryId: 'setting', force: true }, NOW)
    if (!('record' in place)) throw new Error('blocked')
    expect(() => setKnewBefore(db, map.recordId, place.record.id, true, NOW)).toThrow(
      /character or a group/
    )
  })
})

describe('the anchors job over reveals (P2b, F-16.17)', () => {
  it('holds, moves, stales and restores a reveal, and parks it in a scene that is not readable', () => {
    const map = soldMap()
    expect(runAnchors(db, one, NOW).topicQuotes).toEqual([])
    // A paragraph added above: the reveal follows its quote.
    saveDocument(db, one, doc('Rain fell.', ...SCENE_ONE))
    runAnchors(db, one, NOW)
    expect(getTopicQuote(db, map.topicQuoteId)).toMatchObject({ para: 2, state: 'live' })
    // Its sentence edited: stale, re-checking.
    saveDocument(db, one, doc('Rain fell.', 'Tomas sold the old map.', ...SCENE_ONE.slice(2)))
    const staled = runAnchors(db, one, NOW)
    expect(staled.topicQuotes).toEqual([map.topicQuoteId])
    expect(staled.recordIds).toContain(map.recordId)
    expect(getTopicQuote(db, map.topicQuoteId)?.state).toBe('stale')
    // The edit undone: restored where it is now, with no reading.
    saveDocument(db, one, doc(...SCENE_ONE))
    const restored = runAnchors(db, one, NOW)
    expect(restored.topicQuotes).toEqual([map.topicQuoteId])
    expect(getTopicQuote(db, map.topicQuoteId)).toMatchObject({ para: 1, state: 'live' })
    expect(invariants()).toEqual([])
  })

  it('clears settled when a save leaves a finished sentence unread, and only then', () => {
    const names = (): ReturnType<typeof gateSentences> =>
      gateSentences(sceneTexts(db, one), { caretPara: null, names: null })
    writeSceneRead(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        entries: nextReadSet(null, names(), 'all'),
        full: true,
        readingId: null,
        topics: true,
        settled: true
      },
      NOW
    )
    expect(runAnchors(db, one, NOW).unsettled).toBe(false)
    expect(getSceneRead(db, one, activeDraftId(db))?.settled).toBe(true)
    saveDocument(db, one, doc(...SCENE_ONE, 'A new sentence nobody read.'))
    const result = runAnchors(db, one, NOW)
    expect(result.unsettled).toBe(true)
    expect(getSceneRead(db, one, activeDraftId(db))).toMatchObject({
      settled: false,
      topicsRead: true
    })
  })
})

describe('the scene read flags (P2b-D9)', () => {
  const write = (input: { full: boolean; topics?: boolean; settled?: boolean }): void =>
    writeSceneRead(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        entries: [],
        readingId: null,
        ...input
      },
      NOW
    )

  it('sets topics read on a full read by a reader of knows, keeps it through its window reads', () => {
    write({ full: false, topics: true })
    expect(getSceneRead(db, one, activeDraftId(db))?.topicsRead).toBe(false)
    write({ full: true, topics: true, settled: true })
    expect(getSceneRead(db, one, activeDraftId(db))).toMatchObject({
      topicsRead: true,
      settled: true
    })
    write({ full: false, topics: true })
    expect(getSceneRead(db, one, activeDraftId(db))?.topicsRead).toBe(true)
    // An older reader's read (the flags left out) keeps them; one that reads no knows clears it.
    write({ full: false })
    expect(getSceneRead(db, one, activeDraftId(db))?.topicsRead).toBe(true)
    write({ full: true, topics: false })
    expect(getSceneRead(db, one, activeDraftId(db))?.topicsRead).toBe(false)
  })

  it('reads every scene’s flags at once, and sets settled only on a row that exists', () => {
    expect(setSceneSettled(db, two, activeDraftId(db), true)).toBe(false)
    write({ full: true, topics: true })
    expect(setSceneSettled(db, one, activeDraftId(db), true)).toBe(true)
    expect(setSceneSettled(db, one, activeDraftId(db), true)).toBe(false)
    expect(sceneReadFlags(db, activeDraftId(db))).toEqual(
      new Map([[one, { topicsRead: true, settled: true }]])
    )
  })
})

describe('the topics part of the roster (P2b-D10)', () => {
  it('lists secrets and threads after the records, appends, and rebuilds only its own part', () => {
    const before = readerRoster(db)
    expect(before.topicLines).toEqual([])
    const map = soldMap()
    const heir = createRecord(db, { name: "Ashby's return", categoryId: 'thread' }, LATER)
    if (!('record' in heir)) throw new Error('blocked')
    const roster = readerRoster(db)
    expect(roster.lines).toEqual(before.lines)
    expect(roster.topicLines).toEqual(['s1 the sold map · secret', "t1 Ashby's return · thread"])
    expect(roster.topicShortOf(map.recordId)).toBe('s1')
    expect(roster.topicOf('t1')).toBe(heir.record.id)
    expect(roster.topicOf('r1')).toBeNull()
    // A new topic is appended; a gone one rebuilds the topics part, never the record lines.
    const sale = createTopic(
      db,
      {
        kind: 'secret',
        label: 'the map sale',
        quote: revealIn(db, two, { para: 0, quote: 'The map had been sold by Tomas', label: 'x' })
      },
      LATEST
    )
    expect(readerRoster(db).topicLines.at(-1)).toBe('s2 the map sale · secret')
    deleteRecord(db, map.recordId)
    const after = readerRoster(db)
    expect(after.lines).toEqual(before.lines)
    expect(after.topicLines).toEqual(["t1 Ashby's return · thread", 's1 the map sale · secret'])
    expect(after.topicShortOf(sale.recordId)).toBe('s1')
  })

  it('never drops a topic: past its budget every label shortens to 4 words', () => {
    for (let i = 0; i < 40; i += 1) {
      const made = createRecord(
        db,
        { name: `the long hidden truth number ${i} of the old house`, categoryId: 'secret' },
        NOW
      )
      expect('record' in made).toBe(true)
    }
    const roster = readerRoster(db)
    expect(roster.topicLines).toHaveLength(40)
    expect(roster.topicLines[0]).toBe('s1 the long hidden truth · secret')
    expect(ROSTER_RECORD_TOKENS).toBe(1_200)
  })
})

describe('who knows what over the stores (F-16.22)', () => {
  it('reads the stored lines, reveals, marks and flags through knowsAsOf', () => {
    const map = soldMap()
    knowsLines(map.recordId)
    setKnewBefore(db, map.recordId, mara, true, NOW)
    setSceneDetails(
      db,
      one,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: []
      },
      NOW
    )
    const draftId = activeDraftId(db)
    const view = knowsAsOf({
      secrets: listTopics(db, 'secret').map((topic) => ({
        recordId: topic.recordId,
        label: topic.label,
        origin: topic.origin
      })),
      claims: slotClaims(db, 'knows', draftId),
      quotes: listTopicQuotes(db, draftId),
      knewBefore: listKnewBefore(db),
      reading: readingOrder(db),
      flags: sceneReadFlags(db, draftId),
      atId: two
    })
    const [secret] = view.secrets
    expect(secret?.readersSince?.nodeId).toBe(one)
    expect(secret?.cells.map((cell) => [cell.knowerId, cell.how, cell.source])).toEqual([
      [mara, 'knewBefore', 'author'],
      [tomas, 'knewBefore', 'claim'],
      [orrin, 'overheard', 'claim']
    ])
    expect(view.checkedUpTo).toBeNull()
    expect(sceneTopicQuotes(db, one, draftId)).toHaveLength(1)
    expect(insertTopicQuote).toBeTypeOf('function')
  })
})
