import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { entity, tag } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createTag, deleteTag } from '../tag/tagStore'
import {
  createEntity,
  deleteEntity,
  getEntity,
  listEntities,
  updateEntity,
  type EntityDb
} from './entityStore'

let tmp: string
let session: ProjectSession
let db: EntityDb

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
    const { id, ...created } = createEntity(db, {
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
      tagId: null,
      created: '2026-09-22T10:00:00.000Z',
      modified: '2026-09-22T10:00:00.000Z'
    })
    expect(listEntities(db)).toEqual([{ id, ...created }])
  })

  it('takes a blank page instead of the template', () => {
    const created = createEntity(db, {
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
    const created = createEntity(db, {
      kind: 'setting',
      name: 'The Salt Marsh',
      fields: { atmosphere: 'Low and grey.', description: '', notes: '' }
    })
    expect(created.fields).toEqual({ atmosphere: 'Low and grey.' })
    expect(db.select().from(entity).get()?.fields).toBe('{"atmosphere":"Low and grey."}')
  })

  it('refuses a field that is not of the kind’s template', () => {
    expectCode(
      () => createEntity(db, { kind: 'setting', name: 'Harbor', fields: { age: '400' } }),
      'VALIDATION'
    )
    expectCode(
      () => createEntity(db, { kind: 'world', name: 'Tide', fields: { atmosphere: 'Damp' } }),
      'VALIDATION'
    )
    expect(listEntities(db)).toEqual([])
  })

  it('refuses a name that empties after trimming', () => {
    expectCode(() => createEntity(db, { kind: 'character', name: '   ' }), 'VALIDATION')
    expect(listEntities(db)).toEqual([])
  })

  it('refuses a name another entity of the kind carries, whatever its case or spacing', () => {
    createEntity(db, { kind: 'character', name: 'Ada' })
    expectCode(() => createEntity(db, { kind: 'character', name: 'ada' }), 'ALREADY_EXISTS')
    expectCode(() => createEntity(db, { kind: 'character', name: 'Ada ' }), 'ALREADY_EXISTS')
    expectCode(() => createEntity(db, { kind: 'character', name: ' ADA' }), 'ALREADY_EXISTS')
    expect(listEntities(db)).toHaveLength(1)
  })

  it('allows the same name for a character, a setting, and a world item', () => {
    createEntity(db, { kind: 'character', name: 'Marsh' })
    createEntity(db, { kind: 'setting', name: 'Marsh' })
    createEntity(db, { kind: 'world', name: 'marsh' })
    expect(listEntities(db).map((e) => e.kind)).toEqual(['character', 'setting', 'world'])
  })
})

describe('listEntities / getEntity', () => {
  it('orders by kind, then by name however it is spelled', () => {
    createEntity(db, { kind: 'world', name: 'Tide Law' })
    createEntity(db, { kind: 'setting', name: 'harbor' })
    createEntity(db, { kind: 'character', name: 'brann' })
    createEntity(db, { kind: 'setting', name: 'Blackreach' })
    createEntity(db, { kind: 'character', name: 'Ada' })
    expect(listEntities(db).map((e) => [e.kind, e.name])).toEqual([
      ['character', 'Ada'],
      ['character', 'brann'],
      ['setting', 'Blackreach'],
      ['setting', 'harbor'],
      ['world', 'Tide Law']
    ])
  })

  it('answers one entity and undefined for an unknown id', () => {
    const ada = createEntity(db, { kind: 'character', name: 'Ada', fields: { age: '36' } })
    expect(getEntity(db, ada.id)).toEqual(ada)
    expect(getEntity(db, 'missing')).toBeUndefined()
  })

  it('survives a stored fields cell that no longer parses', () => {
    const ada = createEntity(db, { kind: 'character', name: 'Ada', fields: { age: '36' } })
    db.update(entity).set({ fields: '{oops' }).where(eq(entity.id, ada.id)).run()
    expect(getEntity(db, ada.id)?.fields).toEqual({})
  })
})

describe('updateEntity', () => {
  it('merges the given fields over the stored ones and stamps modified', () => {
    vi.useFakeTimers({ now: new Date('2026-09-22T10:00:00.000Z') })
    const created = createEntity(db, {
      kind: 'character',
      name: 'Ada',
      fields: { age: '36', appearance: 'Tall.' }
    })
    vi.setSystemTime(new Date('2026-09-22T11:00:00.000Z'))
    const updated = updateEntity(db, created.id, { fields: { personality: 'Exacting.' } })
    expect(updated).toEqual({
      ...created,
      fields: { age: '36', appearance: 'Tall.', personality: 'Exacting.' },
      modified: '2026-09-22T11:00:00.000Z'
    })
  })

  it('removes a field given as empty and leaves the rest', () => {
    const created = createEntity(db, {
      kind: 'character',
      name: 'Ada',
      fields: { age: '36', appearance: 'Tall.' }
    })
    const updated = updateEntity(db, created.id, { fields: { appearance: '' } })
    expect(updated.fields).toEqual({ age: '36' })
    expect(getEntity(db, created.id)?.fields).toEqual({ age: '36' })
  })

  it('patches the template and the blank page, and clears the page again', () => {
    const created = createEntity(db, { kind: 'world', name: 'Tide Law' })
    expect(updateEntity(db, created.id, { template: 'blank', body: 'Salt binds.' })).toMatchObject({
      template: 'blank',
      body: 'Salt binds.'
    })
    // The fields the structured template holds are untouched by writing the page.
    expect(updateEntity(db, created.id, { fields: { rules: 'Salt binds.' } })).toMatchObject({
      template: 'blank',
      body: 'Salt binds.',
      fields: { rules: 'Salt binds.' }
    })
    expect(updateEntity(db, created.id, { body: null }).body).toBeNull()
  })

  it('renames, allows a rename to the entity’s own name, and refuses another’s', () => {
    const ada = createEntity(db, { kind: 'character', name: 'Ada' })
    createEntity(db, { kind: 'character', name: 'Brann' })
    // The same name in another kind is free.
    createEntity(db, { kind: 'setting', name: 'Brann' })
    expect(updateEntity(db, ada.id, { name: 'ADA ' }).name).toBe('ADA')
    expectCode(() => updateEntity(db, ada.id, { name: 'brann' }), 'ALREADY_EXISTS')
    expectCode(() => updateEntity(db, ada.id, { name: '  ' }), 'VALIDATION')
    expect(getEntity(db, ada.id)?.name).toBe('ADA')
  })

  it('refuses a field of another kind and an unknown entity', () => {
    const marsh = createEntity(db, { kind: 'setting', name: 'The Salt Marsh' })
    expectCode(() => updateEntity(db, marsh.id, { fields: { age: '400' } }), 'VALIDATION')
    expectCode(() => updateEntity(db, 'missing', { name: 'Ada' }), 'NOT_FOUND')
    expect(getEntity(db, marsh.id)?.fields).toEqual({})
  })
})

describe('deleteEntity', () => {
  it('removes the entity and refuses an unknown id', () => {
    const ada = createEntity(db, { kind: 'character', name: 'Ada' })
    const brann = createEntity(db, { kind: 'character', name: 'Brann' })
    deleteEntity(db, ada.id)
    expect(getEntity(db, ada.id)).toBeUndefined()
    expect(listEntities(db)).toEqual([brann])
    expectCode(() => deleteEntity(db, 'missing'), 'NOT_FOUND')
  })
})

describe('the tag link (F-9.4 writes it)', () => {
  it('is cleared, not cascaded, when the tag is deleted', () => {
    const rose = createTag(db, { name: 'Rose', category: 'character' })
    const created = createEntity(db, { kind: 'character', name: 'Rose' })
    // F-9.4 owns the write path; here the column is set directly, as a linked row would be.
    db.update(entity).set({ tagId: rose.id }).where(eq(entity.id, created.id)).run()
    expect(getEntity(db, created.id)?.tagId).toBe(rose.id)
    deleteTag(db, rose.id)
    expect(getEntity(db, created.id)?.tagId).toBeNull()
    expect(db.select().from(tag).all()).toEqual([])
  })

  it('refuses a tag id that is not in the bank', () => {
    const created = createEntity(db, { kind: 'character', name: 'Rose' })
    expect(() =>
      db.update(entity).set({ tagId: randomUUID() }).where(eq(entity.id, created.id)).run()
    ).toThrow(/FOREIGN KEY/)
  })
})
