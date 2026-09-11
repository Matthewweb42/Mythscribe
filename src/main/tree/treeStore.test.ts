import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NovelFormat } from '@shared/ipc/contract'
import type { NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, renameNode, type TreeDb } from './treeStore'

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
