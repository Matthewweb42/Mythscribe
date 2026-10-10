import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { builtinCategory } from '@shared/categories'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { setCategoryFields } from './categoryFields'
import { createCategory, listCategories, updateCategory } from './categoryStore'
import { addEntityField, createEntity, getEntity, updateEntity, type EntityDb } from './entityStore'

let tmp: string
let session: ProjectSession
let db: EntityDb

const character = (): ReturnType<typeof listCategories>[number] => {
  const found = listCategories(db).find((category) => category.id === 'character')
  if (found === undefined) throw new Error('no Characters')
  return found
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-category-fields-'))
  session = createProject(projectFolderFor(tmp, 'Bible'), 'Bible', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('setCategoryFields (F-9.19)', () => {
  it('renames, reorders, and adds the fields of a library category, keeping every sheet’s text', () => {
    const mara = createEntity(db, {
      kind: 'character',
      name: 'Mara',
      fields: { age: '27', appearance: 'A scar.' }
    }).entity
    const { category, entities } = setCategoryFields(db, 'character', [
      { id: 'appearance', label: 'Looks', multiline: true },
      { id: 'age', label: 'Age', multiline: false },
      { label: 'Weapon', multiline: true }
    ])
    expect(category.fields).toEqual([
      { id: 'appearance', label: 'Looks', multiline: true },
      { id: 'age', label: 'Age', multiline: false },
      { id: 'weapon', label: 'Weapon', multiline: true },
      { id: 'notes', label: 'Notes', multiline: true }
    ])
    expect(character().fields).toEqual(category.fields)
    // Every removed field held nothing on Mara: no sheet moved.
    expect(entities).toEqual([])
    expect(getEntity(db, mara.id)?.fields).toEqual({ age: '27', appearance: 'A scar.' })
    // The new field takes values like any other.
    expect(updateEntity(db, mara.id, { fields: { weapon: 'A bow.' } }).entity.fields.weapon).toBe(
      'A bow.'
    )
  })

  it('moves a removed field’s text into Notes and leaves the sheet’s own fields alone', () => {
    const mara = createEntity(db, {
      kind: 'character',
      name: 'Mara',
      fields: { age: '27', goals: 'Find Pell.', notes: 'Fears boats.' }
    }).entity
    addEntityField(db, mara.id, 'Weapon')
    updateEntity(db, mara.id, { fields: { weapon: 'A bow.' } })
    const kept = builtinCategory('character')?.fields.filter((field) => field.id !== 'goals') ?? []
    const { entities } = setCategoryFields(db, 'character', kept)
    expect(entities.map((sheet) => sheet.id)).toEqual([mara.id])
    expect(getEntity(db, mara.id)?.fields).toEqual({
      age: '27',
      notes: 'Fears boats.\n\nGoals / motivations: Find Pell.',
      weapon: 'A bow.'
    })
  })

  it('keeps a rename of the category and its edited fields together', () => {
    setCategoryFields(db, 'setting', [{ id: 'type', label: 'Kind of place', multiline: false }])
    updateCategory(db, 'setting', { name: 'Locations' })
    const setting = listCategories(db).find((category) => category.id === 'setting')
    expect(setting?.name).toBe('Locations')
    expect(setting?.fields.map((field) => field.label)).toEqual(['Kind of place', 'Notes'])
  })

  it('edits a project category’s own template', () => {
    const made = createCategory(db, { name: 'Ships', fields: ['Crew'] }, 'author')
    const { category } = setCategoryFields(db, made.id, [
      { id: 'crew', label: 'Crew', multiline: true },
      { label: 'Captain', multiline: false }
    ])
    expect(category.fields.map((field) => field.id)).toEqual(['crew', 'captain', 'notes'])
    expect(listCategories(db).find((each) => each.id === made.id)?.fields).toEqual(category.fields)
  })

  it('refuses Threads, a repeated name, and an unknown category', () => {
    expectCode(() => setCategoryFields(db, 'thread', []), 'VALIDATION')
    expectCode(
      () =>
        setCategoryFields(db, 'character', [
          { label: 'Age', multiline: false },
          { label: 'age', multiline: false }
        ]),
      'ALREADY_EXISTS'
    )
    expectCode(() => setCategoryFields(db, 'nope', []), 'NOT_FOUND')
  })
})
