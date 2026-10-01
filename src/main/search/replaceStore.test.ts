import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REPLACE_MAX_DOCUMENTS, REPLACE_SAMPLES, type ReplaceRequest } from '@shared/replace'
import type { TiptapNodeT } from '@shared/tiptap'
import { node, type NodeRow } from '../db/schema'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, deleteNode, getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  clearReplaceUndo,
  commitReplace,
  previewReplace,
  replaceUndoSize,
  undoReplace
} from './replaceStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The seeded manuscript's scenes, in reading order. */
let scenes: NodeRow[]

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const request = (
  query: string,
  replacement: string,
  patch: Partial<ReplaceRequest> = {}
): ReplaceRequest => ({
  query,
  replacement,
  matchCase: false,
  wholeWord: false,
  scopeId: null,
  ...patch
})

const scene = (index: number): NodeRow => {
  const row = scenes[index]
  if (row === undefined) throw new Error(`no scene ${index}`)
  return row
}

const row = (id: string): NodeRow => {
  const found = getNode(db, id)
  if (found === undefined) throw new Error(`no node ${id}`)
  return found
}

const contentOf = (id: string): TiptapNodeT | null => getDocumentContent(db, id).content

const allIds = (): string[] => scenes.map((each) => each.id)

beforeEach(() => {
  clearReplaceUndo()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-replace-'))
  session = createProject(projectFolderFor(tmp, 'Replace'), 'Replace', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db)
  // The seed is one scene; the tests need three in reading order.
  const first = scene(0)
  for (let i = 0; i < 2; i++) {
    createNode(db, 'novel', {
      parentId: first.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: `Extra ${i + 1}`
    })
  }
  scenes = manuscriptDocuments(db)
})
afterEach(() => {
  vi.useRealTimers()
  clearReplaceUndo()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('previewReplace (F-10.2)', () => {
  it('lists the matching documents in tree order with counts, location, and samples', () => {
    saveDocument(db, scene(0).id, doc('The Lantern swung.', 'She raised the lantern.'))
    saveDocument(db, scene(1).id, doc('No light here.'))
    saveDocument(db, scene(2).id, doc('A lantern.'))
    const parent = listNodes(db).find((other) => other.id === scene(0).parentId)
    const preview = previewReplace(db, request('lantern', 'lamp'))
    expect(preview.total).toBe(2)
    expect(preview.truncated).toBe(false)
    expect(preview.items).toEqual([
      {
        id: scene(0).id,
        title: scene(0).title,
        location: `Part 1 › ${parent?.title}`,
        count: 2,
        samples: [
          {
            before: { text: 'The Lantern swung.', range: [4, 11] },
            after: { text: 'The lamp swung.', range: [4, 8] }
          },
          {
            before: { text: 'She raised the lantern.', range: [15, 22] },
            after: { text: 'She raised the lamp.', range: [15, 19] }
          }
        ]
      },
      expect.objectContaining({ id: scene(2).id, count: 1 })
    ])
  })

  it('writes nothing', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    const before = row(scene(0).id)
    previewReplace(db, request('lantern', 'lamp'))
    expect(row(scene(0).id)).toEqual(before)
    expect(replaceUndoSize()).toBe(0)
  })

  it('answers nothing for an empty query, and honours Match case and Whole word', () => {
    saveDocument(db, scene(0).id, doc('Rose and Rosemary and rose.'))
    expect(previewReplace(db, request('', 'x'))).toEqual({ items: [], total: 0, truncated: false })
    expect(previewReplace(db, request('rose', 'x')).items[0]?.count).toBe(3)
    expect(previewReplace(db, request('rose', 'x', { matchCase: true })).items[0]?.count).toBe(1)
    expect(previewReplace(db, request('rose', 'x', { wholeWord: true })).items[0]?.count).toBe(2)
  })

  it('caps the samples of one document while its count goes on', () => {
    saveDocument(db, scene(0).id, doc('x '.repeat(REPLACE_SAMPLES + 4)))
    const [item] = previewReplace(db, request('x', 'y')).items
    expect(item?.count).toBe(REPLACE_SAMPLES + 4)
    expect(item?.samples).toHaveLength(REPLACE_SAMPLES)
  })

  it('never looks at notes or titles', () => {
    saveNotes(db, scene(0).id, doc('A lantern in the notes.'))
    db.update(node)
      .set({ title: 'Lantern' })
      .where(eq(node.id, scene(1).id))
      .run()
    expect(previewReplace(db, request('lantern', 'lamp')).total).toBe(0)
  })

  it('narrows to a node and everything in it, or to one document', () => {
    const chapterId = scene(0).parentId ?? ''
    const partId = row(chapterId).parentId ?? ''
    const other = createNode(db, 'novel', {
      parentId: partId,
      kind: 'folder',
      hierarchyLevel: 'chapter',
      title: 'Chapter 2'
    })
    const far = createNode(db, 'novel', {
      parentId: other.id,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Far'
    })
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A lantern.'))
    saveDocument(db, far.id, doc('A lantern.'))
    const ids = (scopeId: string | null): string[] =>
      previewReplace(db, request('lantern', 'lamp', { scopeId })).items.map((item) => item.id)
    expect(ids(null)).toEqual([scene(0).id, scene(1).id, far.id])
    expect(ids(chapterId)).toEqual([scene(0).id, scene(1).id])
    expect(ids(other.id)).toEqual([far.id])
    expect(ids(partId)).toEqual([scene(0).id, scene(1).id, far.id])
    expect(ids(scene(1).id)).toEqual([scene(1).id])
  })

  it('refuses a scope that does not exist', () => {
    expect(() => previewReplace(db, request('lantern', 'lamp', { scopeId: 'gone' }))).toThrowError(
      /Scope not found/
    )
    expect(() => previewReplace(db, request('', 'lamp', { scopeId: 'gone' }))).toThrowError(
      /Scope not found/
    )
  })

  it('skips a corrupt document instead of failing', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    db.update(node)
      .set({ content: '{"lantern": ' })
      .where(eq(node.id, scene(1).id))
      .run()
    expect(previewReplace(db, request('lantern', 'lamp')).items.map((item) => item.id)).toEqual([
      scene(0).id
    ])
  })

  it('lists at most the cap and still counts every matching document', () => {
    const parentId = scene(0).parentId ?? ''
    for (let i = 0; i < REPLACE_MAX_DOCUMENTS; i++) {
      const created = createNode(db, 'novel', {
        parentId,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `Bulk ${i}`
      })
      saveDocument(db, created.id, doc('lantern'))
    }
    saveDocument(db, scene(0).id, doc('lantern'))
    const preview = previewReplace(db, request('lantern', 'lamp'))
    expect(preview.items).toHaveLength(REPLACE_MAX_DOCUMENTS)
    expect(preview.total).toBe(REPLACE_MAX_DOCUMENTS + 1)
    expect(preview.truncated).toBe(true)
  })
})

describe('commitReplace (F-10.2)', () => {
  it('rewrites the named documents and answers their counts and word counts', () => {
    saveDocument(db, scene(0).id, doc('The Lantern swung.', 'She raised the lantern.'))
    saveDocument(db, scene(1).id, doc('No light here.'))
    saveDocument(db, scene(2).id, doc('A lantern.'))
    const untouched = row(scene(1).id)
    const result = commitReplace(db, request('lantern', 'oil lamp'), allIds())
    expect(result).toEqual({
      changed: [
        { id: scene(0).id, count: 2, wordCount: 9 },
        { id: scene(2).id, count: 1, wordCount: 3 }
      ],
      total: 3
    })
    expect(contentOf(scene(0).id)).toEqual(doc('The oil lamp swung.', 'She raised the oil lamp.'))
    expect(contentOf(scene(2).id)).toEqual(doc('A oil lamp.'))
    // A document without a match is not written at all.
    expect(row(scene(1).id)).toEqual(untouched)
  })

  it('updates the cached word count and the modified stamp like a save', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    saveDocument(db, scene(0).id, doc('one two three lantern'))
    expect(row(scene(0).id)).toMatchObject({ wordCount: 4, modified: '2026-01-01T00:00:00.000Z' })
    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
    commitReplace(db, request(' lantern', ''), allIds())
    expect(row(scene(0).id)).toMatchObject({ wordCount: 3, modified: '2026-01-02T00:00:00.000Z' })
  })

  it('changes only the ids it was given', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A lantern.'))
    const result = commitReplace(db, request('lantern', 'lamp'), [scene(1).id, 'unknown'])
    expect(result.changed.map((each) => each.id)).toEqual([scene(1).id])
    expect(contentOf(scene(0).id)).toEqual(doc('A lantern.'))
    expect(contentOf(scene(1).id)).toEqual(doc('A lamp.'))
  })

  it('skips an id outside the scope', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A lantern.'))
    const result = commitReplace(db, request('lantern', 'lamp', { scopeId: scene(0).id }), allIds())
    expect(result.changed.map((each) => each.id)).toEqual([scene(0).id])
    expect(contentOf(scene(1).id)).toEqual(doc('A lantern.'))
  })

  it('recomputes from what is stored now, so a stale preview never writes stale text', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A lantern.'))
    const preview = previewReplace(db, request('lantern', 'lamp'))
    expect(preview.items.map((item) => item.count)).toEqual([1, 1])
    // After the preview the author kept writing in one scene and removed the word from the other.
    saveDocument(db, scene(0).id, doc('A lantern.', 'Newer words, another lantern.'))
    saveDocument(db, scene(1).id, doc('Nothing left.'))
    const result = commitReplace(
      db,
      request('lantern', 'lamp'),
      preview.items.map((item) => item.id)
    )
    expect(result).toEqual({ changed: [{ id: scene(0).id, count: 2, wordCount: 6 }], total: 2 })
    expect(contentOf(scene(0).id)).toEqual(doc('A lamp.', 'Newer words, another lamp.'))
    expect(contentOf(scene(1).id)).toEqual(doc('Nothing left.'))
  })

  it('leaves a corrupt document exactly as it is', () => {
    const corrupt = '{"lantern": '
    db.update(node)
      .set({ content: corrupt })
      .where(eq(node.id, scene(0).id))
      .run()
    expect(commitReplace(db, request('lantern', 'lamp'), allIds()).total).toBe(0)
    expect(row(scene(0).id).content).toBe(corrupt)
  })

  it('does nothing for an empty query', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    expect(commitReplace(db, request('', 'lamp'), allIds())).toEqual({ changed: [], total: 0 })
    expect(replaceUndoSize()).toBe(0)
  })

  it('writes all or nothing', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A lantern.'))
    // The second write is refused by the database: the first must not stay.
    db.run(
      `CREATE TRIGGER refuse_second BEFORE UPDATE ON node WHEN NEW.id = '${scene(1).id}' BEGIN SELECT RAISE(ABORT, 'refused'); END`
    )
    expect(() => commitReplace(db, request('lantern', 'lamp'), allIds())).toThrowError()
    expect(contentOf(scene(0).id)).toEqual(doc('A lantern.'))
    expect(contentOf(scene(1).id)).toEqual(doc('A lantern.'))
    expect(replaceUndoSize()).toBe(0)
  })
})

describe('undoReplace (F-10.2)', () => {
  it('restores every document the last commit changed', () => {
    saveDocument(db, scene(0).id, doc('The Lantern swung.'))
    saveDocument(db, scene(2).id, doc('one lantern two'))
    const before = [row(scene(0).id).content, row(scene(2).id).content]
    commitReplace(db, request('lantern', ''), allIds())
    expect(replaceUndoSize()).toBe(2)
    expect(undoReplace(db)).toEqual({
      restored: [
        { id: scene(0).id, wordCount: 3 },
        { id: scene(2).id, wordCount: 3 }
      ],
      skipped: []
    })
    expect([row(scene(0).id).content, row(scene(2).id).content]).toEqual(before)
    expect(row(scene(2).id).wordCount).toBe(3)
  })

  it('is spent after one use, and answers empty with nothing to undo', () => {
    expect(undoReplace(db)).toEqual({ restored: [], skipped: [] })
    saveDocument(db, scene(0).id, doc('A lantern.'))
    commitReplace(db, request('lantern', 'lamp'), allIds())
    expect(undoReplace(db).restored).toHaveLength(1)
    expect(undoReplace(db)).toEqual({ restored: [], skipped: [] })
    expect(contentOf(scene(0).id)).toEqual(doc('A lantern.'))
  })

  it('skips a document edited since the commit, and one deleted since', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A lantern.'))
    saveDocument(db, scene(2).id, doc('A lantern.'))
    commitReplace(db, request('lantern', 'lamp'), allIds())
    saveDocument(db, scene(0).id, doc('A lamp.', 'And newer words.'))
    deleteNode(db, scene(2).id)
    expect(undoReplace(db)).toEqual({
      restored: [{ id: scene(1).id, wordCount: 2 }],
      skipped: [scene(0).id, scene(2).id]
    })
    // The newer work is untouched.
    expect(contentOf(scene(0).id)).toEqual(doc('A lamp.', 'And newer words.'))
    expect(contentOf(scene(1).id)).toEqual(doc('A lantern.'))
  })

  it('belongs to the last commit only, and a commit that changes nothing keeps it', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    saveDocument(db, scene(1).id, doc('A candle.'))
    commitReplace(db, request('lantern', 'lamp'), allIds())
    commitReplace(db, request('nothing', 'x'), allIds())
    expect(replaceUndoSize()).toBe(1)
    commitReplace(db, request('candle', 'torch'), allIds())
    expect(undoReplace(db).restored.map((each) => each.id)).toEqual([scene(1).id])
    expect(contentOf(scene(0).id)).toEqual(doc('A lamp.'))
    expect(contentOf(scene(1).id)).toEqual(doc('A candle.'))
  })

  it('is forgotten when the project changes', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    commitReplace(db, request('lantern', 'lamp'), allIds())
    clearReplaceUndo()
    expect(replaceUndoSize()).toBe(0)
    expect(undoReplace(db)).toEqual({ restored: [], skipped: [] })
    expect(contentOf(scene(0).id)).toEqual(doc('A lamp.'))
  })
})
