import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { tagMention } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  getPassageHash,
  getScanHash,
  listMentionsForNode,
  listMentionsForTag
} from './mentionStore'
import { mentionSource, scanMentions, staleMentionNodeIds } from './scanMentions'
import { createTag, updateTag } from './tagStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let documents: string[]

const at = (minute: number): Date => new Date(Date.UTC(2026, 8, 22, 10, minute, 0))

const scene = (index = 0): string => {
  const id = documents[index]
  if (id === undefined) throw new Error(`no manuscript document at ${index}`)
  return id
}

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({
    type: 'paragraph',
    content: [{ type: 'text', text }]
  }))
})

const write = (id: string, ...paragraphs: string[]): void => {
  saveDocument(db, id, doc(...paragraphs))
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scan-'))
  session = createProject(projectFolderFor(tmp, 'Scan'), 'Scan', 'novel')
  db = session.connection.orm
  documents = manuscriptDocuments(db).map((row) => row.id)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('mentionSource (F-4.12)', () => {
  it('reads a manuscript document, and nothing else', () => {
    write(scene(), 'Rose waited.')
    createTag(db, { name: 'Rose', category: 'character' })
    const source = mentionSource(db, scene())
    expect(source?.candidates.map((c) => c.name)).toEqual(['rose'])
    expect(source?.doc).toEqual(doc('Rose waited.'))
    expect(source?.contentHash).toMatch(/^[0-9a-f]{64}$/)

    const folder = listNodes(db).find((row) => row.kind === 'folder')
    expect(mentionSource(db, folder?.id ?? '')).toBeNull()
    expect(mentionSource(db, 'nope')).toBeNull()
  })

  it('leaves out a tag whose tracking the author turned off, which moves the hash', () => {
    write(scene(), 'Rose waited.')
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    const before = mentionSource(db, scene())?.contentHash
    updateTag(db, rose.id, { trackMentions: false })
    const after = mentionSource(db, scene())
    expect(after?.candidates).toEqual([])
    expect(after?.contentHash).not.toBe(before)
  })

  it('reads an empty document as the empty document rather than failing', () => {
    expect(mentionSource(db, scene())?.doc).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }]
    })
  })
})

describe('scanMentions (F-4.12)', () => {
  it('records where the tracked names occur and says what changed', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    write(scene(), 'Rose waited.', 'The rain came, then Rose left.')

    expect(scanMentions(db, scene(), at(0))).toEqual({ changed: true, scanned: true })
    expect(listMentionsForNode(db, scene())).toEqual([
      {
        tagId: rose.id,
        nodeId: scene(),
        count: 2,
        ranges: [
          [1, 5],
          [35, 39]
        ]
      },
      { tagId: rain.id, nodeId: scene(), count: 1, ranges: [[19, 23]] }
    ])
    // "rose" the flower is not the character; the tone tag matches whatever the case.
    expect(listMentionsForTag(db, rain.id)).toHaveLength(1)
  })

  it('does nothing at all when neither the text nor the tags moved', () => {
    createTag(db, { name: 'Rose', category: 'character' })
    write(scene(), 'Rose waited.')
    expect(scanMentions(db, scene(), at(0))).toEqual({ changed: true, scanned: true })
    const hash = getScanHash(db, scene())
    expect(scanMentions(db, scene(), at(1))).toEqual({ changed: false, scanned: false })
    expect(getScanHash(db, scene())).toBe(hash)
  })

  it('moves the hash on but reports no change when a tag the document never names moves', () => {
    createTag(db, { name: 'Rose', category: 'character' })
    write(scene(), 'Rose waited.')
    scanMentions(db, scene(), at(0))
    const rose = listMentionsForNode(db, scene())

    // A second tag makes every document stale; this one's mentions are exactly what they were.
    createTag(db, { name: 'Harbour', category: 'setting' })
    // The hash moved, so the document was read again (F-4.12b hangs its proposals on that);
    // the rows it found are what they were, so the windows hear nothing.
    expect(scanMentions(db, scene(), at(1))).toEqual({ changed: false, scanned: true })
    expect(listMentionsForNode(db, scene())).toEqual(rose)
    expect(scanMentions(db, scene(), at(2))).toEqual({ changed: false, scanned: false })
  })

  it('rewrites the document’s rows after an edit and after a rename', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    write(scene(), 'Rose waited.')
    scanMentions(db, scene(), at(0))

    write(scene(), 'Rose waited.', 'Rose waited again.')
    expect(scanMentions(db, scene(), at(1))).toEqual({ changed: true, scanned: true })
    expect(listMentionsForNode(db, scene())[0]?.count).toBe(2)

    updateTag(db, rose.id, { name: 'Marsh' })
    expect(scanMentions(db, scene(), at(2))).toEqual({ changed: true, scanned: true })
    expect(listMentionsForNode(db, scene())).toEqual([])
  })

  it('counts an alias as a mention of its tag, and rescans when the aliases change (F-4.14)', () => {
    const rynna = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    write(scene(), 'Rynna waited for the High Crown.')
    expect(scanMentions(db, scene(), at(0))).toEqual({ changed: false, scanned: true })
    expect(listMentionsForNode(db, scene())).toEqual([])

    updateTag(db, rynna.id, { aliases: ['Rynna', 'High Crown'] })
    expect(scanMentions(db, scene(), at(1))).toEqual({ changed: true, scanned: true })
    expect(listMentionsForNode(db, scene())).toEqual([
      {
        tagId: rynna.id,
        nodeId: scene(),
        count: 2,
        ranges: [
          [1, 6],
          [22, 32]
        ]
      }
    ])
  })

  it('empties the rows of a document the author cleared', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    write(scene(), 'Rose waited.')
    scanMentions(db, scene(), at(0))
    expect(listMentionsForTag(db, rose.id)).toHaveLength(1)

    write(scene(), 'Nobody was there.')
    expect(scanMentions(db, scene(), at(1))).toEqual({ changed: true, scanned: true })
    expect(listMentionsForTag(db, rose.id)).toEqual([])
  })

  it('throws NOT_FOUND for a node that is not a manuscript document', () => {
    const folder = listNodes(db).find((row) => row.kind === 'folder')
    for (const id of [folder?.id ?? '', 'nope']) {
      try {
        scanMentions(db, id, at(0))
        throw new Error('expected NOT_FOUND')
      } catch (err) {
        expect(err).toBeInstanceOf(AppError)
        expect((err as AppError).code).toBe('NOT_FOUND')
      }
    }
  })
})

describe('staleMentionNodeIds (F-4.12)', () => {
  it('lists every document until it is scanned, in reading order', () => {
    createTag(db, { name: 'Rose', category: 'character' })
    write(scene(0), 'Rose waited.')
    expect(staleMentionNodeIds(db)).toEqual(documents)

    for (const id of documents) scanMentions(db, id, at(0))
    expect(staleMentionNodeIds(db)).toEqual([])
  })

  it('makes every document stale again when the tag bank changes', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    write(scene(0), 'Rose waited.')
    for (const id of documents) scanMentions(db, id, at(0))

    createTag(db, { name: 'Rain', category: 'tone' })
    expect(staleMentionNodeIds(db)).toEqual(documents)
    for (const id of documents) scanMentions(db, id, at(1))

    updateTag(db, rose.id, { trackMentions: false })
    expect(staleMentionNodeIds(db)).toEqual(documents)
  })

  it('makes one document stale when only that one was edited', () => {
    createTag(db, { name: 'Rose', category: 'character' })
    for (const id of documents) scanMentions(db, id, at(0))
    write(scene(0), 'Rose waited.')
    expect(staleMentionNodeIds(db)).toEqual([scene(0)])
  })
})

describe('the local knowledge index (F-9.12)', () => {
  const passages = (): { node_id: string; para: number; text: string }[] =>
    db.all(sql`SELECT node_id, para, text FROM passage_fts ORDER BY node_id, para`)

  it('records each mention’s paragraph and the document’s paragraphs in the full-text table', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    write(scene(), 'Rose waited by the gate.', 'The rain kept on.', 'Then Rose went in.')
    scanMentions(db, scene(), at(1))
    const row = db
      .select()
      .from(tagMention)
      .all()
      .find((m) => m.tagId === rose.id)
    expect(row?.paragraphs).toBe('[0,2]')
    expect(passages()).toEqual([
      { node_id: scene(), para: 0, text: 'Rose waited by the gate.' },
      { node_id: scene(), para: 1, text: 'The rain kept on.' },
      { node_id: scene(), para: 2, text: 'Then Rose went in.' }
    ])
    expect(getPassageHash(db, scene())).toMatch(/^[0-9a-f]{64}$/)
  })

  it('replaces a document’s passages when its text changes, and leaves the others alone', () => {
    const parentId = getNode(db, scene(0))?.parentId
    if (typeof parentId !== 'string') throw new Error('no parent')
    documents.push(
      createNode(db, 'novel', { parentId, kind: 'document', hierarchyLevel: 'scene', title: 'Two' })
        .id
    )
    write(scene(0), 'First scene text.')
    write(scene(1), 'Second scene text.')
    scanMentions(db, scene(0), at(1))
    scanMentions(db, scene(1), at(1))
    write(scene(0), 'First scene, rewritten.', 'With a second paragraph.')
    scanMentions(db, scene(0), at(2))
    expect(
      passages()
        .filter((p) => p.node_id === scene(0))
        .map((p) => p.text)
    ).toEqual(['First scene, rewritten.', 'With a second paragraph.'])
    expect(
      passages()
        .filter((p) => p.node_id === scene(1))
        .map((p) => p.text)
    ).toEqual(['Second scene text.'])
  })

  it('keeps the passages when only the tag bank changed, and writes nothing on a hash match', () => {
    write(scene(), 'Rose waited by the gate.')
    scanMentions(db, scene(), at(1))
    const before = getPassageHash(db, scene())
    const rowids = (): number[] =>
      db.all<{ rowid: number }>(sql`SELECT rowid FROM passage_fts`).map((r) => r.rowid)
    const kept = rowids()
    createTag(db, { name: 'Gate', category: 'setting' })
    expect(scanMentions(db, scene(), at(2)).scanned).toBe(true)
    expect(getPassageHash(db, scene())).toBe(before)
    expect(rowids()).toEqual(kept)
    expect(scanMentions(db, scene(), at(3))).toEqual({ changed: false, scanned: false })
  })

  it('never changes the document it reads', () => {
    createTag(db, { name: 'Rose', category: 'character' })
    write(scene(), 'Rose waited by the gate.', 'Rosé, the café owner, did not.')
    const read = (): unknown =>
      db.all(sql`SELECT id, content, notes, word_count, modified FROM node ORDER BY id`)
    const before = JSON.stringify(read())
    scanMentions(db, scene(), at(1))
    for (const id of staleMentionNodeIds(db)) scanMentions(db, id, at(2))
    expect(JSON.stringify(read())).toBe(before)
  })
})
