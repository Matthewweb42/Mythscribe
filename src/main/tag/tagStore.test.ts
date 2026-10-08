import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CATEGORY_COLOR } from '@shared/tags'
import { TAG_TEMPLATES } from '@shared/tagTemplates'
import { documentTag, documentTagDismissal, entity, node, tag } from '../db/schema'
import { AppError } from '../ipc/errors'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { getDismissedNames, getTagAliases, setTagAliases } from '../project/settingsStore'
import { listNodes } from '../tree/treeStore'
import {
  addTagAliases,
  createTag,
  deleteTag,
  deleteTags,
  exportTagBank,
  findTagByNameOrAlias,
  getTag,
  getTagWithUsage,
  importTagBank,
  listTags,
  loadTagTemplate,
  mergeTags,
  recolorTags,
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
  session = createSeededProject(projectFolderFor(tmp, 'Tags'), 'Tags', 'novel')
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
      // F-4.12: a new tag is looked for in the manuscript until the author says otherwise.
      trackMentions: true,
      aliases: [],
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

  it('turns mention tracking off and on again (F-4.12)', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    expect(rose.trackMentions).toBe(true)
    expect(updateTag(db, rose.id, { trackMentions: false }).trackMentions).toBe(false)
    expect(getTag(db, rose.id)?.trackMentions).toBe(false)
    // An update that says nothing about the switch leaves it alone.
    expect(updateTag(db, rose.id, { color: '#000000' }).trackMentions).toBe(false)
    expect(updateTag(db, rose.id, { trackMentions: true }).trackMentions).toBe(true)
    expect(listTags(db)[0]?.trackMentions).toBe(true)
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

describe('AI-made tags (F-4.13)', () => {
  it('records the name of a deleted AI-made tag, and nothing for the author’s own', () => {
    const made = createTag(db, { name: 'Dread', category: 'tone' }, 'ai')
    const own = createTag(db, { name: 'Rain', category: 'tone' })
    expect(getTag(db, made.id)?.origin).toBe('ai')
    expect(getTag(db, own.id)?.origin).toBe('author')
    expect(made).not.toHaveProperty('origin')
    deleteTag(db, own.id)
    expect(getDismissedNames(db).names).toEqual([])
    deleteTag(db, made.id)
    expect(getDismissedNames(db).names).toEqual(['dread'])
  })

  it('becomes the author’s on an edit of its name, category, color, or parent, not on the tracking switch', () => {
    const made = createTag(db, { name: 'Dread', category: 'tone' }, 'ai')
    updateTag(db, made.id, { trackMentions: false })
    expect(getTag(db, made.id)?.origin).toBe('ai')
    updateTag(db, made.id, { category: 'custom' })
    expect(getTag(db, made.id)?.origin).toBe('author')
    deleteTag(db, made.id)
    expect(getDismissedNames(db).names).toEqual([])
  })
})

/** Two node ids of the seeded skeleton; `document_tag` links any node, folders included. */
function twoNodes(): [string, string] {
  const [first, second] = listNodes(db)
  if (!first || !second) throw new Error('skeleton not seeded')
  return [first.id, second.id]
}

function link(tagId: string, nodeId: string, source: 'author' | 'ai' = 'author'): void {
  db.insert(documentTag)
    .values({ id: randomUUID(), nodeId, tagId, source, created: new Date().toISOString() })
    .run()
}

function insertEntity(name: string, tagId: string | null): string {
  const id = randomUUID()
  const now = new Date().toISOString()
  db.insert(entity)
    .values({ id, kind: 'character', name, tagId, created: now, modified: now })
    .run()
  return id
}

describe('recolorTags (F-4.9)', () => {
  it('recolors every tag in one write, answers them in the given order, and claims AI-made ones', () => {
    const a = createTag(db, { name: 'Rain', category: 'tone' })
    const b = createTag(db, { name: 'Dread', category: 'tone' }, 'ai')
    const c = createTag(db, { name: 'Fog', category: 'tone' })
    const updated = recolorTags(db, [b.id, a.id, b.id], '#123456')
    expect(updated.map((t) => [t.name, t.color])).toEqual([
      ['dread', '#123456'],
      ['rain', '#123456']
    ])
    expect(getTag(db, b.id)?.origin).toBe('author')
    expect(getTag(db, c.id)?.color).toBe(c.color)
  })

  it('writes nothing when any id is unknown', () => {
    const a = createTag(db, { name: 'Rain', category: 'tone' })
    expectCode(() => recolorTags(db, [a.id, 'missing'], '#123456'), 'NOT_FOUND')
    expect(getTag(db, a.id)?.color).toBe(a.color)
  })
})

describe('deleteTags (F-4.9)', () => {
  it('deletes every tag, records AI-made names, and drops aliases that led to them', () => {
    const a = createTag(db, { name: 'Rain', category: 'tone' })
    const b = createTag(db, { name: 'Dread', category: 'tone' }, 'ai')
    const kept = createTag(db, { name: 'Fog', category: 'tone' })
    setTagAliases(db, { old1: a.id, old2: kept.id })
    deleteTags(db, [a.id, b.id])
    expect(listTags(db).map((t) => t.id)).toEqual([kept.id])
    expect(getDismissedNames(db).names).toEqual(['dread'])
    expect(getTagAliases(db)).toEqual({ old2: kept.id })
  })

  it('deletes nothing when any id is unknown', () => {
    const a = createTag(db, { name: 'Rain', category: 'tone' })
    expectCode(() => deleteTags(db, [a.id, 'missing']), 'NOT_FOUND')
    expect(getTag(db, a.id)).toBeDefined()
  })

  it('drops the aliases to a tag deleted on its own too', () => {
    const a = createTag(db, { name: 'Rain', category: 'tone' })
    setTagAliases(db, { old: a.id })
    deleteTag(db, a.id)
    expect(getTagAliases(db)).toEqual({})
  })
})

describe('mergeTags (F-4.9)', () => {
  it('moves links, dismissals, and entities to the target, deletes the sources, and aliases them', () => {
    const [n1, n2] = twoNodes()
    const target = createTag(db, { name: 'Mara', category: 'character', color: '#111111' })
    const s1 = createTag(db, { name: 'Mara Vell', category: 'custom' }, 'ai')
    const s2 = createTag(db, { name: 'M', category: 'plotThread' })
    link(target.id, n1, 'ai')
    link(s1.id, n1, 'author')
    link(s1.id, n2, 'ai')
    db.insert(documentTagDismissal).values({ nodeId: n1, tagId: s2.id }).run()
    const otherNode = listNodes(db)[2]?.id
    if (otherNode) db.insert(documentTagDismissal).values({ nodeId: otherNode, tagId: s2.id }).run()
    const person = insertEntity('Mara Vell', s1.id)
    setTagAliases(db, { older: s2.id })

    const result = mergeTags(db, target.id, [s1.id, s2.id])
    expect(result.target).toMatchObject({
      id: target.id,
      name: 'mara',
      category: 'character',
      color: '#111111',
      usageCount: 2
    })
    expect(result.removedIds).toEqual([s1.id, s2.id])
    expect(result.aliases).toEqual({ older: target.id, [s1.id]: target.id, [s2.id]: target.id })
    expect(getTagAliases(db)).toEqual(result.aliases)
    expect(new Set(result.nodeIds)).toEqual(new Set([n1, n2]))

    const links = db.select().from(documentTag).all()
    expect(links.map((row) => [row.nodeId, row.tagId, row.source]).sort()).toEqual(
      [
        [n1, target.id, 'author'],
        [n2, target.id, 'ai']
      ].sort()
    )
    // n1 carries the target, so the dismissal there does not move; the other one does.
    const dismissals = db.select().from(documentTagDismissal).all()
    expect(dismissals).toEqual(otherNode ? [{ nodeId: otherNode, tagId: target.id }] : [])
    expect(db.select().from(entity).where(eq(entity.id, person)).get()?.tagId).toBe(target.id)
    expect(listTags(db).map((t) => t.id)).toEqual([target.id])
    expect(getDismissedNames(db).names).toEqual(['mara-vell'])
  })

  it('refuses the target among the sources and an unknown id, writing nothing', () => {
    const target = createTag(db, { name: 'Mara', category: 'character' })
    const source = createTag(db, { name: 'Vell', category: 'character' })
    expectCode(() => mergeTags(db, target.id, [source.id, target.id]), 'VALIDATION')
    expectCode(() => mergeTags(db, 'missing', [source.id]), 'NOT_FOUND')
    expectCode(() => mergeTags(db, target.id, [source.id, 'missing']), 'NOT_FOUND')
    expect(listTags(db)).toHaveLength(2)
    expect(getTagAliases(db)).toEqual({})
  })

  it('merges a chain: an alias to a merged-away tag follows it to the new target', () => {
    const a = createTag(db, { name: 'A', category: 'custom' })
    const b = createTag(db, { name: 'B', category: 'custom' })
    const c = createTag(db, { name: 'C', category: 'custom' })
    mergeTags(db, b.id, [a.id])
    const { aliases } = mergeTags(db, c.id, [b.id])
    expect(aliases).toEqual({ [a.id]: c.id, [b.id]: c.id })
  })
})

describe('exportTagBank / importTagBank (F-4.9)', () => {
  it('exports every tag by name with its parent by name', () => {
    const realm = createTag(db, { name: 'Realm', category: 'worldBuilding', color: '#123456' })
    createTag(db, { name: 'Forest', category: 'setting', parentId: realm.id })
    const quiet = createTag(db, { name: 'Quiet', category: 'tone' })
    updateTag(db, quiet.id, { trackMentions: false })
    expect(exportTagBank(db)).toEqual([
      {
        name: 'forest',
        category: 'setting',
        color: DEFAULT_CATEGORY_COLOR.setting,
        parent: 'realm',
        trackMentions: true
      },
      {
        name: 'quiet',
        category: 'tone',
        color: DEFAULT_CATEGORY_COLOR.tone,
        parent: null,
        trackMentions: false
      },
      {
        name: 'realm',
        category: 'worldBuilding',
        color: '#123456',
        parent: null,
        trackMentions: true
      }
    ])
  })

  it('creates new names with their fields and parents, and skips taken names untouched', () => {
    const existing = createTag(db, { name: 'Realm', category: 'custom', color: '#000000' })
    const { created, skipped } = importTagBank(db, [
      {
        name: 'forest',
        category: 'setting',
        color: '#abcdef',
        parent: 'realm',
        trackMentions: false
      },
      {
        name: 'realm',
        category: 'worldBuilding',
        color: '#123456',
        parent: null,
        trackMentions: true
      },
      {
        name: 'grove',
        category: 'setting',
        color: '#abcdef',
        parent: 'forest',
        trackMentions: true
      },
      { name: 'lost', category: 'custom', color: '#abcdef', parent: 'nowhere', trackMentions: true }
    ])
    expect(skipped).toEqual(['realm'])
    expect(getTag(db, existing.id)).toMatchObject({ category: 'custom', color: '#000000' })
    const byName = new Map(created.map((t) => [t.name, t]))
    expect(created.map((t) => t.name)).toEqual(['forest', 'grove', 'lost'])
    expect(byName.get('forest')).toMatchObject({
      category: 'setting',
      color: '#abcdef',
      parentId: existing.id,
      trackMentions: false,
      usageCount: 0
    })
    expect(byName.get('grove')?.parentId).toBe(byName.get('forest')?.id)
    expect(byName.get('lost')?.parentId).toBeNull()
    expect(getTag(db, byName.get('forest')?.id ?? '')?.origin).toBe('author')
  })

  it('leaves a cycle in the file unlinked rather than nesting a tag under itself', () => {
    const { created } = importTagBank(db, [
      { name: 'a', category: 'custom', color: '#000000', parent: 'b', trackMentions: true },
      { name: 'b', category: 'custom', color: '#000000', parent: 'a', trackMentions: true }
    ])
    expect(created.map((t) => [t.name, t.parentId === null])).toEqual([
      ['a', false],
      ['b', true]
    ])
  })

  it('round-trips a bank into an empty project', () => {
    const realm = createTag(db, { name: 'Realm', category: 'worldBuilding', color: '#123456' })
    createTag(db, { name: 'Forest', category: 'setting', parentId: realm.id })
    const records = exportTagBank(db)
    deleteTags(
      db,
      listTags(db).map((t) => t.id)
    )
    importTagBank(db, records)
    expect(exportTagBank(db)).toEqual(records)
  })
})

describe('aliases (F-4.14)', () => {
  it('starts empty, replaces the list on update, and drops the main name and duplicates', () => {
    const rynna = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    expect(rynna.aliases).toEqual([])
    const updated = updateTag(db, rynna.id, {
      aliases: ['Rynna', ' rynna ', 'Rynna Falsire', 'High Crown Falsire']
    })
    expect(updated.aliases).toEqual(['Rynna', 'High Crown Falsire'])
    expect(listTags(db)[0]?.aliases).toEqual(['Rynna', 'High Crown Falsire'])
  })

  it('refuses an alias that is another tag’s name or alias, writing nothing', () => {
    const rynna = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    const kael = createTag(db, { name: 'Kael', category: 'character' })
    updateTag(db, kael.id, { aliases: ['The Smith'] })
    expectCode(() => updateTag(db, rynna.id, { aliases: ['Kael'] }), 'ALREADY_EXISTS')
    expectCode(() => updateTag(db, rynna.id, { aliases: ['the smith'] }), 'ALREADY_EXISTS')
    expect(getTagWithUsage(db, rynna.id)?.aliases).toEqual([])
  })

  it('drops an alias the tag is renamed to', () => {
    const tag = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    updateTag(db, tag.id, { aliases: ['Rynna', 'Falsire'] })
    expect(updateTag(db, tag.id, { name: 'Rynna' }).aliases).toEqual(['Falsire'])
  })

  it('adds without refusing: names another tag owns and ones already there are skipped', () => {
    const rynna = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    createTag(db, { name: 'Kael', category: 'character' })
    expect(
      addTagAliases(db, rynna.id, ['Rynna', 'Kael', 'rynna', 'The High Crown']).aliases
    ).toEqual(['Rynna', 'The High Crown'])
  })

  it('finds a tag by its name first, then by an alias, in any spelling', () => {
    const rynna = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    updateTag(db, rynna.id, { aliases: ['High Crown'] })
    expect(findTagByNameOrAlias(db, 'rynna-falsire')).toBe(rynna.id)
    expect(findTagByNameOrAlias(db, 'high  crown')).toBe(rynna.id)
    expect(findTagByNameOrAlias(db, 'nobody')).toBeUndefined()
  })

  it('turns merged tags into aliases of the kept one: their names (as their sheets spell them) and aliases', () => {
    const rynna = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    const nick = createTag(db, { name: 'Rynna', category: 'character' })
    const title = createTag(db, { name: 'high-crown', category: 'custom' })
    updateTag(db, title.id, { aliases: ['Her Majesty'] })
    insertEntity('Rynna', nick.id)
    const result = mergeTags(db, rynna.id, [nick.id, title.id])
    expect(result.target.aliases).toEqual(['Rynna', 'High Crown', 'Her Majesty'])
    expect(result.aliases).toEqual({ [nick.id]: rynna.id, [title.id]: rynna.id })
  })

  it('leaves a sheet the aliases of the tag it loses', () => {
    const tag = createTag(db, { name: 'Rynna Falsire', category: 'character' })
    updateTag(db, tag.id, { aliases: ['Rynna'] })
    const sheet = insertEntity('Rynna Falsire', tag.id)
    deleteTag(db, tag.id)
    const row = db.select().from(entity).where(eq(entity.id, sheet)).get()
    expect(row?.tagId).toBeNull()
    expect(row?.aliases).toBe('["Rynna"]')
  })
})
