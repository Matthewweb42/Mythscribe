import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sceneSentences } from '@shared/memory/anchor'
import { emptyCardFields, emptyYields } from '@shared/memory/claims'
import { gateSentences, nextReadSet, readSetOf } from '@shared/memory/gate'
import { checkMemoryInvariants } from '@shared/memory/invariants'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../../document/documentStore'
import { activeDraftId, duplicateDraft, switchDraft } from '../../draft/draftStore'
import { setSceneMeta } from '../../document/sceneMetaStore'
import { createProject, projectFolderFor, type ProjectSession } from '../../project/projectStore'
import { ensureResearchRoot } from '../../project/seed'
import { createNode, deleteNode, getNode, moveNode, type TreeDb } from '../../tree/treeStore'
import { manuscriptDocuments } from '../../voice/profile'
import { nameScanShared, scanNamesFor } from '../nameIndexer'
import { indexScene, searchMemoryPassages, stalePassageOwners } from '../passageIndexer'
import { createRecord, deleteRecord } from '../recordStore'
import { setSceneDetails } from '../sceneDetailStore'
import { runAnchors } from './anchors'
import { getCard, upsertCard } from './cardStore'
import { cardAnchorOf, sceneTexts, seedClaims } from './claimFixture'
import {
  attachClaims,
  claimsByState,
  deleteClaims,
  getClaim,
  invariantClaims,
  recordClaims,
  reviveClaim,
  sceneClaims,
  setClaimsState
} from './claimStore'
import { getReading, insertReading, lastReading, recentReadings } from './readingStore'
import { getSceneRead, writeSceneRead } from './sceneReadStore'
import { claimInfo, sceneMemory, sheetMemory } from './views'
import { readingOrder } from './readingFrame'

let tmp: string
let session: ProjectSession
let db: TreeDb
let one: string
let two: string
let mara: string
let tomas: string
let quay: string

const NOW = new Date(Date.UTC(2026, 9, 12, 12, 0, 0))
const LATER = new Date(Date.UTC(2026, 9, 12, 13, 0, 0))

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** A second draft, copied from the active one; answers its id. */
function otherDraft(): string {
  const list = duplicateDraft(db, activeDraftId(db), 'Other')
  return list.drafts.find((each) => each.name === 'Other')?.id ?? ''
}

function record(name: string, categoryId = 'character'): string {
  const made = createRecord(db, { name, categoryId, force: true }, NOW)
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

/** The memory invariants over the active draft's claims, checked against the scenes now. */
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
    aliases: [],
    citations: []
  })
}

const SCENE_ONE = [
  'The ridge was cold.',
  "Mara's eyes were grey. She waited by the Quay.",
  'Mara wore a blue coat.'
]

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-reading-'))
  session = createProject(projectFolderFor(tmp, 'Reading'), 'Reading', 'novel')
  db = session.connection.orm
  one = manuscriptDocuments(db)[0]?.id ?? ''
  const chapter = getNode(db, one)?.parentId ?? ''
  const part = getNode(db, chapter)?.parentId ?? ''
  const second = createNode(db, 'novel', {
    parentId: part,
    kind: 'folder',
    hierarchyLevel: 'chapter',
    title: 'Chapter 2'
  }).id
  two = createNode(db, 'novel', {
    parentId: second,
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  saveDocument(db, one, doc(...SCENE_ONE))
  saveDocument(db, two, doc('Mara had red hair now.', 'Tomas said Mara was tall.'))
  mara = record('Mara')
  tomas = record('Tomas')
  quay = record('the Quay', 'setting')
  scanNamesFor(db, one, NOW)
  scanNamesFor(db, two, NOW)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the claim store (F-16.17)', () => {
  it('stores claims in the active draft, lists them, and checks clean', () => {
    const [eyes, coat] = seedClaims(
      db,
      one,
      [
        { recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 },
        {
          recordId: mara,
          slot: 'clothing',
          value: 'a blue coat',
          quote: 'Mara wore a blue coat',
          para: 2
        }
      ],
      NOW
    )
    expect(sceneClaims(db, one, activeDraftId(db)).map((each) => each.id)).toEqual([eyes, coat])
    expect(recordClaims(db, mara, activeDraftId(db))).toHaveLength(2)
    expect(getClaim(db, eyes ?? '')).toMatchObject({
      valueKey: 'grey',
      state: 'live',
      proof: 'literal'
    })
    expect(invariants()).toEqual([])
    deleteClaims(db, [coat ?? ''])
    expect(claimsByState(db, 'live', activeDraftId(db))).toHaveLength(1)
  })

  it('attaches waiting claims to a record, live with nothing pending', () => {
    const [id] = seedClaims(
      db,
      one,
      [
        {
          recordId: null,
          pending: { kind: 'name', norm: 'hesk', text: 'Hesk' },
          state: 'waiting',
          slot: 'eyes',
          value: 'grey',
          quote: "Mara's eyes were grey",
          para: 1
        }
      ],
      NOW
    )
    attachClaims(db, [id ?? ''], mara, NOW)
    expect(getClaim(db, id ?? '')).toMatchObject({ recordId: mara, pending: null, state: 'live' })
  })

  it('revives a stale claim with a fresh quote, paragraph, anchor and proof', () => {
    const [id] = seedClaims(
      db,
      one,
      [
        {
          recordId: mara,
          slot: 'clothing',
          value: 'a blue coat',
          quote: 'Mara wore a blue coat',
          para: 2
        }
      ],
      NOW
    )
    setClaimsState(db, [id ?? ''], 'stale')
    const reading = insertReading(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        purpose: 'window',
        pages: 1,
        paras: [[1, 2]],
        promptVersion: 'reader.v1',
        verifyVersion: 'verify.v1',
        model: 'flash',
        tokensIn: 1,
        tokensOut: 1,
        reasoningTokens: 0,
        costUsd: 0,
        cloud: false,
        finishReason: null,
        yields: emptyYields()
      },
      LATER
    )
    reviveClaim(
      db,
      id ?? '',
      {
        quote: 'Mara wore a blue coat',
        para: 2,
        anchor: ['x'],
        proof: 'verified',
        readingId: reading
      },
      LATER
    )
    expect(getClaim(db, id ?? '')).toMatchObject({
      state: 'live',
      proof: 'verified',
      anchor: ['x'],
      readingId: reading,
      proved: LATER.toISOString()
    })
  })

  it('drops a scene’s claims with the scene and a record’s with the record', () => {
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'hair', value: 'red', quote: 'Mara had red hair now', para: 0 }],
      NOW
    )
    deleteNode(db, two)
    expect(recordClaims(db, mara, activeDraftId(db))).toEqual([])
  })
})

describe('the card store (F-16.18)', () => {
  const card = (draftId: string, line = 'Mara waits by the Quay in a blue coat.') => ({
    nodeId: one,
    draftId,
    readingId: null,
    line,
    gist: 'A gist about the cold ridge and the waiting.',
    fields: {
      ...emptyCardFields(),
      where: { value: 'the Quay', quote: 'She waited by the Quay', p: 1, verified: false }
    },
    present: [{ recordId: mara, quote: 'Mara wore a blue coat', p: 2, verified: true }],
    mood: 'tense',
    theme: null,
    anchor: [],
    seen: []
  })

  it('upserts one card per scene and draft and indexes the active one as a map', () => {
    upsertCard(db, card(activeDraftId(db)), NOW)
    upsertCard(db, card(activeDraftId(db), 'Mara waits at the quay, coat on.'), LATER)
    const stored = getCard(db, one, activeDraftId(db))
    expect(stored).toMatchObject({ line: 'Mara waits at the quay, coat on.', mood: 'tense' })
    expect(stored?.lineHash).not.toBeNull()
    // Card lines are found only when asked for, and read as Not canon.
    expect(searchMemoryPassages(db, 'coat on')).toEqual([])
    const hits = searchMemoryPassages(db, 'coat on', { sources: ['card'] })
    expect(hits.map((hit) => [hit.source, hit.ownerId, hit.canon, hit.label])).toEqual([
      ['card', one, 'notCanon', 'card']
    ])
  })

  it('stores a card for a node outside the manuscript without indexing it (no throw)', () => {
    const research = ensureResearchRoot(db, NOW)
    const page = createNode(db, 'novel', {
      parentId: research,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Notes'
    }).id
    expect(() => upsertCard(db, { ...card(activeDraftId(db)), nodeId: page }, NOW)).not.toThrow()
    expect(getCard(db, page, activeDraftId(db))?.line).toBe(
      'Mara waits by the Quay in a blue coat.'
    )
    expect(searchMemoryPassages(db, 'blue coat', { sources: ['card'] })).toEqual([])
  })

  it('keeps another draft’s card apart, unindexed until it is the active draft', () => {
    const other = otherDraft()
    upsertCard(db, card(other, 'An alternative waits elsewhere.'), NOW)
    expect(searchMemoryPassages(db, 'alternative', { sources: ['card'] })).toEqual([])
    expect(getCard(db, one, activeDraftId(db))).toBeNull()
    // No scene without a card is behind; after the switch the other draft's card is.
    for (const id of [one, two]) indexScene(db, id, NOW)
    expect(stalePassageOwners(db).filter((owner) => owner.kind === 'card')).toEqual([])
    switchDraft(db, other)
    expect(stalePassageOwners(db).filter((owner) => owner.kind === 'card')).toEqual([
      { kind: 'card', id: one }
    ])
    indexScene(db, one, NOW)
    expect(
      searchMemoryPassages(db, 'alternative', { sources: ['card'] }).map((hit) => hit.ownerId)
    ).toEqual([one])
  })
})

describe('the reading and read-set stores (F-16.16, F-16.17)', () => {
  const reading = (model: string, quotesFound: number) => ({
    nodeId: one,
    draftId: activeDraftId(db),
    purpose: 'first' as const,
    pages: 1,
    paras: [[0, 2] as [number, number]],
    promptVersion: 'reader.v1',
    verifyVersion: 'verify.v1',
    model,
    tokensIn: 3800,
    tokensOut: 520,
    reasoningTokens: 0,
    costUsd: 0.0009,
    cloud: false,
    finishReason: null,
    yields: { ...emptyYields(), items: 4, quotesFound, rejections: { notFound: 4 - quotesFound } }
  })

  it('keeps one row per reading with its yields, newest first per model', () => {
    const first = insertReading(db, reading('flash', 4), NOW)
    const second = insertReading(db, reading('flash', 3), LATER)
    insertReading(db, reading('pro', 4), LATER)
    expect(getReading(db, first)?.yields).toMatchObject({
      items: 4,
      quotesFound: 4,
      rejections: { notFound: 0 }
    })
    expect(lastReading(db, one, activeDraftId(db))?.id).not.toBe(first)
    expect(recentReadings(db, 'flash').map((each) => each.id)).toEqual([second, first])
  })

  it('records the read set cumulatively, one partial per window, none after a full read', () => {
    const names = nameScanShared(db).index
    const current = gateSentences(SCENE_ONE, { caretPara: null, names })
    writeSceneRead(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        entries: nextReadSet(null, current, 'all'),
        full: true,
        readingId: null
      },
      NOW
    )
    expect(getSceneRead(db, one, activeDraftId(db))).toMatchObject({
      partials: 0,
      fullAt: NOW.toISOString()
    })
    const previous = readSetOf(getSceneRead(db, one, activeDraftId(db))?.entries ?? [], names)
    writeSceneRead(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        entries: nextReadSet(previous, current, new Set([1])),
        full: false,
        readingId: null
      },
      LATER
    )
    expect(getSceneRead(db, one, activeDraftId(db))).toMatchObject({
      partials: 1,
      fullAt: NOW.toISOString()
    })
    expect(getSceneRead(db, one, activeDraftId(db))?.entries).toHaveLength(4)
  })
})

describe('the anchors job (F-16.17, P2a-D19, P2a-D22)', () => {
  it('keeps claims whose sentences hold and costs nothing on a scene without claims', () => {
    seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
      NOW
    )
    expect(runAnchors(db, two, NOW)).toMatchObject({ checked: 0 })
    expect(runAnchors(db, one, NOW)).toMatchObject({ checked: 1, staled: [], reproved: [] })
  })

  it('re-proves a literal claim for free after an edit beside it, and stales a verified one', () => {
    const [literal, verified] = seedClaims(
      db,
      one,
      [
        { recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 },
        {
          recordId: mara,
          slot: 'location',
          value: 'the Quay',
          quote: 'She waited by the Quay',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    saveDocument(
      db,
      one,
      doc(
        'A new first line.',
        'The ridge was very cold.',
        SCENE_ONE[1] ?? '',
        'Mara wore a red coat.'
      )
    )
    const result = runAnchors(db, one, LATER)
    expect(result.reproved).toEqual([literal])
    expect(result.staled).toEqual([verified])
    expect(getClaim(db, literal ?? '')).toMatchObject({
      state: 'live',
      para: 2,
      proved: LATER.toISOString()
    })
    expect(getClaim(db, verified ?? '')?.state).toBe('stale')
    expect(invariants()).toEqual([])
  })

  it('stales a literal claim when a marker word comes in beside it', () => {
    const [id] = seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
      NOW
    )
    saveDocument(db, one, doc('The ridge was cold, she dreamt.', ...SCENE_ONE.slice(1)))
    expect(runAnchors(db, one, LATER).staled).toEqual([id])
    expect(invariants()).toEqual([])
  })

  it('attaches a claim waiting on a shared alias once the scan settles the span (P2a-D22)', () => {
    const [id] = seedClaims(
      db,
      one,
      [
        {
          recordId: null,
          state: 'waiting',
          subjectText: 'Mara',
          pending: { kind: 'subject', candidates: [mara, tomas] },
          slot: 'clothing',
          value: 'a blue coat',
          quote: 'Mara wore a blue coat',
          para: 2
        }
      ],
      NOW
    )
    expect(runAnchors(db, one, NOW).attached).toEqual([id])
    expect(getClaim(db, id ?? '')).toMatchObject({ recordId: mara, state: 'live', pending: null })
  })

  it('parks the claims of a scene marked as an Idea, uncounted, and brings them back after', () => {
    const [id] = seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
      NOW
    )
    // A claim of a scene the author then marks as an Idea is never real (design §2.2), but that
    // is her doing, not a fault: it is parked, not counted as a broken invariant.
    setSceneMeta(db, one, { ...parseStoredSceneMeta(null), status: 'idea' })
    const parked = runAnchors(db, one, LATER)
    expect(parked).toMatchObject({ parked: [id], violations: [] })
    expect(getClaim(db, id ?? '')?.state).toBe('stale')
    setSceneMeta(db, one, parseStoredSceneMeta(null))
    expect(runAnchors(db, one, LATER)).toMatchObject({ restored: [id], violations: [] })
    expect(getClaim(db, id ?? '')?.state).toBe('live')
    expect(invariants()).toEqual([])
  })

  it('follows a quote when paragraphs come above it, the card’s too, and keeps it live', () => {
    const [id] = seedClaims(
      db,
      one,
      [
        {
          recordId: mara,
          slot: 'eyes',
          value: 'grey',
          quote: "Mara's eyes were grey",
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    upsertCard(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'Mara waits.',
        gist: 'A gist.',
        fields: {
          ...emptyCardFields(),
          where: { value: 'the Quay', quote: 'She waited by the Quay', p: 1, verified: false }
        },
        present: [{ recordId: mara, quote: 'Mara wore a blue coat', p: 2, verified: true }],
        mood: null,
        theme: null,
        anchor: [],
        seen: []
      },
      NOW
    )
    saveDocument(db, one, doc('A new opening.', 'And a second.', ...SCENE_ONE))
    const result = runAnchors(db, one, LATER)
    expect(result.staled).toEqual([])
    expect(getClaim(db, id ?? '')).toMatchObject({ state: 'live', para: 3 })
    const card = getCard(db, one, activeDraftId(db))
    expect(card?.fields.where?.p).toBe(3)
    expect(card?.present[0]?.p).toBe(4)
    expect(invariants()).toEqual([])
  })

  it('restores a stale claim for free when the edit is undone', () => {
    const [id] = seedClaims(
      db,
      one,
      [
        {
          recordId: mara,
          slot: 'eyes',
          value: 'grey',
          quote: "Mara's eyes were grey",
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    saveDocument(db, one, doc('The ridge was warm.', ...SCENE_ONE.slice(1)))
    expect(runAnchors(db, one, LATER).staled).toEqual([id])
    saveDocument(db, one, doc(...SCENE_ONE))
    expect(runAnchors(db, one, LATER).restored).toEqual([id])
    expect(getClaim(db, id ?? '')?.state).toBe('live')
  })

  it('stales a claim waiting on its subject when its sentences change, and waits again after', () => {
    const [id] = seedClaims(
      db,
      one,
      [
        {
          recordId: null,
          state: 'waiting',
          subjectText: null,
          pending: { kind: 'subject', candidates: [mara, tomas] },
          slot: 'location',
          value: 'the Quay',
          quote: 'She waited by the Quay',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    saveDocument(db, one, doc(...SCENE_ONE.slice(0, 2), 'Mara wore a red coat.'))
    expect(runAnchors(db, one, LATER).staled).toEqual([id])
    saveDocument(db, one, doc(...SCENE_ONE))
    expect(runAnchors(db, one, LATER).restored).toEqual([id])
    expect(getClaim(db, id ?? '')).toMatchObject({ state: 'waiting', recordId: null })
  })

  it('switching drafts leaves each draft’s claims where they were', () => {
    seedClaims(
      db,
      one,
      [{ recordId: mara, slot: 'eyes', value: 'grey', quote: "Mara's eyes were grey", para: 1 }],
      NOW
    )
    const first = activeDraftId(db)
    const other = otherDraft()
    switchDraft(db, other)
    expect(sceneClaims(db, one, other)).toEqual([])
    expect(invariantClaims(db)).toEqual([])
    switchDraft(db, first)
    expect(sceneClaims(db, one, first)).toHaveLength(1)
    expect(invariants()).toEqual([])
  })
})

describe('the views (F-16.18)', () => {
  it('numbers scenes by chapter and leaves Idea scenes out of the reading order', () => {
    const order = readingOrder(db)
    expect(order.refs.get(one)).toBe('1.1')
    expect(order.refs.get(two)).toBe('2.1')
    expect([...order.order.keys()]).toEqual([one, two])
  })

  it('numbers only readable scenes, names an Idea scene by its title, and reads it as of before', () => {
    const chapter = getNode(db, two)?.parentId ?? ''
    const idea = createNode(db, 'novel', {
      parentId: chapter,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'What if'
    }).id
    moveNode(db, idea, chapter, null)
    setSceneMeta(db, idea, { ...parseStoredSceneMeta(null), status: 'idea' })
    const order = readingOrder(db)
    // The Idea comes first in chapter 2, yet the drafted scene stays 2.1.
    expect(order.refs.get(two)).toBe('2.1')
    expect(order.refs.get(idea)).toBe('What if')
    expect(order.at.get(idea)).toBe(order.order.get(one))
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'hair', value: 'red', quote: 'Mara had red hair now', para: 0 }],
      NOW
    )
    const sheet = sheetMemory(db, mara, idea)
    expect(sheet).toMatchObject({ asOfRef: 'What if', later: 1, lasting: [] })
    expect(sheetMemory(db, mara, 'not-a-scene')).toMatchObject({ asOfRef: null, later: 1 })
  })

  it('keeps the text’s order inside one paragraph on the sheet', () => {
    saveDocument(
      db,
      two,
      doc('Mara had red hair now, but she dyed her hair black.', 'Tomas said Mara was tall.')
    )
    // Stored the other way round: the dye first.
    seedClaims(
      db,
      two,
      [
        {
          recordId: mara,
          slot: 'hair',
          value: 'black',
          quote: 'she dyed her hair black',
          para: 0,
          proof: 'verified'
        },
        { recordId: mara, slot: 'hair', value: 'red', quote: 'Mara had red hair now', para: 0 }
      ],
      NOW
    )
    expect(sheetMemory(db, mara, null).lasting.map((line) => line.value.value)).toEqual(['black'])
  })

  it('falls back to the typed POV when the card’s verified POV record was deleted', () => {
    setSceneDetails(
      db,
      one,
      {
        povRecordId: tomas,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: []
      },
      NOW
    )
    const gone = record('Gone')
    upsertCard(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'A line.',
        gist: 'A gist.',
        fields: {
          ...emptyCardFields(),
          pov: { value: gone, quote: 'Mara wore a blue coat', p: 2, verified: true }
        },
        present: [],
        mood: null,
        theme: null,
        anchor: cardAnchorOf(db, one),
        seen: []
      },
      NOW
    )
    deleteRecord(db, gone)
    const memory = sceneMemory(db, one)
    expect(memory.here[0]).toMatchObject({ recordId: tomas, why: 'pov', typedPov: null })
    expect(memory.typed.pov).toMatchObject({ outcome: 'typedOnly', typed: 'Tomas', text: null })
  })

  it('builds the scene memory: Here, Mentioned, True now and typed against the card', () => {
    seedClaims(
      db,
      one,
      [
        {
          recordId: mara,
          slot: 'clothing',
          value: 'a blue coat',
          quote: 'Mara wore a blue coat',
          para: 2
        },
        {
          recordId: mara,
          slot: 'location',
          value: 'the Quay',
          quote: 'She waited by the Quay',
          para: 1,
          proof: 'verified'
        }
      ],
      NOW
    )
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'hair', value: 'red', quote: 'Mara had red hair now', para: 0 }],
      NOW
    )
    setSceneDetails(
      db,
      one,
      {
        povRecordId: tomas,
        place: { recordId: null, text: 'the harbour' },
        time: { text: '' },
        storyYear: null,
        alsoHere: []
      },
      NOW
    )
    upsertCard(
      db,
      {
        nodeId: one,
        draftId: activeDraftId(db),
        readingId: null,
        line: 'Mara waits by the Quay.',
        gist: 'A gist.',
        fields: {
          ...emptyCardFields(),
          pov: { value: mara, quote: 'Mara wore a blue coat', p: 2, verified: true },
          where: { value: 'the Quay', quote: 'She waited by the Quay', p: 1, verified: true }
        },
        present: [{ recordId: mara, quote: 'Mara wore a blue coat', p: 2, verified: true }],
        mood: null,
        theme: null,
        anchor: cardAnchorOf(db, one),
        seen: []
      },
      NOW
    )
    const memory = sceneMemory(db, one)
    expect(memory.ref).toBe('1.1')
    expect(memory.here).toEqual([
      { recordId: mara, why: 'pov', quote: 'Mara wore a blue coat', p: 2, typedPov: tomas }
    ])
    expect(memory.mentioned).toEqual([{ recordId: quay, count: 1 }])
    expect(memory.trueNow.map((line) => [line.slot, line.value, line.kind, line.ref])).toEqual([
      ['location', 'the Quay', 'lastStated', '1.1'],
      ['clothing', 'a blue coat', 'lastStated', '1.1']
    ])
    expect(memory.typed.pov).toMatchObject({ outcome: 'differs', typed: 'Tomas', text: 'Mara' })
    expect(memory.typed.place).toMatchObject({
      outcome: 'differs',
      typed: 'the harbour',
      text: 'the Quay'
    })
    expect(memory.unread).toBe(4)
    expect(sceneMemory(db, two).trueNow.map((line) => [line.slot, line.value, line.ref])).toEqual([
      ['hair', 'red', '2.1'],
      ['location', 'the Quay', '1.1'],
      ['clothing', 'a blue coat', '1.1']
    ])
  })

  it('builds a sheet as of a scene and ⓘ for a line', () => {
    const [coat] = seedClaims(
      db,
      one,
      [
        {
          recordId: mara,
          slot: 'clothing',
          value: 'a blue coat',
          quote: 'Mara wore a blue coat',
          para: 2
        }
      ],
      NOW
    )
    seedClaims(
      db,
      two,
      [{ recordId: mara, slot: 'hair', value: 'red', quote: 'Mara had red hair now', para: 0 }],
      NOW
    )
    const asOfOne = sheetMemory(db, mara, one)
    expect(asOfOne).toMatchObject({ asOf: one, asOfRef: '1.1', later: 1 })
    expect(asOfOne.transient.map((line) => [line.label, line.value.value, line.since])).toEqual([
      ['Wearing', 'a blue coat', '1.1']
    ])
    expect(
      sheetMemory(db, mara, null).lasting.map((line) => [line.label, line.value.value])
    ).toEqual([['Hair', 'red']])
    const info = claimInfo(db, coat ?? '')
    expect(info).toMatchObject({
      claim: { ref: '1.1', label: 'Wearing', proof: 'literal', quote: 'Mara wore a blue coat' },
      spot: null,
      reading: null
    })
    expect(claimInfo(db, 'gone')).toBeNull()
  })
})
