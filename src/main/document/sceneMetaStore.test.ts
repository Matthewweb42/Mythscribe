import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { EMPTY_SCENE_META, type SceneMeta } from '@shared/sceneMeta'
import { node, type NodeRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { getSceneMeta, setSceneMeta } from './sceneMetaStore'

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

/** A front-matter document, created since the skeleton seeds none. */
function matterDocument(): NodeRow {
  const front = listNodes(db).find((r) => r.sectionType === 'front')
  if (!front) throw new Error('no front section')
  const now = new Date().toISOString()
  db.insert(node)
    .values({
      id: 'matter-1',
      parentId: front.id,
      kind: 'document',
      title: 'Dedication',
      position: 0,
      created: now,
      modified: now
    })
    .run()
  return getRow('matter-1')
}

function getRow(id: string): NodeRow {
  const row = db.select().from(node).where(eq(node.id, id)).get()
  if (!row) throw new Error(`no row ${id}`)
  return row
}

const filled: SceneMeta = { location: 'dark-forest', pov: 'mara', timeline: 'Day 3, after the storm' }

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scenemeta-'))
  session = createProject(projectFolderFor(tmp, 'Meta'), 'Meta', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('getSceneMeta', () => {
  it('returns empty metadata for a seeded scene and chapter that were never written to', () => {
    const scene = first('document')
    const chapter = first('folder')
    expect(getSceneMeta(db, scene.id)).toEqual({ id: scene.id, meta: EMPTY_SCENE_META })
    expect(getSceneMeta(db, chapter.id)).toEqual({ id: chapter.id, meta: EMPTY_SCENE_META })
  })

  it('reads an unreadable column as empty instead of failing', () => {
    const scene = first('document')
    db.update(node).set({ sceneMeta: '{not json' }).where(eq(node.id, scene.id)).run()
    expect(getSceneMeta(db, scene.id).meta).toEqual(EMPTY_SCENE_META)
  })

  it('reports NOT_FOUND for an unknown id and VALIDATION for a section root', () => {
    expectCode(() => getSceneMeta(db, 'nope'), 'NOT_FOUND')
    expectCode(() => getSceneMeta(db, section().id), 'VALIDATION')
  })
})

describe('setSceneMeta', () => {
  it('stores the metadata, stamps modified, and leaves content, notes, and word count alone', () => {
    const scene = first('document')
    const before = getRow(scene.id)
    const result = setSceneMeta(db, scene.id, filled)
    expect(Date.parse(result.modified)).toBeGreaterThanOrEqual(Date.parse(before.modified))
    const row = getRow(scene.id)
    expect(row.modified).toBe(result.modified)
    expect(row.sceneMeta).toBe(JSON.stringify(filled))
    expect(row.content).toBe(before.content)
    expect(row.notes).toBe(before.notes)
    expect(row.wordCount).toBe(before.wordCount)
    expect(row.title).toBe(before.title)
  })

  it('round-trips through getSceneMeta for a scene, a chapter, and a matter document', () => {
    const scene = first('document')
    const chapter = first('folder')
    const matter = matterDocument()
    setSceneMeta(db, scene.id, filled)
    setSceneMeta(db, chapter.id, { ...EMPTY_SCENE_META, location: 'the coast' })
    setSceneMeta(db, matter.id, { ...EMPTY_SCENE_META, pov: 'author' })
    expect(getSceneMeta(db, scene.id)).toEqual({ id: scene.id, meta: filled })
    expect(getSceneMeta(db, chapter.id).meta).toEqual({ ...EMPTY_SCENE_META, location: 'the coast' })
    expect(getSceneMeta(db, matter.id).meta).toEqual({ ...EMPTY_SCENE_META, pov: 'author' })
  })

  it('replaces the previous metadata instead of merging', () => {
    const scene = first('document')
    setSceneMeta(db, scene.id, filled)
    setSceneMeta(db, scene.id, { ...EMPTY_SCENE_META, timeline: 'Day 4' })
    expect(getSceneMeta(db, scene.id).meta).toEqual({ ...EMPTY_SCENE_META, timeline: 'Day 4' })
  })

  it('reports NOT_FOUND for an unknown id and refuses section roots without touching the row', () => {
    expectCode(() => setSceneMeta(db, 'nope', filled), 'NOT_FOUND')
    const manuscript = section()
    expectCode(() => setSceneMeta(db, manuscript.id, filled), 'VALIDATION')
    expect(getRow(manuscript.id)).toEqual(manuscript)
  })
})
