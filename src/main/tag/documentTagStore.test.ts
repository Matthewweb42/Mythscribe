import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes } from '../tree/treeStore'
import {
  addDocumentTag,
  listAllDocumentTagLinks,
  listDocumentTags,
  removeDocumentTag
} from './documentTagStore'
import { createTag, deleteTag, getTagWithUsage, listTags, type TagDb } from './tagStore'

let tmp: string
let session: ProjectSession
let db: TagDb

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

/** The id of the n-th seeded document, non-section folder, or section root. */
function nodeOfKind(kind: 'document' | 'folder' | 'section', index = 0): string {
  const row = listNodes(db).filter((r) =>
    kind === 'section' ? r.sectionType !== null : r.kind === kind && r.sectionType === null
  )[index]
  if (!row) throw new Error(`no seeded ${kind}`)
  return row.id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-doctags-'))
  session = createProject(projectFolderFor(tmp, 'Tags'), 'Tags', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('listDocumentTags', () => {
  it('is empty for an untagged document and ordered by name once tagged', () => {
    const scene = nodeOfKind('document')
    expect(listDocumentTags(db, scene)).toEqual([])
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    const forest = createTag(db, { name: 'Dark Forest', category: 'setting' })
    addDocumentTag(db, scene, rain.id)
    addDocumentTag(db, scene, forest.id)
    expect(listDocumentTags(db, scene).map((t) => t.name)).toEqual(['dark-forest', 'rain'])
    expect(listDocumentTags(db, scene)[0]).toEqual({ ...forest, usageCount: 1 })
  })

  it('counts usage across documents, not per document', () => {
    const first = nodeOfKind('document', 0)
    const second = nodeOfKind('document', 1)
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    addDocumentTag(db, first, rain.id)
    addDocumentTag(db, second, rain.id)
    expect(listDocumentTags(db, first)[0]?.usageCount).toBe(2)
    expect(listDocumentTags(db, second)[0]?.usageCount).toBe(2)
  })

  it("lists a folder's tags too (a chapter carries tags, F-4.5), but refuses an unknown node and a section root", () => {
    const chapter = nodeOfKind('folder')
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    expect(listDocumentTags(db, chapter)).toEqual([])
    addDocumentTag(db, chapter, rain.id)
    expect(listDocumentTags(db, chapter)).toEqual([{ ...rain, usageCount: 1 }])
    expectCode(() => listDocumentTags(db, 'missing'), 'NOT_FOUND')
    expectCode(() => listDocumentTags(db, nodeOfKind('section')), 'VALIDATION')
  })
})

describe('addDocumentTag', () => {
  it('links the tag, moves its usage count to 1, and is a no-op the second time', () => {
    const scene = nodeOfKind('document')
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    expect(addDocumentTag(db, scene, rain.id)).toEqual({ ...rain, usageCount: 1 })
    expect(addDocumentTag(db, scene, rain.id)).toEqual({ ...rain, usageCount: 1 })
    expect(listDocumentTags(db, scene)).toHaveLength(1)
    expect(listTags(db)).toEqual([{ ...rain, usageCount: 1 }])
  })

  it('refuses an unknown node, a section root, and an unknown tag, and writes nothing', () => {
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    expectCode(() => addDocumentTag(db, 'missing', rain.id), 'NOT_FOUND')
    expectCode(() => addDocumentTag(db, nodeOfKind('section'), rain.id), 'VALIDATION')
    expectCode(() => addDocumentTag(db, nodeOfKind('document'), 'missing'), 'NOT_FOUND')
    expect(getTagWithUsage(db, rain.id)?.usageCount).toBe(0)
    expect(listDocumentTags(db, nodeOfKind('document'))).toEqual([])
  })
})

describe('removeDocumentTag', () => {
  it('unlinks the tag, moves its usage count back to 0, and is a no-op the second time', () => {
    const scene = nodeOfKind('document')
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    addDocumentTag(db, scene, rain.id)
    expect(removeDocumentTag(db, scene, rain.id)).toEqual({ ...rain, usageCount: 0 })
    expect(listDocumentTags(db, scene)).toEqual([])
    expect(removeDocumentTag(db, scene, rain.id)).toEqual({ ...rain, usageCount: 0 })
  })

  it('leaves the same tag linked to other documents', () => {
    const first = nodeOfKind('document', 0)
    const second = nodeOfKind('document', 1)
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    addDocumentTag(db, first, rain.id)
    addDocumentTag(db, second, rain.id)
    expect(removeDocumentTag(db, first, rain.id).usageCount).toBe(1)
    expect(listDocumentTags(db, second)).toHaveLength(1)
  })

  it('refuses an unknown node, a section root, and an unknown tag', () => {
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    expectCode(() => removeDocumentTag(db, 'missing', rain.id), 'NOT_FOUND')
    expectCode(() => removeDocumentTag(db, nodeOfKind('section'), rain.id), 'VALIDATION')
    expectCode(() => removeDocumentTag(db, nodeOfKind('document'), 'missing'), 'NOT_FOUND')
  })
})

describe('listAllDocumentTagLinks (F-4.10)', () => {
  it('is empty for a project with no links', () => {
    createTag(db, { name: 'Rain', category: 'tone' })
    expect(listAllDocumentTagLinks(db)).toEqual([])
  })

  it('lists every link across nodes, ordered by node id then tag name', () => {
    const first = nodeOfKind('document', 0)
    const second = nodeOfKind('document', 1)
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    const forest = createTag(db, { name: 'Dark Forest', category: 'setting' })
    addDocumentTag(db, second, rain.id)
    addDocumentTag(db, first, rain.id)
    addDocumentTag(db, first, forest.id)
    // Node ids are uuids, so the expected node order is whatever sqlite's text order gives.
    const expected = [
      { nodeId: first, tagId: forest.id },
      { nodeId: first, tagId: rain.id },
      { nodeId: second, tagId: rain.id }
    ].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
    expect(listAllDocumentTagLinks(db)).toEqual(expected)
  })

  it('drops the links of a deleted tag', () => {
    const scene = nodeOfKind('document')
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    addDocumentTag(db, scene, rain.id)
    expect(listAllDocumentTagLinks(db)).toEqual([{ nodeId: scene, tagId: rain.id }])
    deleteTag(db, rain.id)
    expect(listAllDocumentTagLinks(db)).toEqual([])
  })
})
