import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CSV_BOM,
  planEntityImport,
  serializeEntitiesJson,
  toExchangeRecord,
  type EntityExchangeRecord,
  type EntityImportItem
} from '@shared/entityExchange'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listTags } from '../tag/tagStore'
import { importEntities, readEntityFile, writeEntityFile } from './entityExchange'
import { createEntity, listEntities, type EntityDb } from './entityStore'

let tmp: string
let session: ProjectSession
let db: EntityDb

const record = (over: Partial<EntityExchangeRecord> = {}): EntityExchangeRecord => ({
  kind: 'character',
  name: 'Ilse',
  template: 'structured',
  fields: { age: '30' },
  body: null,
  ...over
})

/** The plan for a file's records against what is stored, with every row left at its default. */
function plan(records: readonly EntityExchangeRecord[]): EntityImportItem[] {
  return planEntityImport(listEntities(db), records).items
}

function write(name: string, text: string): string {
  const file = path.join(tmp, name)
  fs.writeFileSync(file, text)
  return file
}

function expectCode(fn: () => unknown, code: AppError['code']): AppError {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    expect((err as AppError).code).toBe(code)
    return err as AppError
  }
  throw new Error(`expected ${code}`)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-exchange-'))
  session = createProject(projectFolderFor(tmp, 'Bible'), 'Bible', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('writeEntityFile / readEntityFile', () => {
  it('round-trips a JSON library of every kind', () => {
    const records = [
      record(),
      record({ kind: 'setting', name: 'Harbour', fields: { atmosphere: 'Salt air' } }),
      record({
        kind: 'world',
        name: 'Tide Law',
        template: 'blank',
        fields: {},
        body: 'Salt binds.'
      })
    ]
    const file = path.join(tmp, 'library.json')
    writeEntityFile(file, 'json', records)
    expect(fs.existsSync(`${file}.tmp`)).toBe(false)
    expect(readEntityFile(file, 'character')).toEqual({
      name: 'library.json',
      format: 'json',
      records
    })
  })

  it('round-trips a CSV and writes it for a spreadsheet', () => {
    const records = [record({ fields: { age: '30', goals: 'Find the ship, then rest.' } })]
    const file = path.join(tmp, 'characters.csv')
    writeEntityFile(file, 'csv', records)
    const text = fs.readFileSync(file, 'utf8')
    expect(text.startsWith(CSV_BOM)).toBe(true)
    expect(readEntityFile(file, 'character')).toEqual({
      name: 'characters.csv',
      format: 'csv',
      records
    })
  })

  it('reads a bare CSV as the kind the import was started from', () => {
    const file = write('list.csv', 'name,description\r\nThe Guild,A cartel of pilots.\r\n')
    expect(readEntityFile(file, 'world').records).toEqual([
      {
        kind: 'world',
        name: 'The Guild',
        template: 'structured',
        fields: { description: 'A cartel of pilots.' },
        body: null
      }
    ])
  })

  it('refuses an unsupported extension, an unreadable file, another format, and an empty one', () => {
    expect(
      expectCode(() => readEntityFile(write('a.txt', 'x'), 'character'), 'VALIDATION').message
    ).toMatch(/^Unsupported file type/)
    expect(
      expectCode(() => readEntityFile(path.join(tmp, 'missing.json'), 'character'), 'VALIDATION')
        .message
    ).toMatch(/^Could not read the file/)
    expect(
      expectCode(
        () => readEntityFile(write('other.json', '{"format":"x"}'), 'character'),
        'VALIDATION'
      ).message
    ).toBe('That file is not a MythScribe entity file.')
    expect(
      expectCode(
        () => readEntityFile(write('empty.json', serializeEntitiesJson([])), 'character'),
        'VALIDATION'
      ).message
    ).toBe('That file has no entities to import.')
    expect(
      expectCode(() => readEntityFile(write('empty.csv', 'name\r\n'), 'character'), 'VALIDATION')
        .message
    ).toBe('That file has no entities to import.')
  })

  it('names the row a bad value is in', () => {
    const file = write('rows.csv', 'kind,name\r\ncharacter,Ilse\r\ndragonkin,Wyrm\r\n')
    const error = expectCode(() => readEntityFile(file, 'character'), 'VALIDATION')
    expect(error.message).toBe('Row 2: "dragonkin" is not a category of this project')
    expect(error.details).toMatchObject({ row: 2 })
  })
})

describe('importEntities', () => {
  it('adds the new rows, with their tags, and answers the counts', () => {
    const items = plan([
      record(),
      record({ kind: 'setting', name: 'Harbour', fields: { atmosphere: 'Salt air' } })
    ])
    expect(items.map((item) => item.action)).toEqual(['add', 'add'])
    const result = importEntities(db, items)
    expect(result).toMatchObject({ added: 2, merged: 0, replaced: 0 })
    expect(result.entities.map((entity) => [entity.kind, entity.name])).toEqual([
      ['character', 'Ilse'],
      ['setting', 'Harbour']
    ])
    expect(result.entities.every((entity) => entity.tagId !== null)).toBe(true)
    // F-9.4: an import creates or links the tag of each new entity, like any other creation.
    expect(result.tagChanges.map((change) => [change.tag.name, change.created])).toEqual([
      ['ilse', true],
      ['harbour', true]
    ])
    expect(listTags(db).map((tag) => tag.name)).toEqual(['harbour', 'ilse'])
  })

  it('merge fills only the empty values; replace overwrites them', () => {
    createEntity(db, {
      kind: 'character',
      name: 'Mara Vell',
      fields: { age: '31' },
      body: null
    })
    const incoming = record({
      name: 'mara vell',
      fields: { age: '99', background: 'Born at sea.' },
      body: 'From the file.'
    })
    const [merge] = plan([incoming])
    if (!merge) throw new Error('expected a row')
    expect(merge.action).toBe('merge')
    const merged = importEntities(db, [merge])
    expect(merged).toMatchObject({ added: 0, merged: 1, replaced: 0 })
    expect(merged.entities[0]).toMatchObject({
      name: 'Mara Vell',
      fields: { age: '31', background: 'Born at sea.' },
      body: 'From the file.'
    })
    // Nothing was created in the bank, so nothing is announced.
    expect(merged.tagChanges).toEqual([])

    const replaced = importEntities(db, [{ ...merge, action: 'replace' }])
    expect(replaced).toMatchObject({ added: 0, merged: 0, replaced: 1 })
    expect(replaced.entities[0]).toMatchObject({
      fields: { age: '99', background: 'Born at sea.' }
    })
  })

  it('skips what the author skipped and writes nothing for it', () => {
    const items = plan([record(), record({ name: 'Tomas' })])
    const result = importEntities(
      db,
      items.map((item, index) => (index === 0 ? { ...item, action: 'skip' as const } : item))
    )
    expect(result).toMatchObject({ added: 1, merged: 0, replaced: 0 })
    expect(listEntities(db).map((entity) => entity.name)).toEqual(['Tomas'])
  })

  it('rolls the whole import back when a name was taken since the plan was made', () => {
    const items = plan([record(), record({ name: 'Tomas' })])
    createEntity(db, { kind: 'character', name: 'Tomas' })
    expectCode(() => importEntities(db, items), 'ALREADY_EXISTS')
    expect(listEntities(db).map((entity) => entity.name)).toEqual(['Tomas'])
  })

  it('reports an entity deleted since the plan was made as NOT_FOUND', () => {
    createEntity(db, { kind: 'character', name: 'Ilse' })
    const items = plan([record({ fields: { goals: 'Sail.' } })])
    expect(items[0]?.action).toBe('merge')
    expectCode(() => importEntities(db, [{ ...items[0]!, existingId: 'gone' }]), 'NOT_FOUND')
  })

  it('an import of a project’s own export changes nothing but the stamp', () => {
    createEntity(db, { kind: 'character', name: 'Ilse', fields: { age: '30' } })
    const before = listEntities(db)
    const items = plan(before.map((entity) => toExchangeRecord(entity)))
    expect(items.map((item) => item.action)).toEqual(['merge'])
    const result = importEntities(db, items)
    expect(result).toMatchObject({ added: 0, merged: 1, replaced: 0 })
    expect(result.entities[0]).toMatchObject({
      name: 'Ilse',
      fields: { age: '30' },
      body: null
    })
  })
})
