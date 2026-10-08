import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORY_IDS } from '@shared/categories'
import { storyCategory } from '../db/schema'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listTags } from '../tag/tagStore'
import {
  createCategory,
  hasCategory,
  listCategories,
  requireCategory,
  updateCategory
} from './categoryStore'
import {
  createEntity,
  listEntities,
  setEntityImage,
  updateEntity,
  type EntityDb
} from './entityStore'

let tmp: string
let session: ProjectSession
let db: EntityDb

function codeOf(fn: () => unknown): string | null {
  try {
    fn()
  } catch (err) {
    if (err instanceof AppError) return err.code
    throw err
  }
  return null
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-categories-'))
  session = createProject(projectFolderFor(tmp, 'Categories'), 'Categories', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('categoryStore (F-9.11)', () => {
  it('lists the library in order for a new project, and nothing of its own', () => {
    expect(listCategories(db).map((c) => c.id)).toEqual(BUILTIN_CATEGORY_IDS)
    expect(hasCategory(db, 'magic')).toBe(true)
    expect(hasCategory(db, 'c-ships')).toBe(false)
    expect(codeOf(() => requireCategory(db, 'c-ships'))).toBe('VALIDATION')
  })

  it('adds a project category after the library, with Notes last, and refuses a taken name', () => {
    const ships = createCategory(db, { name: 'Ships', fields: ['Crew', 'Home port'] }, 'author')
    expect(ships).toMatchObject({ id: 'c-ships', noun: 'ship', origin: 'author', builtIn: false })
    expect(ships.fields.map((f) => f.id)).toEqual(['crew', 'homePort', 'notes'])
    expect(listCategories(db).at(-1)).toEqual(ships)
    expect(codeOf(() => createCategory(db, { name: ' ships ', fields: [] }, 'author'))).toBe(
      'ALREADY_EXISTS'
    )
    expect(codeOf(() => createCategory(db, { name: 'magic systems', fields: [] }, 'ai'))).toBe(
      'ALREADY_EXISTS'
    )
  })

  it('renames a library category with a rename row and keeps its template', () => {
    const places = updateCategory(db, 'setting', { name: 'Locations', noun: 'location' })
    expect(places).toMatchObject({ id: 'setting', name: 'Locations', noun: 'location' })
    expect(places.fields.map((f) => f.id)).toContain('atmosphere')
    expect(listCategories(db).find((c) => c.id === 'setting')?.name).toBe('Locations')
    expect(db.select().from(storyCategory).all()).toEqual([
      expect.objectContaining({ id: 'setting', fields: null })
    ])
    // A second rename updates the same row.
    updateCategory(db, 'setting', { icon: 'castle' })
    expect(db.select().from(storyCategory).all()).toHaveLength(1)
    expect(listCategories(db).find((c) => c.id === 'setting')).toMatchObject({
      name: 'Locations',
      icon: 'castle'
    })
    expect(codeOf(() => updateCategory(db, 'c-none', { name: 'X' }))).toBe('NOT_FOUND')
    expect(codeOf(() => updateCategory(db, 'world', { name: 'characters' }))).toBe('ALREADY_EXISTS')
  })

  it('renames a project category in place', () => {
    createCategory(db, { name: 'Ships', fields: ['Crew'] }, 'ai')
    updateCategory(db, 'c-ships', { name: 'Vessels' })
    expect(listCategories(db).at(-1)).toMatchObject({ id: 'c-ships', name: 'Vessels' })
  })
})

describe('sheets in categories (F-9.11)', () => {
  it('creates a sheet in a library category with its template, tagged as world building', () => {
    const weave = createEntity(db, {
      kind: 'magic',
      name: 'The Weave',
      fields: { costs: 'A memory per knot' }
    }).entity
    expect(weave).toMatchObject({ kind: 'magic', fields: { costs: 'A memory per knot' } })
    expect(listTags(db).find((t) => t.name === 'the-weave')?.category).toBe('worldBuilding')
    expect(
      codeOf(() => createEntity(db, { kind: 'magic', name: 'Other', fields: { age: '3' } }))
    ).toBe('VALIDATION')
    expect(codeOf(() => setEntityImage(db, weave.id, 'x.png'))).toBe('VALIDATION')
  })

  it('creates a sheet in a project category and refuses an unknown category', () => {
    createCategory(db, { name: 'Ships', fields: ['Crew'] }, 'author')
    const gull = createEntity(db, { kind: 'c-ships', name: 'The Gull', fields: { crew: '12' } })
    expect(gull.entity.fields).toEqual({ crew: '12' })
    expect(updateEntity(db, gull.entity.id, { fields: { crew: '' } }).entity.fields).toEqual({})
    expect(codeOf(() => createEntity(db, { kind: 'c-boats', name: 'Nope' }))).toBe('VALIDATION')
  })

  it('lists sheets in category order: the library, then the project’s own', () => {
    createCategory(db, { name: 'Ships', fields: [] }, 'author')
    createEntity(db, { kind: 'c-ships', name: 'Gull' })
    createEntity(db, { kind: 'magic', name: 'Weave' })
    createEntity(db, { kind: 'world', name: 'Tides' })
    createEntity(db, { kind: 'character', name: 'Mara' })
    expect(listEntities(db).map((e) => e.kind)).toEqual(['character', 'world', 'magic', 'c-ships'])
  })

  it('allows the same name in two categories', () => {
    createEntity(db, { kind: 'world', name: 'The Weave' })
    expect(codeOf(() => createEntity(db, { kind: 'magic', name: 'The Weave' }))).toBeNull()
    expect(codeOf(() => createEntity(db, { kind: 'magic', name: 'the weave' }))).toBe(
      'ALREADY_EXISTS'
    )
  })
})
