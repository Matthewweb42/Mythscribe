import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getCompileState, setCompileState } from '../project/settingsStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createNode, deleteNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { listDismissed } from './dismissedStore'
import {
  listNameMentions,
  markNotAMention,
  namedInCounts,
  recordMentionParas,
  scanNamesFor,
  staleNameScans
} from './nameIndexer'
import {
  dropOwner,
  indexOwner,
  indexScene,
  indexStaleRecords,
  pruneMemoryIndex,
  searchMemoryPassages,
  stalePassageOwners
} from './passageIndexer'
import { createRecord, deleteRecord, savePage, setAliases } from './recordStore'
import { setSceneDetails } from './sceneDetailStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 11, 12, minute, 0))

const doc = (...paragraphs: (string | { text: string; notCanon: true })[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((entry) =>
    typeof entry === 'string'
      ? { type: 'paragraph', content: [{ type: 'text', text: entry }] }
      : {
          type: 'paragraph',
          attrs: { notCanon: true },
          content: [{ type: 'text', text: entry.text }]
        }
  )
})

const record = (name: string, aliases: string[] = []): string => {
  const made = createRecord(
    db,
    { name, categoryId: 'character', aliases: aliases.map((text) => ({ text })), force: true },
    at(0)
  )
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

const scene = (i = 0): string => scenes[i] ?? ''

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-index-'))
  session = createProject(projectFolderFor(tmp, 'Index'), 'Index', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('nameIndexer (F-16.5)', () => {
  it('records each mention at its saved range, skips an unchanged scene, and goes stale with the roster', () => {
    const mara = record('Mara Vell', ['Mara'])
    saveDocument(db, scene(), doc('Mara waited.', 'Then Mara Vell left.'))
    expect(staleNameScans(db)).toContain(scene())
    expect(scanNamesFor(db, scene(), at(1))).toEqual({ changed: true, scanned: true })
    expect(listNameMentions(db, scene()).map((m) => [m.recordId, m.text, m.para])).toEqual([
      [mara, 'Mara', 0],
      [mara, 'Mara Vell', 1]
    ])
    expect(scanNamesFor(db, scene(), at(2))).toEqual({ changed: false, scanned: false })
    expect(staleNameScans(db)).not.toContain(scene())
    // A roster change makes every scene stale; a rescan that finds the same rows changes nothing.
    record('Tomas')
    expect(staleNameScans(db)).toContain(scene())
    expect(scanNamesFor(db, scene(), at(3))).toEqual({ changed: false, scanned: true })
    setAliases(db, mara, { name: { text: 'Mara Vell' }, aliases: [] }, at(4))
    expect(scanNamesFor(db, scene(), at(5)).changed).toBe(true)
    expect(listNameMentions(db, scene()).map((m) => m.text)).toEqual(['Mara Vell'])
  })

  it('never records a mention of a secret or a thread (P2b-D2)', () => {
    const ashby = record('Ashby')
    const thread = createRecord(db, { name: "Ashby's Return", categoryId: 'thread' }, at(0))
    const secret = createRecord(db, { name: 'The Sold Map', categoryId: 'secret' }, at(0))
    if (!('record' in thread) || !('record' in secret)) throw new Error('blocked')
    saveDocument(
      db,
      scene(),
      doc("They spoke of Ashby's Return.", 'Nobody mentioned The Sold Map.')
    )
    scanNamesFor(db, scene(), at(1))
    const named = listNameMentions(db, scene()).map((m) => m.recordId)
    expect(named).toEqual([ashby])
    // A topic's label changing rescans nothing: it is not in the roster's hash.
    expect(staleNameScans(db)).not.toContain(scene())
    setAliases(db, thread.record.id, { name: { text: 'Ned comes back' }, aliases: [] }, at(2))
    expect(staleNameScans(db)).not.toContain(scene())
  })

  it('counts each record’s certain mentions per scene for Named in (F-16.6)', () => {
    const mara = record('Mara Vell', ['Mara'])
    const tomas = record('Tomas')
    saveDocument(db, scene(), doc('Mara waited.', 'Then Mara Vell left. Tomas stayed.'))
    scanNamesFor(db, scene(), at(1))
    expect(namedInCounts(db)).toEqual(
      [
        { recordId: mara, nodeId: scene(), count: 2 },
        { recordId: tomas, nodeId: scene(), count: 1 }
      ].sort((a, b) => a.recordId.localeCompare(b.recordId))
    )
    // A scene placed outside the manuscript (an import into the project can re-place one in
    // front matter) keeps its rows, but it is no longer named in the book.
    const front = db.all<{ id: string }>(
      sql`SELECT id FROM node WHERE parent_id IS NULL AND section_type = 'front'`
    )[0]
    const home = getNode(db, scene())?.parentId
    if (front === undefined || typeof home !== 'string') throw new Error('no front matter')
    const placeIn = (parentId: string): void => {
      db.run(sql`UPDATE node SET parent_id = ${parentId} WHERE id = ${scene()}`)
    }
    placeIn(front.id)
    expect(listNameMentions(db, scene())).toHaveLength(3)
    expect(namedInCounts(db)).toEqual([])
    placeIn(home)
    expect(namedInCounts(db)).toHaveLength(2)
  })

  it('settles a shared alias by the typed POV, which is part of the hash', () => {
    const mr = record('Mr. Harrow')
    const mrs = record('Mrs. Harrow')
    setAliases(
      db,
      mr,
      { name: { text: 'Mr. Harrow' }, aliases: [{ text: 'Harrow', shared: true }] },
      at(1)
    )
    setAliases(
      db,
      mrs,
      { name: { text: 'Mrs. Harrow' }, aliases: [{ text: 'Harrow', shared: true }] },
      at(1)
    )
    saveDocument(db, scene(), doc('Harrow sighed.'))
    scanNamesFor(db, scene(), at(2))
    expect(listNameMentions(db, scene()).map((m) => [m.recordId, m.ambiguous])).toEqual([
      [mr, true],
      [mrs, true]
    ])
    // An ambiguous span names nobody yet, so Named in does not count it.
    expect(namedInCounts(db)).toEqual([])
    setSceneDetails(
      db,
      scene(),
      {
        povRecordId: mrs,
        place: { recordId: null, text: '' },
        time: { text: '' },
        storyYear: null,
        alsoHere: []
      },
      at(3)
    )
    expect(scanNamesFor(db, scene(), at(4)).changed).toBe(true)
    expect(listNameMentions(db, scene()).map((m) => [m.recordId, m.ambiguous])).toEqual([
      [mrs, false]
    ])
  })

  it('gives the paragraphs that name a record for certain, never an ambiguous span (F-16.23)', () => {
    const mr = record('Mr. Harrow')
    const mrs = record('Mrs. Harrow')
    for (const [id, name] of [
      [mr, 'Mr. Harrow'],
      [mrs, 'Mrs. Harrow']
    ] as const) {
      setAliases(
        db,
        id,
        { name: { text: name }, aliases: [{ text: 'Harrow', shared: true }] },
        at(1)
      )
    }
    saveDocument(db, scene(), doc('The rain came.', 'Harrow sighed.'))
    scanNamesFor(db, scene(), at(2))
    expect(listNameMentions(db, scene()).map((m) => [m.para, m.ambiguous])).toEqual([
      [1, true],
      [1, true]
    ])
    // The shared "Harrow" names nobody yet: no sheet's Threads count it.
    expect(recordMentionParas(db, mrs).size).toBe(0)
    saveDocument(db, scene(), doc('Mrs. Harrow came in from the rain.', 'Harrow sighed.'))
    scanNamesFor(db, scene(), at(3))
    const certain = listNameMentions(db, scene()).filter((m) => m.recordId === mrs && !m.ambiguous)
    expect([...recordMentionParas(db, mrs)].sort()).toEqual(
      [...new Set(certain.map((m) => `${scene()}|${m.para}`))].sort()
    )
    expect([...recordMentionParas(db, mrs)]).toContain(`${scene()}|0`)
    expect(recordMentionParas(db, 'missing').size).toBe(0)
  })

  it('marks a phrase Not a mention, rescans at once, and keeps the tombstone on Dismissed', () => {
    const will = record('Will')
    saveDocument(db, scene(), doc('Will you come? I will. She saw Will at the gate.'))
    scanNamesFor(db, scene(), at(1))
    const [first] = listNameMentions(db, scene())
    expect(listNameMentions(db, scene())).toHaveLength(2)
    const tombstone = markNotAMention(db, first?.id ?? '', at(2))
    expect(tombstone).toMatchObject({ kind: 'notMention', recordId: will, quote: 'Will you' })
    expect(listNameMentions(db, scene()).map((m) => m.from)).toEqual([expect.any(Number)])
    expect(listDismissed(db).count).toBe(1)
  })

  it('refuses Not a mention on a row the saved text has moved past, and leaves Dismissed alone', () => {
    record('Rynna')
    saveDocument(db, scene(), doc('Then Rynna went home.'))
    scanNamesFor(db, scene(), at(1))
    const [row] = listNameMentions(db, scene())
    saveDocument(db, scene(), doc('Then the old woman named Rynna went home.'))
    expect(() => markNotAMention(db, row?.id ?? '', at(2))).toThrow(/moved/)
    expect(listDismissed(db).count).toBe(0)
    // The scan the save queued rewrites the row; Not a mention then keys the right phrase.
    scanNamesFor(db, scene(), at(3))
    const [moved] = listNameMentions(db, scene())
    expect(markNotAMention(db, moved?.id ?? '', at(4))).toMatchObject({ quote: 'named Rynna went' })
  })

  it('rewrites rows whose paragraph index moved though their positions did not', () => {
    record('Rynna')
    saveDocument(db, scene(), doc('Hello', 'Rynna came.'))
    scanNamesFor(db, scene(), at(1))
    expect(listNameMentions(db, scene()).map((m) => m.para)).toEqual([1])
    saveDocument(db, scene(), doc('     ', 'Rynna came.'))
    expect(scanNamesFor(db, scene(), at(2))).toEqual({ changed: true, scanned: true })
    expect(listNameMentions(db, scene()).map((m) => m.para)).toEqual([0])
  })

  it('refuses a node that is not a manuscript document', () => {
    expect(() => scanNamesFor(db, 'missing', at(0))).toThrow(/Not a manuscript document/)
  })
})

describe('passageIndexer (F-16.5)', () => {
  it('labels scene, Idea scene, excluded scene and note paragraphs, and skips an unchanged owner', () => {
    saveDocument(db, scene(0), doc('The lantern swung over the harbour.'))
    saveNotes(db, scene(0), doc('Plan: the lantern goes out here.'))
    expect(indexScene(db, scene(0), at(1))).toBe(true)
    expect(indexScene(db, scene(0), at(2))).toBe(false)
    expect(
      searchMemoryPassages(db, 'lantern').map((hit) => [hit.source, hit.label, hit.canon])
    ).toEqual(
      expect.arrayContaining([
        ['scene', 'scene', 'canon'],
        ['sceneNote', 'sceneNote', 'canon']
      ])
    )
    // The Idea status, then compile exclusion, relabel the scene's own rows.
    setSceneMeta(db, scene(0), { ...emptySceneMeta(), status: 'idea' })
    expect(stalePassageOwners(db)).toContainEqual({ kind: 'scene', id: scene(0) })
    indexOwner(db, 'scene', scene(0), at(3))
    expect(searchMemoryPassages(db, 'harbour')[0]).toMatchObject({
      source: 'ideaScene',
      canon: 'notCanon',
      label: 'ideaScene'
    })
    setSceneMeta(db, scene(0), { ...emptySceneMeta(), status: 'draft' })
    setCompileState(db, { ...getCompileState(db), excluded: [scene(0)] })
    indexOwner(db, 'scene', scene(0), at(4))
    expect(searchMemoryPassages(db, 'harbour')[0]).toMatchObject({
      source: 'excludedScene',
      canon: 'notCanon',
      label: 'excludedScene'
    })
  })

  it('indexes a record’s Pinned and Ideas, Not canon paragraphs marked so, and filters by source', () => {
    const mara = record('Mara')
    savePage(
      db,
      mara,
      'pinned',
      doc('Eyes: grey as the harbour.', { text: 'Harbour born, maybe.', notCanon: true }),
      at(1)
    )
    savePage(db, mara, 'ideas', doc('A harbour twin?'), at(1))
    expect(stalePassageOwners(db)).toContainEqual({ kind: 'record', id: mara })
    expect(indexStaleRecords(db, at(2))).toBe(1)
    expect(indexStaleRecords(db, at(3))).toBe(0)
    const hits = searchMemoryPassages(db, 'harbour', { limit: 10 })
    expect(hits.map((hit) => [hit.source, hit.para, hit.canon, hit.label]).sort()).toEqual(
      [
        ['idea', 0, 'notCanon', 'idea'],
        ['pinned', 0, 'canon', 'pinned'],
        ['pinned', 1, 'notCanon', 'notCanon']
      ].sort()
    )
    expect(
      searchMemoryPassages(db, 'harbour', { sources: ['idea'] }).map((hit) => hit.source)
    ).toEqual(['idea'])
  })

  it('treats FTS operators in a query as words', () => {
    saveDocument(db, scene(0), doc('NEAR the AND gate'))
    indexScene(db, scene(0), at(1))
    expect(searchMemoryPassages(db, 'NEAR( "gate" * OR')).toHaveLength(1)
    expect(searchMemoryPassages(db, '"*"')).toEqual([])
  })

  it('prunes the rows of owners that are gone, and drops a record’s rows', () => {
    const mara = record('Mara')
    savePage(db, mara, 'pinned', doc('Lantern keeper.'), at(1))
    indexOwner(db, 'record', mara, at(2))
    const second = createNode(db, 'novel', {
      parentId: getNode(db, scene(0))?.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Two'
    }).id
    saveDocument(db, second, doc('A lantern in the second scene.'))
    indexScene(db, second, at(2))
    const count = (): number =>
      db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM memory_passage_fts`)[0]?.n ?? 0
    expect(count()).toBe(2)
    deleteNode(db, second)
    deleteRecord(db, mara)
    expect(pruneMemoryIndex(db)).toBe(2)
    expect(count()).toBe(0)
    expect(pruneMemoryIndex(db)).toBe(0)
    const tomas = record('Tomas')
    savePage(db, tomas, 'pinned', doc('Lantern.'), at(3))
    indexOwner(db, 'record', tomas, at(4))
    dropOwner(db, 'record', tomas)
    expect(count()).toBe(0)
  })
})
