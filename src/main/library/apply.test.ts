import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  planContextReview,
  PROJECT_NOTES_NAME,
  type ContextRecord,
  type ContextReview
} from '@shared/contextLibrary'
import { ENTITY_IMAGES_DIR } from '@shared/entities'
import { createEntity, getEntity, listEntities } from '../entity/entityStore'
import { assetDir } from '../project/imageAssets'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listTags } from '../tag/tagStore'
import { applyContextReview } from './apply'
import { addContextFiles, listContextFiles, type LibraryDb } from './libraryStore'

let tmp: string
let session: ProjectSession
let db: LibraryDb
let fileId: string
let imageId: string

const record = (over: Partial<ContextRecord> & Pick<ContextRecord, 'name'>): ContextRecord => ({
  id: `r-${over.name}`,
  fileId,
  fileName: 'people.md',
  kind: 'character',
  aliases: [],
  fields: {},
  details: [],
  ...over
})

function reviewOf(records: ContextRecord[], notes: string[] = [], images = false): ContextReview {
  const plan = planContextReview({
    records,
    existing: listEntities(db),
    images: images ? [{ id: imageId, name: 'mara-portrait.png' }] : [],
    hints: [],
    notes
  })
  return {
    fileIds: images ? [fileId, imageId] : [fileId],
    entities: plan.entities,
    notes: plan.notes,
    proposalIds: [],
    chunks: 1,
    usage: { inputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    model: 'gpt-5.4',
    promptVersion: 'contextImport.v1'
  }
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-apply-'))
  session = createProject(projectFolderFor(tmp, 'Apply'), 'Apply', 'novel')
  db = session.connection.orm
  const added = await addContextFiles(db, session.folder, [
    { name: 'people.md', read: () => Buffer.from('Mara is 35.', 'utf8') },
    { name: 'mara-portrait.png', read: () => Buffer.from([137, 80, 78, 71]) }
  ])
  const byName = Object.fromEntries(added.files.map((file) => [file.name, file.id]))
  fileId = byName['people.md']!
  imageId = byName['mara-portrait.png']!
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('applyContextReview (F-9.8)', () => {
  it('creates sheets with tags, fills and resolves conflicts as picked, and writes Project notes', async () => {
    const mara = createEntity(db, {
      kind: 'character',
      name: 'Mara Vell',
      fields: { age: '34', notes: 'Old note.' }
    }).entity
    const review = reviewOf(
      [
        record({
          name: 'Mara Vell',
          fields: { age: '35', appearance: 'Grey eyes' },
          details: ['History: ran the ferry.']
        }),
        record({
          name: 'Tomas',
          fields: { relationships: 'Brother of Mara' },
          details: ['Debts: owes the mill.']
        })
      ],
      ['Theme: debts.']
    )
    const result = await applyContextReview(db, session.folder, review)

    expect(result).toMatchObject({ created: 1, updated: 1, notes: true })
    const kept = getEntity(db, mara.id)!
    expect(kept.fields).toEqual({
      age: '34',
      appearance: 'Grey eyes',
      notes: 'Old note.\n\nHistory: ran the ferry.'
    })
    const tomas = listEntities(db).find((e) => e.name === 'Tomas')!
    expect(tomas.fields).toEqual({
      relationships: 'Brother of Mara',
      notes: 'Debts: owes the mill.'
    })
    expect(tomas.tagId).not.toBeNull()
    expect(listTags(db).map((t) => t.name)).toEqual(expect.arrayContaining(['tomas', 'mara-vell']))
    expect(result.tagChanges.map((c) => c.tag.name)).toEqual(['tomas'])
    const notes = listEntities(db).find((e) => e.name === PROJECT_NOTES_NAME)!
    expect(notes).toMatchObject({
      kind: 'world',
      template: 'blank',
      body: 'Theme: debts.',
      tagId: null
    })
    expect(result.files.find((f) => f.id === fileId)?.state).toBe('processed')

    // The author picks the upload's age on a second pass, and the notes page grows.
    const again = reviewOf(
      [record({ name: 'Mara Vell', fields: { age: '36' } })],
      ['Outline: three acts.']
    )
    again.entities[0]!.fields[0]!.choice = 'upload'
    await applyContextReview(db, session.folder, again)
    expect(getEntity(db, mara.id)?.fields.age).toBe('36')
    expect(getEntity(db, notes.id)?.body).toBe('Theme: debts.\n\nOutline: three acts.')
  })

  it('makes the other names the files used aliases of the sheet, on its tag (F-4.14)', async () => {
    const review = reviewOf([
      record({ name: 'Rynna Falsire', aliases: ['High Crown Falsire'] }),
      record({ name: 'Rynna', aliases: ['Rynna Falsire'], fileName: 'b.md' })
    ])
    expect(review.entities).toHaveLength(1)
    const result = await applyContextReview(db, session.folder, review)
    const rynna = listEntities(db).find((e) => e.name === 'Rynna Falsire')!
    expect(rynna.aliases).toEqual(['High Crown Falsire', 'Rynna'])
    expect(listTags(db).find((t) => t.id === rynna.tagId)?.aliases).toEqual([
      'High Crown Falsire',
      'Rynna'
    ])
    expect(result.tagChanges.at(-1)).toMatchObject({ aliased: true })

    // A later file that says only "Rynna" lands on the same sheet through the alias.
    const again = reviewOf([record({ name: 'Rynna', fields: { age: '40' } })])
    expect(again.entities[0]).toMatchObject({ existingId: rynna.id })
  })

  it('writes nothing it was told to leave out and makes no tag when unticked', async () => {
    const review = reviewOf(
      [record({ name: 'Ilse' }), record({ name: 'Pell', fields: { age: '9' } })],
      ['x']
    )
    review.entities[0]!.include = false
    review.entities[1]!.tag = false
    review.entities[1]!.fields[0]!.include = false
    review.notes.include = false
    const result = await applyContextReview(db, session.folder, review)
    expect(result).toMatchObject({ created: 1, updated: 0, notes: false })
    expect(listEntities(db).map((e) => [e.name, e.fields, e.tagId])).toEqual([['Pell', {}, null]])
  })

  it('makes an uploaded image the sheet picture, keeping the original in the library', async () => {
    const review = reviewOf([record({ name: 'Mara' })], [], true)
    expect(review.entities[0]?.images).toHaveLength(1)
    await applyContextReview(db, session.folder, review)
    const mara = listEntities(db).find((e) => e.name === 'Mara')!
    expect(mara.image).toMatch(/^mara-portrait\.[0-9a-f]{8}\.png$/)
    expect(fs.existsSync(path.join(assetDir(session.folder, ENTITY_IMAGES_DIR), mara.image!))).toBe(
      true
    )
    expect(listContextFiles(db)).toHaveLength(2)
  })

  it('rolls everything back, copied pictures included, when a name was taken since', async () => {
    const review = reviewOf([record({ name: 'Mara' }), record({ name: 'Tomas' })], ['Theme.'], true)
    createEntity(db, { kind: 'character', name: 'Tomas' })
    await expect(applyContextReview(db, session.folder, review)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    expect(listEntities(db).map((e) => e.name)).toEqual(['Tomas'])
    const images = assetDir(session.folder, ENTITY_IMAGES_DIR)
    expect(fs.existsSync(images) ? fs.readdirSync(images) : []).toEqual([])
    expect(listContextFiles(db).find((f) => f.id === fileId)?.state).toBe('new')
  })
})
