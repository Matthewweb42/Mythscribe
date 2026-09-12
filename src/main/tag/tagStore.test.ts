import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CATEGORY_COLOR } from '@shared/tags'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import { documentTag, node, tag } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes } from '../tree/treeStore'
import {
  createTag,
  deleteTag,
  getTag,
  getTagWithUsage,
  listTags,
  loadTagTemplate,
  updateTag,
  type TagDb
} from './tagStore'

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

/** Links a tag to a seeded scene directly in `document_tag` (F-4.4/F-4.6 own the real write path). */
function linkToScene(tagId: string, index = 0): string {
  const scene = listNodes(db).filter((r) => r.kind === 'document')[index]
  if (!scene) throw new Error('no seeded scene')
  db.insert(documentTag)
    .values({ id: randomUUID(), nodeId: scene.id, tagId, created: new Date().toISOString() })
    .run()
  return scene.id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-tags-'))
  session = createProject(projectFolderFor(tmp, 'Tags'), 'Tags', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  vi.useRealTimers()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createTag', () => {
  it('normalizes the name, defaults the color to the category, stamps dates, and reports zero usage', () => {
    vi.useFakeTimers({ now: new Date('2026-09-12T10:00:00.000Z') })
    const { id, ...created } = createTag(db, { name: 'Dark Forest', category: 'setting' })
    expect(typeof id).toBe('string')
    expect(created).toEqual({
      name: 'dark-forest',
      category: 'setting',
      color: DEFAULT_CATEGORY_COLOR.setting,
      parentId: null,
      usageCount: 0,
      created: '2026-09-12T10:00:00.000Z',
      modified: '2026-09-12T10:00:00.000Z'
    })
    expect(listTags(db)).toEqual([{ id, ...created }])
  })

  it('keeps an explicit color and parent', () => {
    const parent = createTag(db, { name: 'Places', category: 'setting' })
    const child = createTag(db, {
      name: 'Harbor',
      category: 'setting',
      color: '#123abc',
      parentId: parent.id
    })
    expect(child).toMatchObject({ name: 'harbor', color: '#123abc', parentId: parent.id })
  })

  it('refuses a duplicate name, including one that only collides after normalization', () => {
    createTag(db, { name: 'Dark Forest', category: 'setting' })
    expectCode(() => createTag(db, { name: 'dark forest', category: 'tone' }), 'ALREADY_EXISTS')
    expectCode(() => createTag(db, { name: 'Dark-Forest!', category: 'custom' }), 'ALREADY_EXISTS')
    expectCode(() => createTag(db, { name: 'dark-forest', category: 'setting' }), 'ALREADY_EXISTS')
    expect(listTags(db)).toHaveLength(1)
  })

  it('treats "Shadow", "shadow " and "Shadow!" as the same tag', () => {
    createTag(db, { name: 'Shadow', category: 'character' })
    expectCode(() => createTag(db, { name: 'shadow ', category: 'character' }), 'ALREADY_EXISTS')
    expectCode(() => createTag(db, { name: 'Shadow!', category: 'character' }), 'ALREADY_EXISTS')
  })

  it('refuses a name that empties after normalization', () => {
    expectCode(() => createTag(db, { name: '—', category: 'custom' }), 'VALIDATION')
    expectCode(() => createTag(db, { name: '!!!', category: 'custom' }), 'VALIDATION')
    expect(listTags(db)).toEqual([])
  })

  it('refuses a parent that does not exist', () => {
    expectCode(
      () => createTag(db, { name: 'orphan', category: 'custom', parentId: 'missing' }),
      'NOT_FOUND'
    )
    expect(listTags(db)).toEqual([])
  })
})

describe('listTags / getTagWithUsage', () => {
  it('lists by name and counts document_tag rows per tag', () => {
    const b = createTag(db, { name: 'Beta', category: 'tone' })
    const a = createTag(db, { name: 'Alpha', category: 'tone' })
    const c = createTag(db, { name: 'Gamma', category: 'tone' })
    linkToScene(a.id, 0)
    linkToScene(a.id, 1)
    linkToScene(b.id, 0)
    expect(listTags(db).map((t) => [t.name, t.usageCount])).toEqual([
      ['alpha', 2],
      ['beta', 1],
      ['gamma', 0]
    ])
    expect(getTagWithUsage(db, a.id)).toEqual({ ...a, usageCount: 2 })
    expect(getTagWithUsage(db, c.id)).toEqual(c)
    expect(getTagWithUsage(db, 'missing')).toBeUndefined()
  })

  it('drops the link, and so the count, when the document is deleted', () => {
    const a = createTag(db, { name: 'Alpha', category: 'tone' })
    const sceneId = linkToScene(a.id)
    expect(getTagWithUsage(db, a.id)?.usageCount).toBe(1)
    db.delete(node).where(eq(node.id, sceneId)).run()
    expect(getTagWithUsage(db, a.id)?.usageCount).toBe(0)
  })
})

describe('updateTag', () => {
  it('patches only the given fields and stamps modified', () => {
    vi.useFakeTimers({ now: new Date('2026-09-12T10:00:00.000Z') })
    const created = createTag(db, { name: 'Rain', category: 'tone' })
    vi.setSystemTime(new Date('2026-09-12T11:00:00.000Z'))
    const recolored = updateTag(db, created.id, { color: '#000000' })
    expect(recolored).toEqual({
      ...created,
      color: '#000000',
      modified: '2026-09-12T11:00:00.000Z'
    })
    const renamed = updateTag(db, created.id, { name: 'Heavy Rain', category: 'content' })
    expect(renamed).toMatchObject({ name: 'heavy-rain', category: 'content', color: '#000000' })
    expect(listTags(db)).toEqual([renamed])
  })

  it('keeps the usage count through an update', () => {
    const created = createTag(db, { name: 'Rain', category: 'tone' })
    linkToScene(created.id)
    expect(updateTag(db, created.id, { color: '#000000' }).usageCount).toBe(1)
  })

  it('allows renaming a tag to its own name but refuses another tag’s name', () => {
    const rain = createTag(db, { name: 'Rain', category: 'tone' })
    createTag(db, { name: 'Snow', category: 'tone' })
    expect(updateTag(db, rain.id, { name: 'RAIN' }).name).toBe('rain')
    expectCode(() => updateTag(db, rain.id, { name: 'Snow!' }), 'ALREADY_EXISTS')
    expectCode(() => updateTag(db, rain.id, { name: '#' }), 'VALIDATION')
    expect(getTag(db, rain.id)?.name).toBe('rain')
  })

  it('sets and clears the parent', () => {
    const parent = createTag(db, { name: 'Places', category: 'setting' })
    const child = createTag(db, { name: 'Harbor', category: 'setting' })
    expect(updateTag(db, child.id, { parentId: parent.id }).parentId).toBe(parent.id)
    expect(updateTag(db, child.id, { parentId: null }).parentId).toBeNull()
  })

  it('refuses a missing tag, a missing parent, itself, and a descendant as parent', () => {
    const a = createTag(db, { name: 'A', category: 'custom' })
    const b = createTag(db, { name: 'B', category: 'custom', parentId: a.id })
    const c = createTag(db, { name: 'C', category: 'custom', parentId: b.id })
    expectCode(() => updateTag(db, 'missing', { color: '#000000' }), 'NOT_FOUND')
    expectCode(() => updateTag(db, a.id, { parentId: 'missing' }), 'NOT_FOUND')
    expectCode(() => updateTag(db, a.id, { parentId: a.id }), 'VALIDATION')
    expectCode(() => updateTag(db, a.id, { parentId: b.id }), 'VALIDATION')
    expectCode(() => updateTag(db, a.id, { parentId: c.id }), 'VALIDATION')
    expect(getTag(db, a.id)?.parentId).toBeNull()
  })
})

describe('deleteTag', () => {
  it('removes the tag, re-parents its children to the top level, and drops its document links', () => {
    const parent = createTag(db, { name: 'Places', category: 'setting' })
    const child = createTag(db, { name: 'Harbor', category: 'setting', parentId: parent.id })
    const sceneId = linkToScene(parent.id)
    linkToScene(child.id)
    deleteTag(db, parent.id)
    expect(getTag(db, parent.id)).toBeUndefined()
    expect(listTags(db)).toEqual([{ ...child, parentId: null, usageCount: 1 }])
    const links = db.select().from(documentTag).all()
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({ nodeId: sceneId, tagId: child.id })
    expect(db.select().from(tag).all()).toHaveLength(1)
  })

  it('refuses an unknown id', () => {
    expectCode(() => deleteTag(db, 'missing'), 'NOT_FOUND')
  })
})

describe('loadTagTemplate (F-4.3)', () => {
  const fantasy = TAG_TEMPLATES.find((t) => t.id === 'fantasy')!

  it('creates every tag of the template top-level with the category color and no usage', () => {
    vi.useFakeTimers({ now: new Date('2026-09-12T10:00:00.000Z') })
    const { created, skipped } = loadTagTemplate(db, 'fantasy')
    expect(skipped).toEqual([])
    expect(created.map((t) => [t.name, t.category])).toEqual(
      fantasy.tags.map((t) => [t.name, t.category])
    )
    for (const row of created) {
      expect(row).toMatchObject({
        color: DEFAULT_CATEGORY_COLOR[row.category],
        parentId: null,
        usageCount: 0,
        created: '2026-09-12T10:00:00.000Z',
        modified: '2026-09-12T10:00:00.000Z'
      })
    }
    const listed = listTags(db)
    expect(listed).toHaveLength(fantasy.tags.length)
    expect(new Set(listed.map((t) => t.id))).toEqual(new Set(created.map((t) => t.id)))
  })

  it('skips every name on a second load and creates nothing', () => {
    loadTagTemplate(db, 'fantasy')
    const again = loadTagTemplate(db, 'fantasy')
    expect(again.created).toEqual([])
    expect(again.skipped).toEqual(fantasy.tags.map((t) => t.name))
    expect(listTags(db)).toHaveLength(fantasy.tags.length)
  })

  it('skips only the names already in the bank, matched after normalization across categories', () => {
    const existing = createTag(db, { name: 'Magic System!', category: 'custom' })
    const { created, skipped } = loadTagTemplate(db, 'fantasy')
    expect(skipped).toEqual(['magic-system'])
    expect(created).toHaveLength(fantasy.tags.length - 1)
    expect(created.map((t) => t.name)).not.toContain('magic-system')
    expect(getTag(db, existing.id)).toMatchObject({ name: 'magic-system', category: 'custom' })
    expect(listTags(db)).toHaveLength(fantasy.tags.length)
  })

  it('skips a name a previously loaded template already brought in', () => {
    loadTagTemplate(db, 'standard-fiction')
    const sciFi = TAG_TEMPLATES.find((t) => t.id === 'sci-fi')!
    const { created, skipped } = loadTagTemplate(db, 'sci-fi')
    expect(skipped).toEqual(['technology', 'mystery'])
    expect(created).toHaveLength(sciFi.tags.length - 2)
  })
})
