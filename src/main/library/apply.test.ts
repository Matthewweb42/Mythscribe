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
import { categoryFromInput } from '@shared/categories'
import { ENTITY_IMAGES_DIR } from '@shared/entities'
import { createEntity, deleteEntity, getEntity, listEntities } from '../entity/entityStore'
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
    categories: [],
    images: images ? [{ id: imageId, name: 'mara-portrait.png' }] : [],
    hints: [],
    notes
  })
  return {
    fileIds: images ? [fileId, imageId] : [fileId],
    entities: plan.entities,
    notes: plan.notes,
    categories: [],
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

  it('fills a sheet whose name was taken since instead of failing (2026-10-11)', async () => {
    const review = reviewOf(
      [record({ name: 'Mara' }), record({ name: 'Tomas', fields: { age: '29', gender: 'Male' } })],
      ['Theme.']
    )
    createEntity(db, { kind: 'character', name: 'tomas ', fields: { gender: 'Female' } })
    const result = await applyContextReview(db, session.folder, review)
    expect(result).toMatchObject({ created: 1, updated: 1, notes: true, skipped: [] })
    const tomas = listEntities(db).filter((e) => e.name.trim().toLowerCase() === 'tomas')
    expect(tomas).toHaveLength(1)
    // The empty field is filled; the author's own value, never reviewed as a conflict, stays.
    expect(tomas[0]?.fields).toEqual({ age: '29', gender: 'Female' })
    expect(listEntities(db).map((e) => e.name)).toContain('Mara')
  })

  it('applies a review that names one World sheet twice, the author’s "Fathoms" (2026-10-11)', async () => {
    const fathoms = createEntity(db, {
      kind: 'world',
      name: 'Fathoms',
      fields: { description: 'The drowned quarter.' }
    }).entity
    // The model filed Fathoms as a place in one chunk and a world item in the next.
    const review = reviewOf([
      record({ kind: 'setting', name: 'Fathoms', fields: { atmosphere: 'Cold, wet' } }),
      record({ kind: 'world', name: 'Fathoms', fields: { rules: 'No fire below the tideline' } })
    ])
    expect(review.entities).toHaveLength(1)
    // An item that would still create it (a stale or hand-edited review) fills it instead.
    review.entities.push({ ...review.entities[0]!, id: 'dup', existingId: null, name: 'fathoms' })
    const result = await applyContextReview(db, session.folder, review)
    expect(result).toMatchObject({ created: 0, updated: 2, skipped: [] })
    const sheets = listEntities(db).filter((e) => e.kind === 'world')
    expect(sheets).toHaveLength(1)
    expect(getEntity(db, fathoms.id)?.fields).toMatchObject({
      description: 'The drowned quarter.',
      rules: 'No fire below the tideline'
    })
  })

  it('leaves out a sheet deleted since, its picture too, and applies the rest', async () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    const review = reviewOf(
      [record({ name: 'Mara', fields: { age: '35' } }), record({ name: 'Tomas' })],
      ['Theme.'],
      true
    )
    expect(review.entities[0]).toMatchObject({ existingId: mara.id })
    expect(review.entities[0]?.images).toHaveLength(1)
    deleteEntity(db, mara.id)
    const result = await applyContextReview(db, session.folder, review)
    expect(result).toMatchObject({
      created: 1,
      updated: 0,
      notes: true,
      skipped: [{ name: 'Mara', reason: '"Mara" is no longer in the story bible' }]
    })
    expect(
      listEntities(db)
        .map((e) => e.name)
        .sort()
    ).toEqual([PROJECT_NOTES_NAME, 'Tomas'])
    const images = assetDir(session.folder, ENTITY_IMAGES_DIR)
    expect(fs.existsSync(images) ? fs.readdirSync(images) : []).toEqual([])
    expect(listContextFiles(db).find((f) => f.id === fileId)?.state).toBe('processed')
  })

  it('creates an accepted proposed category and files its sheets there (F-9.11)', async () => {
    const ships = {
      ...categoryFromInput('c-ships', { name: 'Vessels', fields: ['Crew'] }, 'ai'),
      proposed: true
    }
    const plan = planContextReview({
      records: [record({ name: 'The Gull', kind: 'c-ships', fields: { crew: '12' } })],
      existing: [],
      categories: [ships],
      images: [],
      hints: [],
      notes: []
    })
    const review: ContextReview = {
      ...reviewOf([]),
      entities: plan.entities,
      categories: plan.categories
    }
    const result = await applyContextReview(db, session.folder, review)
    const vessels = result.categories.find((c) => c.name === 'Vessels')
    expect(vessels).toMatchObject({ id: 'c-vessels', origin: 'ai', builtIn: false })
    expect(listEntities(db)).toEqual([
      expect.objectContaining({ name: 'The Gull', kind: 'c-vessels', fields: { crew: '12' } })
    ])
  })

  it('creates no category when none of its sheets is included', async () => {
    const ships = {
      ...categoryFromInput('c-ships', { name: 'Ships', fields: [] }, 'ai'),
      proposed: true
    }
    const plan = planContextReview({
      records: [record({ name: 'The Gull', kind: 'c-ships' })],
      existing: [],
      categories: [ships],
      images: [],
      hints: [],
      notes: []
    })
    const review: ContextReview = {
      ...reviewOf([]),
      entities: plan.entities.map((item) => ({ ...item, include: false })),
      categories: plan.categories
    }
    const result = await applyContextReview(db, session.folder, review)
    expect(result.categories.some((c) => c.id.startsWith('c-'))).toBe(false)
  })
})
