import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { node, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { getNotes, saveNotes } from './notesStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

function first(kind: NodeRow['kind']): NodeRow {
  const row = listNodes(db).find((r) => r.kind === kind && r.sectionType === null)
  if (!row) throw new Error(`no ${kind}`)
  return row
}

function section(): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === 'manuscript')
  if (!row) throw new Error('no manuscript section')
  return row
}

function setNotes(id: string, notes: string | null): void {
  db.update(node).set({ notes }).where(eq(node.id, id)).run()
}

function getRow(id: string): NodeRow {
  const row = db.select().from(node).where(eq(node.id, id)).get()
  if (!row) throw new Error(`no row ${id}`)
  return row
}

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function expectCode(fn: () => unknown, code: AppError['code']): void {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(code)
    return
  }
  throw new Error(`expected ${code}`)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-notes-'))
  session = createProject(projectFolderFor(tmp, 'Notes'), 'Notes', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getNotes', () => {
  it('returns null notes for a seeded scene and a seeded chapter that were never written to', () => {
    const scene = first('document')
    const chapter = first('folder')
    expect(getNotes(db, scene.id)).toEqual({ id: scene.id, notes: null })
    expect(getNotes(db, chapter.id)).toEqual({ id: chapter.id, notes: null })
  })

  it('returns the stored Tiptap JSON, validated', () => {
    const scene = first('document')
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Remember the rain', marks: [{ type: 'italic' }] }]
        }
      ]
    }
    setNotes(scene.id, JSON.stringify(doc))
    expect(getNotes(db, scene.id)).toEqual({ id: scene.id, notes: doc })
  })

  it('reports NOT_FOUND for an unknown id', () => {
    expectCode(() => getNotes(db, 'nope'), 'NOT_FOUND')
  })

  it('refuses section roots with VALIDATION', () => {
    expectCode(() => getNotes(db, section().id), 'VALIDATION')
  })

  it('reports INTERNAL for notes that are not JSON or not a Tiptap document', () => {
    const scene = first('document')
    setNotes(scene.id, '{not json')
    expectCode(() => getNotes(db, scene.id), 'INTERNAL')
    setNotes(scene.id, JSON.stringify({ content: [] }))
    expectCode(() => getNotes(db, scene.id), 'INTERNAL')
    setNotes(scene.id, JSON.stringify({ type: 'doc', content: [{ text: 'no type' }] }))
    expectCode(() => getNotes(db, scene.id), 'INTERNAL')
  })
})

describe('saveNotes', () => {
  it('stores the notes on a document, stamps modified, and leaves content and word count alone', () => {
    const scene = first('document')
    const before = getRow(scene.id)
    const result = saveNotes(db, scene.id, para('Ends on the cliff.'))
    expect(Date.parse(result.modified)).toBeGreaterThanOrEqual(Date.parse(before.modified))
    const row = getRow(scene.id)
    expect(row.modified).toBe(result.modified)
    expect(row.notes).toBe(JSON.stringify(para('Ends on the cliff.')))
    expect(row.content).toBe(before.content)
    expect(row.wordCount).toBe(before.wordCount)
    expect(row.title).toBe(before.title)
    expect(row.position).toBe(before.position)
  })

  it('round-trips through getNotes for a document and for a folder', () => {
    const scene = first('document')
    const chapter = first('folder')
    const sceneNotes: TiptapNodeT = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Beats' }] },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Arrival', marks: [{ type: 'bold' }] }]
        }
      ]
    }
    saveNotes(db, scene.id, sceneNotes)
    saveNotes(db, chapter.id, para('Chapter goal: get them to the coast.'))
    expect(getNotes(db, scene.id)).toEqual({ id: scene.id, notes: sceneNotes })
    expect(getNotes(db, chapter.id)).toEqual({
      id: chapter.id,
      notes: para('Chapter goal: get them to the coast.')
    })
  })

  it('replaces the previous notes instead of accumulating', () => {
    const scene = first('document')
    saveNotes(db, scene.id, para('one'))
    saveNotes(db, scene.id, para('two'))
    expect(getNotes(db, scene.id).notes).toEqual(para('two'))
  })

  it('reports NOT_FOUND for an unknown id and leaves nothing behind', () => {
    expectCode(() => saveNotes(db, 'nope', para('x')), 'NOT_FOUND')
    expect(listNodes(db).find((r) => r.id === 'nope')).toBeUndefined()
  })

  it('refuses section roots with VALIDATION and does not touch the row', () => {
    const manuscript = section()
    expectCode(() => saveNotes(db, manuscript.id, para('x')), 'VALIDATION')
    expect(getRow(manuscript.id)).toEqual(manuscript)
  })
})
