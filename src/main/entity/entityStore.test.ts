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
import { getObservedDismissed } from '../project/settingsStore'
import { listNodes } from '../tree/treeStore'
import { createTag, deleteTag, getTagWithUsage, listTags, updateTag } from '../tag/tagStore'
import {
  addEntityAliases,
  addEntityField,
  removeEntityField,
  createEntity,
  deleteEntity,
  getEntity,
  linkEntityTag,
  listEntities,
  mergeEntities,
  setEntityImage,
  updateEntity,
  type EntityDb
} from './entityStore'
import { listFactsForEntity, applySceneFacts, setFactHidden } from './factStore'

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
      aliases: [],
      origin: 'author',
      status: 'canon',
      created: '2026-09-22T10:00:00.000Z',
      modified: '2026-09-22T10:00:00.000Z',
      // F-9.18: no field of its own; fields with text and no page yet: the page is out of date.
      extraFields: [],
      sync: { state: 'pageStale', aiParagraphs: 0, paragraphs: 0, writtenUpAt: null, pending: null }
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

describe('origin and dismissed names (F-5.16)', () => {
  /** Logs one fact about the entity from the seeded scene. */
  function logFact(entityId: string): void {
    const scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)
    if (scene === undefined) throw new Error('the seeded project has no scene')
    applySceneFacts(
      db,
      scene.id,
      [{ entityId, attribute: 'age', value: 'nineteen', quote: 'She was nineteen.' }],
      ''
    )
  }

  it('marks an entity the story-bible job creates, with its tag, and the author’s own not', () => {
    const { entity: made, tagChange } = createEntity(
      db,
      { kind: 'character', name: 'Tash', template: 'blank' },
      'ai'
    )
    expect(made).toMatchObject({ origin: 'ai', template: 'blank' })
    expect(tagChange).toMatchObject({ created: true, tag: { name: 'tash' } })
    expect(getEntity(db, made.id)?.origin).toBe('ai')
    expect(create({ kind: 'character', name: 'Mara' }).origin).toBe('author')
  })

  it('turns an AI-made entity into the author’s on the first edit of its name, fields, or page', () => {
    const make = (name: string): Entity =>
      createEntity(db, { kind: 'character', name }, 'ai').entity
    expect(update(make('Ash').id, { name: 'Ashe' }).origin).toBe('author')
    expect(update(make('Bren').id, { fields: { age: '40' } }).origin).toBe('author')
    expect(update(make('Cole').id, { body: 'A smith.' }).origin).toBe('author')
    // Reading the sheet in the other template is not writing it.
    const dara = make('Dara')
    expect(update(dara.id, { template: 'structured' }).origin).toBe('ai')
    expect(setEntityImage(db, dara.id, 'Dara.0a1b2c3d.png').origin).toBe('ai')
    expect(linkEntityTag(db, dara.id).entity.origin).toBe('ai')
    // Nothing turns it back.
    expect(update(dara.id, { body: 'Hers.' }).origin).toBe('author')
    expect(update(dara.id, { template: 'blank' }).origin).toBe('author')
  })

  it('remembers a deleted entity the manuscript had facts about, hidden ones included', () => {
    const tash = createEntity(db, { kind: 'character', name: 'Tash  Vane' }, 'ai').entity
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }, 'author', {
      tag: false
    }).entity
    logFact(tash.id)
    setFactHidden(db, listFactsForEntity(db, tash.id)[0]?.id ?? '', true)
    deleteEntity(db, tash.id)
    // Mara had no facts and no tag: nothing to keep the job or a record hook from, so nothing
    // is recorded (a tagged sheet is: F-9.12, `records.test.ts`).
    deleteEntity(db, mara.id)
    expect(getObservedDismissed(db)).toEqual({
      names: [{ kind: 'character', nameKey: 'tash vane' }]
    })
    expect(listFactsForEntity(db, tash.id)).toEqual([])
  })

  it('forgets the dismissal when the author creates the entity by hand, not when the job does', () => {
    const tash = create({ kind: 'character', name: 'Tash' })
    logFact(tash.id)
    deleteEntity(db, tash.id)
    createEntity(db, { kind: 'character', name: 'Tash' }, 'ai')
    create({ kind: 'setting', name: 'Tash' })
    expect(getObservedDismissed(db).names).toEqual([{ kind: 'character', nameKey: 'tash' }])
    deleteEntity(db, listEntities(db).find((row) => row.kind === 'character')?.id ?? '')
    create({ kind: 'character', name: ' tash ' })
    expect(getObservedDismissed(db).names).toEqual([])
  })

  it('remembers a deleted AI-made entity whose facts were gone by the time it was deleted', () => {
    const tash = createEntity(
      db,
      { kind: 'character', name: 'Tash', template: 'blank' },
      'ai'
    ).entity
    logFact(tash.id)
    // The scene was edited and re-read, and no longer states anything about Tash.
    const scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)
    applySceneFacts(db, scene?.id ?? '', [], '')
    expect(listFactsForEntity(db, tash.id)).toEqual([])
    deleteEntity(db, tash.id)
    // Still the AI's entity, and the author deleted it: the next scene must not bring it back.
    expect(getObservedDismissed(db).names).toEqual([{ kind: 'character', nameKey: 'tash' }])
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
    expect(tagChange).toEqual({
      tag: getTagWithUsage(db, rose.id),
      created: false,
      renamed: false,
      aliased: false
    })
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
    expect(tagChange).toEqual({
      tag: getTagWithUsage(db, vell.id),
      created: false,
      renamed: false,
      aliased: false
    })
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
      renamed: false,
      aliased: false
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

describe('aliases (F-4.14)', () => {
  it('reads and writes a linked sheet’s aliases on its tag: one owner', () => {
    const rynna = create({ kind: 'character', name: 'Rynna Falsire' })
    const { entity: updated, tagChange } = updateEntity(db, rynna.id, {
      aliases: ['Rynna', 'High Crown Falsire']
    })
    expect(updated.aliases).toEqual(['Rynna', 'High Crown Falsire'])
    expect(getTagWithUsage(db, rynna.tagId ?? '')?.aliases).toEqual(['Rynna', 'High Crown Falsire'])
    expect(tagChange).toMatchObject({ created: false, renamed: false, aliased: true })
    expect(db.select().from(entity).where(eq(entity.id, rynna.id)).get()?.aliases).toBe('[]')
    // Editing the tag shows on the sheet.
    updateTag(db, rynna.tagId ?? '', { aliases: ['Rynna'] })
    expect(getEntity(db, rynna.id)?.aliases).toEqual(['Rynna'])
    expect(listEntities(db)[0]?.aliases).toEqual(['Rynna'])
  })

  it('keeps an untagged sheet’s aliases on the sheet, and moves them to the tag it is linked to', () => {
    const { entity: notes } = createEntity(db, { kind: 'character', name: 'Kael' }, 'author', {
      tag: false
    })
    const { entity: aliased, tagChange } = updateEntity(db, notes.id, { aliases: ['The Smith'] })
    expect(aliased.aliases).toEqual(['The Smith'])
    expect(tagChange).toBeNull()
    const linked = linkEntityTag(db, notes.id)
    expect(linked.entity.aliases).toEqual(['The Smith'])
    expect(linked.tagChange.tag.aliases).toEqual(['The Smith'])
  })

  it('refuses an alias another tag owns', () => {
    create({ kind: 'character', name: 'Kael' })
    const rynna = create({ kind: 'character', name: 'Rynna' })
    expectCode(() => updateEntity(db, rynna.id, { aliases: ['Kael'] }), 'ALREADY_EXISTS')
  })

  it('adds names without refusing any, skipping the sheet’s own name and other tags’ names', () => {
    create({ kind: 'character', name: 'Kael' })
    const rynna = create({ kind: 'character', name: 'Rynna Falsire' })
    const write = addEntityAliases(db, rynna.id, ['Rynna Falsire', 'Rynna', 'Kael'])
    expect(write.entity.aliases).toEqual(['Rynna'])
    expect(write.tagChange?.aliased).toBe(true)
    expect(addEntityAliases(db, rynna.id, ['Rynna']).tagChange).toBeNull()
  })
})

describe('moving a sheet into another category (F-9.10)', () => {
  it('refiles the values the new template lacks into Notes and checks the name there', () => {
    const kael = create({
      kind: 'character',
      name: 'Kael',
      fields: { age: '40', appearance: 'Grey stone walls', notes: 'Old.' }
    })
    const moved = update(kael.id, { kind: 'setting' })
    expect(moved.kind).toBe('setting')
    expect(moved.fields.notes).toBe('Old.\n\nAge: 40\n\nAppearance: Grey stone walls')
    expect(moved.fields.age).toBeUndefined()
    create({ kind: 'world', name: 'Mara' })
    const mara = create({ kind: 'character', name: 'Mara' })
    expectCode(() => update(mara.id, { kind: 'world' }), 'ALREADY_EXISTS')
    expectCode(() => update(mara.id, { kind: 'no-such' }), 'VALIDATION')
  })

  it('takes fields of the new template in the same patch, and moves back for Undo', () => {
    const ash = create({ kind: 'world', name: 'Ashfall', fields: { description: 'A war.' } })
    const moved = update(ash.id, { kind: 'history', fields: { when: 'Year 12' } })
    expect(moved.kind).toBe('history')
    expect(moved.fields.when).toBe('Year 12')
    const back = update(ash.id, { kind: 'world', fields: { description: 'A war.', notes: '' } })
    expect(back.kind).toBe('world')
    expect(back.fields.description).toBe('A war.')
  })
})

describe('mergeEntities (F-9.10)', () => {
  it('fills empty fields, adds differing ones, joins pages, keeps names as aliases, and deletes the sources', () => {
    const rynna = create({ kind: 'character', name: 'Rynna Falsire', fields: { age: '19' } })
    const crown = create({
      kind: 'character',
      name: 'High Crown Falsire',
      fields: { age: '20', background: 'Crowned at the Ashfall.' },
      body: 'Her page.'
    })
    const write = mergeEntities(db, rynna.id, [crown.id])
    expect(write.entity.fields).toEqual({ age: '19\n\n20', background: 'Crowned at the Ashfall.' })
    expect(write.entity.body).toBe('Her page.')
    expect(write.entity.aliases).toContain('High Crown Falsire')
    expect(write.removed.map((r) => r.id)).toEqual([crown.id])
    expect(getEntity(db, crown.id)).toBeUndefined()
    // The tags were merged: one tag, the merged one's name an alias of it.
    expect(write.tagMerge?.removedIds).toEqual([crown.tagId])
    expect(listTags(db).map((t) => t.name)).not.toContain('high-crown-falsire')
  })

  it('moves the observed facts, refiles a field of another category, and refuses itself', () => {
    const scene = listNodes(db).find((node) => node.kind === 'document')
    const mill = create({ kind: 'setting', name: 'The Mill' })
    const other = create({ kind: 'character', name: 'Mill Keeper', fields: { age: '60' } })
    applySceneFacts(
      db,
      scene?.id ?? '',
      [{ entityId: other.id, attribute: 'age', value: 'sixty', quote: 'He was sixty.' }],
      ''
    )
    const write = mergeEntities(db, mill.id, [other.id])
    expect(write.entity.fields.notes).toBe('Age: 60')
    expect(listFactsForEntity(db, mill.id).map((f) => f.value)).toEqual(['sixty'])
    expectCode(() => mergeEntities(db, mill.id, [mill.id]), 'VALIDATION')
    expectCode(() => mergeEntities(db, mill.id, ['nope']), 'NOT_FOUND')
  })
})

describe('a sheet’s own fields (F-9.18)', () => {
  it('adds one beside the template, takes values in it, and keeps the template as it was', () => {
    const mara = create({ kind: 'character', name: 'Mara' })
    const added = addEntityField(db, mara.id, '  Weapon  ')
    expect(added.extraFields).toEqual([{ id: 'weapon', label: 'Weapon', multiline: true }])
    expect(update(mara.id, { fields: { weapon: 'A bone bow.' } }).fields.weapon).toBe('A bone bow.')
    // Another character has no such field.
    const kael = create({ kind: 'character', name: 'Kael' })
    expectCode(() => update(kael.id, { fields: { weapon: 'x' } }), 'VALIDATION')
    // A label the sheet already has, of its category or its own, is refused.
    expectCode(() => addEntityField(db, mara.id, 'weapon'), 'ALREADY_EXISTS')
    expectCode(() => addEntityField(db, mara.id, 'Age'), 'ALREADY_EXISTS')
  })

  it('removes one by moving its text into Notes, so nothing is lost', () => {
    const mara = create({ kind: 'character', name: 'Mara', fields: { notes: 'Fears boats.' } })
    addEntityField(db, mara.id, 'Weapon')
    update(mara.id, { fields: { weapon: 'A bone bow.' } })
    const after = removeEntityField(db, mara.id, 'weapon')
    expect(after.extraFields).toEqual([])
    expect(after.fields).toEqual({ notes: 'Fears boats.\n\nWeapon: A bone bow.' })
    expectCode(() => removeEntityField(db, mara.id, 'weapon'), 'NOT_FOUND')
    expectCode(() => removeEntityField(db, mara.id, 'age'), 'NOT_FOUND')
  })
})
