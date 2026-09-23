import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Entity, EntityCreateInput, EntityUpdateInput, Tag } from '@shared/ipc/contract'
import { entity, tag } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createTag, deleteTag, getTagWithUsage, listTags, updateTag } from '../tag/tagStore'
import {
  createEntity,
  deleteEntity,
  getEntity,
  linkEntityTag,
  listEntities,
  setEntityImage,
  updateEntity,
  type EntityDb
} from './entityStore'

let tmp: string
let session: ProjectSession
let db: EntityDb

/**
 * Both writes answer the entity and what they did to the tag bank (F-9.4); the tests that are
 * not about the tag take the entity, the ones that are call the store itself.
 */
function create(input: EntityCreateInput): Entity {
  return createEntity(db, input).entity
}
function update(id: string, patch: Omit<EntityUpdateInput, 'id'>): Entity {
  return updateEntity(db, id, patch).entity
}
/** The tag an entity is linked to, read back from the bank. */
function tagOf(id: string): Tag | undefined {
  const tagId = getEntity(db, id)?.tagId
  return tagId === undefined || tagId === null ? undefined : getTagWithUsage(db, tagId)
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-entities-'))
  session = createProject(projectFolderFor(tmp, 'Bible'), 'Bible', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  vi.useRealTimers()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('createEntity', () => {
  it('keeps the name as typed, defaults the template, parses the fields, and stamps dates', () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00.000Z') })
    const { id, ...created } = create({
      kind: 'character',
      name: '  Ada Lovelace ',
      fields: { age: '36', goals: 'Finish the engine.' }
    })
    expect(typeof id).toBe('string')
    expect(created).toEqual({
      kind: 'character',
      name: 'Ada Lovelace',
      template: 'structured',
      fields: { age: '36', goals: 'Finish the engine.' },
      body: null,
      image: null,
      // F-9.4: the tag of the name comes with the entity.
      tagId: tagOf(id)?.id,
      created: '2026-09-22T10:00:00.000Z',
      modified: '2026-09-22T10:00:00.000Z'
    })
    expect(tagOf(id)?.name).toBe('ada-lovelace')
    expect(listEntities(db)).toEqual([{ id, ...created }])
  })

  it('takes a blank page instead of the template', () => {
    const created = create({
      kind: 'world',
      name: 'The Tide Law',
      template: 'blank',
      body: 'Salt binds. Fresh water frees.'
    })
    expect(created).toMatchObject({
      template: 'blank',
      fields: {},
      body: 'Salt binds. Fresh water frees.'
    })
  })

  it('stores no key for a field given as empty', () => {
    const created = create({
      kind: 'setting',
      name: 'The Salt Marsh',
      fields: { atmosphere: 'Low and grey.', description: '', notes: '' }
    })
    expect(created.fields).toEqual({ atmosphere: 'Low and grey.' })
    expect(db.select().from(entity).get()?.fields).toBe('{"atmosphere":"Low and grey."}')
  })

  it('refuses a field that is not of the kind’s template', () => {
    expectCode(
      () => create({ kind: 'setting', name: 'Harbor', fields: { age: '400' } }),
      'VALIDATION'
    )
    expectCode(
      () => create({ kind: 'world', name: 'Tide', fields: { atmosphere: 'Damp' } }),
      'VALIDATION'
    )
    expect(listEntities(db)).toEqual([])
  })

  it('refuses a name that empties after trimming', () => {
    expectCode(() => create({ kind: 'character', name: '   ' }), 'VALIDATION')
    expect(listEntities(db)).toEqual([])
  })

  it('refuses a name another entity of the kind carries, whatever its case or spacing', () => {
    create({ kind: 'character', name: 'Ada' })
    expectCode(() => create({ kind: 'character', name: 'ada' }), 'ALREADY_EXISTS')
    expectCode(() => create({ kind: 'character', name: 'Ada ' }), 'ALREADY_EXISTS')
    expectCode(() => create({ kind: 'character', name: ' ADA' }), 'ALREADY_EXISTS')
    expect(listEntities(db)).toHaveLength(1)
  })

  it('allows the same name for a character, a setting, and a world item', () => {
    create({ kind: 'character', name: 'Marsh' })
    create({ kind: 'setting', name: 'Marsh' })
    create({ kind: 'world', name: 'marsh' })
    expect(listEntities(db).map((e) => e.kind)).toEqual(['character', 'setting', 'world'])
  })
})

describe('listEntities / getEntity', () => {
  it('orders by kind, then by name however it is spelled', () => {
    create({ kind: 'world', name: 'Tide Law' })
    create({ kind: 'setting', name: 'harbor' })
    create({ kind: 'character', name: 'brann' })
    create({ kind: 'setting', name: 'Blackreach' })
    create({ kind: 'character', name: 'Ada' })
    expect(listEntities(db).map((e) => [e.kind, e.name])).toEqual([
      ['character', 'Ada'],
      ['character', 'brann'],
      ['setting', 'Blackreach'],
      ['setting', 'harbor'],
      ['world', 'Tide Law']
    ])
  })

  it('answers one entity and undefined for an unknown id', () => {
    const ada = create({ kind: 'character', name: 'Ada', fields: { age: '36' } })
    expect(getEntity(db, ada.id)).toEqual(ada)
    expect(getEntity(db, 'missing')).toBeUndefined()
  })

  it('survives a stored fields cell that no longer parses', () => {
    const ada = create({ kind: 'character', name: 'Ada', fields: { age: '36' } })
    db.update(entity).set({ fields: '{oops' }).where(eq(entity.id, ada.id)).run()
    expect(getEntity(db, ada.id)?.fields).toEqual({})
  })
})

describe('updateEntity', () => {
  it('merges the given fields over the stored ones and stamps modified', () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00.000Z') })
    const created = create({
      kind: 'character',
      name: 'Ada',
      fields: { age: '36', appearance: 'Tall.' }
    })
    vi.setSystemTime(new Date('2026-09-22T11:00:00.000Z'))
    const updated = update(created.id, { fields: { personality: 'Exacting.' } })
    expect(updated).toEqual({
      ...created,
      fields: { age: '36', appearance: 'Tall.', personality: 'Exacting.' },
      modified: '2026-09-22T11:00:00.000Z'
    })
  })

  it('removes a field given as empty and leaves the rest', () => {
    const created = create({
      kind: 'character',
      name: 'Ada',
      fields: { age: '36', appearance: 'Tall.' }
    })
    const updated = update(created.id, { fields: { appearance: '' } })
    expect(updated.fields).toEqual({ age: '36' })
    expect(getEntity(db, created.id)?.fields).toEqual({ age: '36' })
  })

  it('patches the template and the blank page, and clears the page again', () => {
    const created = create({ kind: 'world', name: 'Tide Law' })
    expect(update(created.id, { template: 'blank', body: 'Salt binds.' })).toMatchObject({
      template: 'blank',
      body: 'Salt binds.'
    })
    // The fields the structured template holds are untouched by writing the page.
    expect(update(created.id, { fields: { rules: 'Salt binds.' } })).toMatchObject({
      template: 'blank',
      body: 'Salt binds.',
      fields: { rules: 'Salt binds.' }
    })
    expect(update(created.id, { body: null }).body).toBeNull()
  })

  it('renames, allows a rename to the entity’s own name, and refuses another’s', () => {
    const ada = create({ kind: 'character', name: 'Ada' })
    create({ kind: 'character', name: 'Brann' })
    // The same name in another kind is free.
    create({ kind: 'setting', name: 'Brann' })
    expect(update(ada.id, { name: 'ADA ' }).name).toBe('ADA')
    expectCode(() => update(ada.id, { name: 'brann' }), 'ALREADY_EXISTS')
    expectCode(() => update(ada.id, { name: '  ' }), 'VALIDATION')
    expect(getEntity(db, ada.id)?.name).toBe('ADA')
  })

  it('refuses a field of another kind and an unknown entity', () => {
    const marsh = create({ kind: 'setting', name: 'The Salt Marsh' })
    expectCode(() => update(marsh.id, { fields: { age: '400' } }), 'VALIDATION')
    expectCode(() => update('missing', { name: 'Ada' }), 'NOT_FOUND')
    expect(getEntity(db, marsh.id)?.fields).toEqual({})
  })
})

describe('setEntityImage (F-9.3)', () => {
  it('sets the file name, replaces it, clears it again, and stamps modified', () => {
    vi.useFakeTimers({ now: new Date('2026-09-23T10:00:00.000Z') })
    const ada = create({ kind: 'character', name: 'Ada' })
    vi.setSystemTime(new Date('2026-09-23T11:00:00.000Z'))
    const withImage = setEntityImage(db, ada.id, 'Ada.0a1b2c3d.png')
    expect(withImage).toEqual({
      ...ada,
      image: 'Ada.0a1b2c3d.png',
      modified: '2026-09-23T11:00:00.000Z'
    })
    expect(setEntityImage(db, ada.id, 'Ada.4e5f6a7b.jpg').image).toBe('Ada.4e5f6a7b.jpg')
    expect(setEntityImage(db, ada.id, null).image).toBeNull()
    expect(getEntity(db, ada.id)?.image).toBeNull()
  })

  it('works for a setting and refuses a world item and an unknown id', () => {
    const marsh = create({ kind: 'setting', name: 'The Salt Marsh' })
    expect(setEntityImage(db, marsh.id, 'marsh.0a1b2c3d.png').image).toBe('marsh.0a1b2c3d.png')
    const law = create({ kind: 'world', name: 'Tide Law' })
    expectCode(() => setEntityImage(db, law.id, 'law.0a1b2c3d.png'), 'VALIDATION')
    expect(getEntity(db, law.id)?.image).toBeNull()
    expectCode(() => setEntityImage(db, 'missing', null), 'NOT_FOUND')
  })
})

describe('deleteEntity', () => {
  it('removes the entity, answers it as it stood, and refuses an unknown id', () => {
    const ada = create({ kind: 'character', name: 'Ada' })
    const brann = create({ kind: 'character', name: 'Brann' })
    const withImage = setEntityImage(db, ada.id, 'Ada.0a1b2c3d.png')
    expect(deleteEntity(db, ada.id)).toEqual(withImage)
    expect(getEntity(db, ada.id)).toBeUndefined()
    expect(listEntities(db)).toEqual([brann])
    expectCode(() => deleteEntity(db, 'missing'), 'NOT_FOUND')
  })
})

describe('the tag link (F-9.4)', () => {
  it('creates the tag of the name under the kind’s category and links it', () => {
    const { entity: mara, tagChange } = createEntity(db, { kind: 'character', name: 'Mara Vell' })
    expect(tagChange).toMatchObject({ created: true, renamed: false })
    expect(tagChange?.tag).toMatchObject({ name: 'mara-vell', category: 'character' })
    expect(mara.tagId).toBe(tagChange?.tag.id)
    expect(tagOf(mara.id)).toEqual(tagChange?.tag)
    expect(
      createEntity(db, { kind: 'setting', name: 'The Salt Marsh' }).tagChange?.tag
    ).toMatchObject({ name: 'the-salt-marsh', category: 'setting' })
    expect(createEntity(db, { kind: 'world', name: 'Tide Law' }).tagChange?.tag).toMatchObject({
      name: 'tide-law',
      category: 'worldBuilding'
    })
  })

  it('links the tag the bank already carries, whatever its category, and creates no second one', () => {
    const rose = createTag(db, { name: 'Rose', category: 'plotThread' })
    const { entity: created, tagChange } = createEntity(db, { kind: 'character', name: 'Rose' })
    expect(tagChange).toEqual({ tag: getTagWithUsage(db, rose.id), created: false, renamed: false })
    expect(created.tagId).toBe(rose.id)
    expect(listTags(db).map((t) => t.name)).toEqual(['rose'])
    // A second entity of another kind takes the same tag rather than a duplicate name.
    expect(createEntity(db, { kind: 'setting', name: 'rose' }).tagChange?.tag.id).toBe(rose.id)
    expect(listTags(db)).toHaveLength(1)
  })

  it('creates the entity with no tag when the name yields no tag name', () => {
    const { entity: created, tagChange } = createEntity(db, { kind: 'character', name: '???' })
    expect(created.tagId).toBeNull()
    expect(tagChange).toBeNull()
    expect(listTags(db)).toEqual([])
  })

  it('rolls the entity back with its tag when the write around it fails', () => {
    expect(() =>
      db.transaction(() => {
        create({ kind: 'character', name: 'Mara' })
        throw new Error('nope')
      })
    ).toThrow('nope')
    expect(listEntities(db)).toEqual([])
    expect(listTags(db)).toEqual([])
  })

  it('renames the tag with the entity', () => {
    const mara = create({ kind: 'character', name: 'Mara' })
    const { entity: renamed, tagChange } = updateEntity(db, mara.id, { name: 'Mara Vell' })
    expect(tagChange).toMatchObject({ created: false, renamed: true })
    expect(tagChange?.tag.name).toBe('mara-vell')
    expect(renamed.tagId).toBe(mara.tagId)
    expect(tagOf(mara.id)?.name).toBe('mara-vell')
  })

  it('relinks to the tag that already carries the new name instead of renaming', () => {
    const vell = createTag(db, { name: 'mara-vell', category: 'character' })
    const mara = create({ kind: 'character', name: 'Mara' })
    const { entity: renamed, tagChange } = updateEntity(db, mara.id, { name: 'Mara Vell' })
    expect(tagChange).toEqual({ tag: getTagWithUsage(db, vell.id), created: false, renamed: false })
    expect(renamed.tagId).toBe(vell.id)
    // The tag the entity had is a tag of the bank like any other; it stays.
    expect(listTags(db).map((t) => t.name)).toEqual(['mara', 'mara-vell'])
  })

  it('leaves a tag the author renamed by hand, and one two entities share', () => {
    const mara = create({ kind: 'character', name: 'Mara' })
    updateTag(db, mara.tagId ?? '', { name: 'the-captain' })
    expect(updateEntity(db, mara.id, { name: 'Mara Vell' }).tagChange).toBeNull()
    expect(tagOf(mara.id)?.name).toBe('the-captain')

    const harbor = create({ kind: 'setting', name: 'Harbor' })
    const harborTag = harbor.tagId
    // A world item of the same name takes the setting's tag, so two entities now share it.
    const alsoHarbor = create({ kind: 'world', name: 'Harbor' })
    expect(alsoHarbor.tagId).toBe(harborTag)
    expect(updateEntity(db, harbor.id, { name: 'Old Harbor' }).tagChange).toBeNull()
    expect(tagOf(harbor.id)?.name).toBe('harbor')
    expect(tagOf(alsoHarbor.id)?.name).toBe('harbor')
  })

  it('changes nothing for a patch that is not a rename, or a name with no tag name in it', () => {
    const mara = create({ kind: 'character', name: 'Mara' })
    expect(updateEntity(db, mara.id, { fields: { age: '31' } }).tagChange).toBeNull()
    expect(updateEntity(db, mara.id, { name: 'MARA' }).tagChange).toBeNull()
    expect(updateEntity(db, mara.id, { name: '???' }).tagChange).toBeNull()
    expect(tagOf(mara.id)?.name).toBe('mara')
  })

  it('is cleared, not cascaded, when the tag is deleted, and linkEntityTag makes a new one', () => {
    const rose = create({ kind: 'character', name: 'Rose' })
    const tagId = rose.tagId ?? ''
    deleteTag(db, tagId)
    expect(getEntity(db, rose.id)?.tagId).toBeNull()
    expect(db.select().from(tag).all()).toEqual([])
    const { entity: linked, tagChange } = linkEntityTag(db, rose.id)
    expect(tagChange).toMatchObject({ created: true, renamed: false })
    expect(tagChange.tag).toMatchObject({ name: 'rose', category: 'character' })
    expect(linked.tagId).toBe(tagChange.tag.id)
    expect(tagOf(rose.id)?.id).toBe(tagChange.tag.id)
  })

  it('answers linkEntityTag unchanged for an entity already linked to the tag of its name', () => {
    const mara = create({ kind: 'character', name: 'Mara' })
    const { entity: linked, tagChange } = linkEntityTag(db, mara.id)
    expect(linked).toEqual(mara)
    expect(tagChange).toEqual({
      tag: getTagWithUsage(db, mara.tagId ?? ''),
      created: false,
      renamed: false
    })
    expect(listTags(db)).toHaveLength(1)
  })

  it('refuses linkEntityTag for an unknown id and for a name with no tag name in it', () => {
    expectCode(() => linkEntityTag(db, 'missing'), 'NOT_FOUND')
    const nameless = create({ kind: 'character', name: '???' })
    expectCode(() => linkEntityTag(db, nameless.id), 'VALIDATION')
    expect(listTags(db)).toEqual([])
  })

  it('refuses a tag id that is not in the bank', () => {
    const created = create({ kind: 'character', name: 'Rose' })
    expect(() =>
      db.update(entity).set({ tagId: randomUUID() }).where(eq(entity.id, created.id)).run()
    ).toThrow(/FOREIGN KEY/)
  })
})
