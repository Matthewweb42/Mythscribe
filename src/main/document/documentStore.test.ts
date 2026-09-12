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
import { getDocumentContent } from './documentStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

function first(kind: NodeRow['kind']): NodeRow {
  const row = listNodes(db).find((r) => r.kind === kind && r.sectionType === null)
  if (!row) throw new Error(`no ${kind}`)
  return row
}

function setContent(id: string, content: string | null): void {
  db.update(node).set({ content }).where(eq(node.id, id)).run()
}

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-document-'))
  session = createProject(projectFolderFor(tmp, 'Doc'), 'Doc', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getDocumentContent', () => {
  it('returns null content for a seeded scene that was never written to', () => {
    const scene = first('document')
    expect(getDocumentContent(db, scene.id)).toEqual({ id: scene.id, content: null })
  })

  it('returns the stored Tiptap JSON, validated', () => {
    const scene = first('document')
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          attrs: { textAlign: 'left' },
          content: [{ type: 'text', text: 'Once', marks: [{ type: 'bold' }] }]
        }
      ]
    }
    setContent(scene.id, JSON.stringify(doc))
    expect(getDocumentContent(db, scene.id)).toEqual({ id: scene.id, content: doc })
  })

  it('reports NOT_FOUND for an unknown id', () => {
    expectCode(() => getDocumentContent(db, 'nope'), 'NOT_FOUND')
  })

  it('refuses folders and sections with VALIDATION', () => {
    expectCode(() => getDocumentContent(db, first('folder').id), 'VALIDATION')
    const manuscript = listNodes(db).find((r) => r.sectionType === 'manuscript')
    expectCode(() => getDocumentContent(db, manuscript?.id ?? ''), 'VALIDATION')
  })

  it('reports INTERNAL for content that is not JSON or not a Tiptap document', () => {
    const scene = first('document')
    setContent(scene.id, '{not json')
    expectCode(() => getDocumentContent(db, scene.id), 'INTERNAL')
    setContent(scene.id, JSON.stringify({ content: [] }))
    expectCode(() => getDocumentContent(db, scene.id), 'INTERNAL')
    setContent(scene.id, JSON.stringify({ type: 'doc', content: [{ text: 'no type' }] }))
    expectCode(() => getDocumentContent(db, scene.id), 'INTERNAL')
  })
})
