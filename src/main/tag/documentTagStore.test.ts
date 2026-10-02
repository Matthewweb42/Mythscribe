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
  removeDocumentTag,
  replaceAutoTags
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
    expect(listDocumentTags(db, scene)[0]).toEqual({ ...forest, usageCount: 1, source: 'author' })
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
    expect(listDocumentTags(db, chapter)).toEqual([{ ...rain, usageCount: 1, source: 'author' }])
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

describe('replaceAutoTags and the link source (F-4.13)', () => {
  const sources = (nodeId: string): Record<string, string> =>
    Object.fromEntries(listDocumentTags(db, nodeId).map((t) => [t.name, t.source]))

  it('links the named tags as ai, leaves the author’s links alone, and answers what moved', () => {
    const scene = nodeOfKind('document')
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    addDocumentTag(db, scene, rain.id)
    expect(replaceAutoTags(db, scene, [rain.id, dread.id])).toEqual([dread.id])
    expect(sources(scene)).toEqual({ rain: 'author', dread: 'ai' })
    expect(getTagWithUsage(db, dread.id)?.usageCount).toBe(1)
    // The same answer again moves nothing.
    expect(replaceAutoTags(db, scene, [rain.id, dread.id])).toEqual([])
  })

  it('drops a job link the next answer no longer names, and every job link for an empty answer', () => {
    const scene = nodeOfKind('document')
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    const hope = createTag(db, { name: 'Hope', category: 'tone' })
    addDocumentTag(db, scene, hope.id)
    replaceAutoTags(db, scene, [rain.id, dread.id])
    expect(replaceAutoTags(db, scene, [dread.id])).toEqual([rain.id])
    expect(sources(scene)).toEqual({ dread: 'ai', hope: 'author' })
    expect(replaceAutoTags(db, scene, [])).toEqual([dread.id])
    expect(sources(scene)).toEqual({ hope: 'author' })
  })

  it('never re-applies a tag the author took off that node, until the author links it again', () => {
    const first = nodeOfKind('document', 0)
    const second = nodeOfKind('document', 1)
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    replaceAutoTags(db, first, [dread.id])
    removeDocumentTag(db, first, dread.id)
    expect(replaceAutoTags(db, first, [dread.id])).toEqual([])
    expect(listDocumentTags(db, first)).toEqual([])
    // The removal is per node: another scene still gets the tag.
    expect(replaceAutoTags(db, second, [dread.id])).toEqual([dread.id])
    // An author link removed is remembered the same way.
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    addDocumentTag(db, first, rain.id)
    removeDocumentTag(db, first, rain.id)
    expect(replaceAutoTags(db, first, [rain.id])).toEqual([])
    // Linking it again lifts the removal: the link is the author's, and survives an empty answer.
    addDocumentTag(db, first, dread.id)
    expect(sources(first)).toEqual({ dread: 'author' })
    removeDocumentTag(db, first, dread.id)
    addDocumentTag(db, first, dread.id)
    replaceAutoTags(db, first, [])
    expect(sources(first)).toEqual({ dread: 'author' })
  })

  it('makes a job link the author’s when the author adds the same tag', () => {
    const scene = nodeOfKind('document')
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    replaceAutoTags(db, scene, [dread.id])
    expect(addDocumentTag(db, scene, dread.id).usageCount).toBe(1)
    expect(sources(scene)).toEqual({ dread: 'author' })
    replaceAutoTags(db, scene, [])
    expect(sources(scene)).toEqual({ dread: 'author' })
  })

  it('does not remember a removal of a pair that was never linked', () => {
    const scene = nodeOfKind('document')
    const dread = createTag(db, { name: 'Dread', category: 'tone' })
    removeDocumentTag(db, scene, dread.id)
    expect(replaceAutoTags(db, scene, [dread.id])).toEqual([dread.id])
  })
})
