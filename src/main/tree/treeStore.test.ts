import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NovelFormat } from '@shared/ipc/contract'
import { node, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import {
  createNode,
  deleteNode,
  duplicateNode,
  listNodes,
  renameNode,
  type TreeDb
} from './treeStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

function openFixture(format: NovelFormat): void {
  session = createProject(projectFolderFor(tmp, format), format, format)
  db = session.connection.orm
}

function root(sectionType: NodeRow['sectionType']): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === sectionType)
  if (!row) throw new Error(`no ${sectionType} root`)
  return row
}

function children(parentId: string): NodeRow[] {
  return listNodes(db).filter((r) => r.parentId === parentId)
}

function byLevel(level: NodeRow['hierarchyLevel']): NodeRow {
  const row = listNodes(db).find((r) => r.hierarchyLevel === level)
  if (!row) throw new Error(`no ${level}`)
  return row
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-tree-'))
  openFixture('novel')
})
afterEach(() => {
  vi.useRealTimers()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createNode placement', () => {
  it('appends as the last child when afterId is omitted', () => {
    const manuscript = root('manuscript')
    const created = createNode(db, 'novel', {
      parentId: manuscript.id,
      kind: 'folder',
      hierarchyLevel: 'part'
    })
    expect(created.position).toBe(2)
    expect(children(manuscript.id).map((r) => r.position)).toEqual([0, 1, 2])
    expect(children(manuscript.id)[2]?.id).toBe(created.id)
  })

  it('inserts in the middle and shifts later siblings', () => {
    const part = byLevel('part')
    const [c1, c2, c3] = children(part.id)
    const created = createNode(db, 'novel', {
      parentId: part.id,
      kind: 'folder',
      hierarchyLevel: 'chapter',
      afterId: c1?.id
    })
    expect(created.position).toBe(1)
    expect(children(part.id).map((r) => [r.id, r.position])).toEqual([
      [c1?.id, 0],
      [created.id, 1],
      [c2?.id, 2],
      [c3?.id, 3]
    ])
  })

  it('inserts after the last sibling when afterId is the tail', () => {
    const part = byLevel('part')
    const [c1, c2, c3] = children(part.id)
    const created = createNode(db, 'novel', {
      parentId: part.id,
      kind: 'folder',
      hierarchyLevel: 'chapter',
      afterId: c3?.id
    })
    expect(created.position).toBe(3)
    expect(children(part.id).map((r) => r.id)).toEqual([c1?.id, c2?.id, c3?.id, created.id])
    expect(children(part.id).map((r) => r.position)).toEqual([0, 1, 2, 3])
  })

  it('becomes the head (position 0) as the first child of an empty folder', () => {
    const front = root('front')
    expect(children(front.id)).toEqual([])
    const first = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null
    })
    expect(first.position).toBe(0)
    const second = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      afterId: first.id
    })
    expect(children(front.id).map((r) => [r.id, r.position])).toEqual([
      [first.id, 0],
      [second.id, 1]
    ])
  })

  it('rejects afterId that is not a child of the parent', () => {
    const manuscript = root('manuscript')
    const chapter = byLevel('chapter')
    expectCode(
      () =>
        createNode(db, 'novel', {
          parentId: manuscript.id,
          kind: 'folder',
          hierarchyLevel: 'part',
          afterId: chapter.id
        }),
      'NOT_FOUND'
    )
    expectCode(
      () =>
        createNode(db, 'novel', {
          parentId: manuscript.id,
          kind: 'folder',
          hierarchyLevel: 'part',
          afterId: 'nope'
        }),
      'NOT_FOUND'
    )
    expect(children(manuscript.id).map((r) => r.position)).toEqual([0, 1])
  })

  it('rejects a missing parent', () => {
    expectCode(
      () =>
        createNode(db, 'novel', { parentId: 'missing', kind: 'document', hierarchyLevel: null }),
      'NOT_FOUND'
    )
  })

  it('rejects a document as parent', () => {
    const scene = byLevel('scene')
    expectCode(
      () => createNode(db, 'novel', { parentId: scene.id, kind: 'document', hierarchyLevel: null }),
      'VALIDATION'
    )
  })
})

describe('createNode kind and level rules', () => {
  it('rejects a scene folder and a part document', () => {
    const chapter = byLevel('chapter')
    const manuscript = root('manuscript')
    expectCode(
      () =>
        createNode(db, 'novel', { parentId: chapter.id, kind: 'folder', hierarchyLevel: 'scene' }),
      'VALIDATION'
    )
    expectCode(
      () =>
        createNode(db, 'novel', {
          parentId: manuscript.id,
          kind: 'document',
          hierarchyLevel: 'part'
        }),
      'VALIDATION'
    )
  })

  it('rejects structural misplacement', () => {
    const manuscript = root('manuscript')
    const part = byLevel('part')
    const chapter = byLevel('chapter')
    expectCode(
      () =>
        createNode(db, 'novel', { parentId: chapter.id, kind: 'folder', hierarchyLevel: 'part' }),
      'VALIDATION'
    )
    expectCode(
      () =>
        createNode(db, 'novel', {
          parentId: manuscript.id,
          kind: 'folder',
          hierarchyLevel: 'chapter'
        }),
      'VALIDATION'
    )
    expectCode(
      () =>
        createNode(db, 'novel', { parentId: part.id, kind: 'document', hierarchyLevel: 'scene' }),
      'VALIDATION'
    )
    expectCode(
      () =>
        createNode(db, 'novel', {
          parentId: root('front').id,
          kind: 'folder',
          hierarchyLevel: 'part'
        }),
      'VALIDATION'
    )
  })

  it('allows generic nodes under any folder', () => {
    const front = root('front')
    const doc = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null
    })
    expect(doc).toMatchObject({
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      position: 0
    })
    const chapter = byLevel('chapter')
    const folder = createNode(db, 'novel', {
      parentId: chapter.id,
      kind: 'folder',
      hierarchyLevel: null
    })
    expect(folder).toMatchObject({ parentId: chapter.id, kind: 'folder', position: 1 })
  })
})

describe('createNode titles and row shape', () => {
  it('defaults the title from the format and kind', () => {
    const generic = createNode(db, 'novel', {
      parentId: root('end').id,
      kind: 'document',
      hierarchyLevel: null
    })
    expect(generic.title).toBe('Untitled document')
    session.close()
    openFixture('webnovel')
    const arc = createNode(db, 'webnovel', {
      parentId: root('manuscript').id,
      kind: 'folder',
      hierarchyLevel: 'part'
    })
    expect(arc.title).toBe('Untitled Arc')
  })

  it('keeps an explicit title, trimmed', () => {
    const created = createNode(db, 'novel', {
      parentId: root('front').id,
      kind: 'document',
      hierarchyLevel: null,
      title: '  Dedication  '
    })
    expect(created.title).toBe('Dedication')
  })

  it('persists a complete row with zero word count and matching timestamps', () => {
    const created = createNode(db, 'novel', {
      parentId: root('front').id,
      kind: 'document',
      hierarchyLevel: null
    })
    const stored = listNodes(db).find((r) => r.id === created.id)
    expect(stored).toEqual(created)
    expect(created).toMatchObject({ sectionType: null, wordCount: 0, content: null, notes: null })
    expect(created.created).toBe(created.modified)
  })
})

describe('renameNode', () => {
  it('updates the title and modified timestamp', () => {
    const scene = byLevel('scene')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.parse(scene.modified) + 60_000))
    const renamed = renameNode(db, scene.id, '  Opening  ')
    expect(renamed.title).toBe('Opening')
    expect(renamed.created).toBe(scene.created)
    expect(Date.parse(renamed.modified)).toBeGreaterThan(Date.parse(scene.modified))
    expect(listNodes(db).find((r) => r.id === scene.id)).toEqual(renamed)
  })

  it('refuses section roots and unknown ids', () => {
    expectCode(() => renameNode(db, root('manuscript').id, 'Book'), 'VALIDATION')
    expectCode(() => renameNode(db, 'missing', 'Book'), 'NOT_FOUND')
  })
})

describe('duplicateNode', () => {
  it('copies a scene with its content, notes, metadata, and word count right after the original', () => {
    const scene = byLevel('scene')
    db.update(node)
      .set({
        content: '{"type":"doc"}',
        notes: 'beats',
        wordCount: 42,
        sceneMeta: '{"pov":"A"}',
        matterType: 'epigraph',
        preset: 'verse'
      })
      .where(eq(node.id, scene.id))
      .run()
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(Date.parse(scene.modified) + 60_000))
    const rows = duplicateNode(db, scene.id)
    expect(rows).toHaveLength(1)
    const copy = rows[0]
    expect(copy).toMatchObject({
      parentId: scene.parentId,
      sectionType: null,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Scene 1 (Copy)',
      position: 1,
      content: '{"type":"doc"}',
      notes: 'beats',
      wordCount: 42,
      sceneMeta: '{"pov":"A"}',
      matterType: 'epigraph',
      preset: 'verse'
    })
    expect(copy?.id).not.toBe(scene.id)
    expect(copy?.created).toBe(copy?.modified)
    expect(Date.parse(copy?.created ?? '')).toBeGreaterThan(Date.parse(scene.created))
    expect(children(scene.parentId ?? '').map((r) => [r.id, r.position])).toEqual([
      [scene.id, 0],
      [copy?.id, 1]
    ])
    expect(listNodes(db).find((r) => r.id === copy?.id)).toEqual(copy)
  })

  it('copies a chapter recursively, keeping shape and descendant titles', () => {
    const part = byLevel('part')
    const [c1, c2, c3] = children(part.id)
    if (!c1) throw new Error('no chapter')
    const rows = duplicateNode(db, c1.id)
    expect(rows).toHaveLength(2)
    const [copy, copiedScene] = rows
    expect(copy).toMatchObject({ parentId: part.id, title: 'Chapter 1 (Copy)', position: 1 })
    expect(copiedScene).toMatchObject({
      parentId: copy?.id,
      title: 'Scene 1',
      position: 0,
      hierarchyLevel: 'scene'
    })
    expect(children(part.id).map((r) => [r.id, r.position])).toEqual([
      [c1.id, 0],
      [copy?.id, 1],
      [c2?.id, 2],
      [c3?.id, 3]
    ])
    expect(children(copy?.id ?? '').map((r) => r.id)).toEqual([copiedScene?.id])
    // The original chapter keeps its own scene.
    expect(children(c1.id)).toHaveLength(1)
    expect(listNodes(db)).toHaveLength(19)
  })

  it('copies an empty folder inside the subtree with no children of its own', () => {
    const chapter = byLevel('chapter')
    const emptyFolder = createNode(db, 'novel', {
      parentId: chapter.id,
      kind: 'folder',
      hierarchyLevel: null
    })
    const rows = duplicateNode(db, chapter.id)
    const copiedFolder = rows.find((r) => r.title === emptyFolder.title)
    expect(copiedFolder).toMatchObject({ kind: 'folder', hierarchyLevel: null })
    expect(copiedFolder?.id).not.toBe(emptyFolder.id)
    expect(children(copiedFolder?.id ?? '')).toHaveLength(0)
    // The original scene and the original empty folder are both still under the source chapter.
    expect(children(chapter.id)).toHaveLength(2)
    expect(children(chapter.id).some((r) => r.id === emptyFolder.id)).toBe(true)
  })

  it('lands after the original when it is the last sibling', () => {
    const part = byLevel('part')
    const [c1, c2, c3] = children(part.id)
    if (!c3) throw new Error('no chapter')
    const [copy] = duplicateNode(db, c3.id)
    expect(children(part.id).map((r) => [r.id, r.position])).toEqual([
      [c1?.id, 0],
      [c2?.id, 1],
      [c3.id, 2],
      [copy?.id, 3]
    ])
  })

  it('refuses section roots and unknown ids', () => {
    expectCode(() => duplicateNode(db, root('manuscript').id), 'VALIDATION')
    expectCode(() => duplicateNode(db, 'missing'), 'NOT_FOUND')
    expect(listNodes(db)).toHaveLength(17)
  })
})

describe('deleteNode', () => {
  it('deletes a leaf and closes the gap among its siblings', () => {
    const part = byLevel('part')
    const [c1, c2, c3] = children(part.id)
    if (!c2) throw new Error('no chapter')
    deleteNode(db, c2.id)
    expect(listNodes(db).find((r) => r.id === c2.id)).toBeUndefined()
    expect(children(part.id).map((r) => [r.id, r.position])).toEqual([
      [c1?.id, 0],
      [c3?.id, 1]
    ])
    // Chapter 2's scene went with it.
    expect(children(c2.id)).toHaveLength(0)
    expect(listNodes(db)).toHaveLength(15)
  })

  it('deleting the last sibling leaves the others untouched', () => {
    const part = byLevel('part')
    const [c1, c2, c3] = children(part.id)
    if (!c3) throw new Error('no chapter')
    deleteNode(db, c3.id)
    expect(children(part.id).map((r) => [r.id, r.position])).toEqual([
      [c1?.id, 0],
      [c2?.id, 1]
    ])
  })

  it('deletes a folder with every descendant (cascade)', () => {
    const manuscript = root('manuscript')
    const [p1, p2] = children(manuscript.id)
    if (!p1) throw new Error('no part')
    // Part 1 → Chapter 1–3 → one scene each.
    const chapters = children(p1.id)
    const scenes = chapters.flatMap((c) => children(c.id))
    expect(chapters).toHaveLength(3)
    expect(scenes).toHaveLength(3)
    deleteNode(db, p1.id)
    const remaining = listNodes(db).map((r) => r.id)
    expect(remaining).not.toContain(p1.id)
    for (const gone of [...chapters, ...scenes]) expect(remaining).not.toContain(gone.id)
    expect(children(manuscript.id).map((r) => [r.id, r.position])).toEqual([[p2?.id, 0]])
    expect(remaining).toHaveLength(10)
  })

  it('refuses section roots and unknown ids', () => {
    expectCode(() => deleteNode(db, root('manuscript').id), 'VALIDATION')
    expectCode(() => deleteNode(db, root('front').id), 'VALIDATION')
    expectCode(() => deleteNode(db, 'missing'), 'NOT_FOUND')
    expect(listNodes(db)).toHaveLength(17)
  })
})
