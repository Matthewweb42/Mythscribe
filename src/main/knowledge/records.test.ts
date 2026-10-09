import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PROJECT_NOTES_NAME } from '@shared/contextLibrary'
import { KNOWLEDGE_INDEX_VERSION, recordNameForTag } from '@shared/knowledge'
import { isObservedDismissed, withObservedDismissed } from '@shared/observedFacts'
import type { TiptapNodeT } from '@shared/tiptap'
import { applyAutoTags } from '../ai/autoTags'
import { tag as tagTable } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { createEntity, deleteEntity, listEntities } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import {
  getKnowledgeModel,
  getObservedDismissed,
  setKnowledgeModel,
  setObservedDismissed
} from '../project/settingsStore'
import { scanMentions, staleMentionNodeIds } from '../tag/scanMentions'
import { createTag, getTag, listTags, updateTag } from '../tag/tagStore'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { convertKnowledgeIndex, ensureRecordForTag, makeRecordForTag } from './records'

let tmp: string
let session: ProjectSession
let db: TreeDb

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

/** A tag as an older build left it: no record, whatever its category. */
const bareTag = (
  name: string,
  category: Parameters<typeof createTag>[1]['category'],
  origin: 'author' | 'ai' = 'author'
): string => createTag(db, { name, category }, origin).id

const recordOf = (tagId: string): string[] =>
  listEntities(db)
    .filter((entity) => entity.tagId === tagId)
    .map((entity) => `${entity.kind}:${entity.name}:${entity.origin}`)

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-records-'))
  session = createProject(projectFolderFor(tmp, 'Records'), 'Records', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('recordNameForTag (F-9.12)', () => {
  it('capitalises each word of the tag name', () => {
    expect(recordNameForTag('rose-marsh')).toBe('Rose Marsh')
    expect(recordNameForTag('élodie')).toBe('Élodie')
    expect(recordNameForTag('the-veil-2')).toBe('The Veil 2')
  })
})

describe('ensureRecordForTag (F-9.12, D8)', () => {
  it('gives a character, place, or world tag a sheet in its category, linked to it', () => {
    const rose = createTag(db, { name: 'Rose Marsh', category: 'character' })
    const gate = createTag(db, { name: 'North Gate', category: 'setting' })
    const veil = createTag(db, { name: 'The Veil', category: 'worldBuilding' })
    for (const each of [rose, gate, veil])
      expect(ensureRecordForTag(db, each, 'author')).not.toBeNull()
    expect(recordOf(rose.id)).toEqual(['character:Rose Marsh:author'])
    expect(recordOf(gate.id)).toEqual(['setting:North Gate:author'])
    expect(recordOf(veil.id)).toEqual(['world:The Veil:author'])
  })

  it('leaves labels alone and never makes a second record', () => {
    const rain = createTag(db, { name: 'rain', category: 'tone' })
    const thread = createTag(db, { name: 'the-debt', category: 'plotThread' })
    expect(ensureRecordForTag(db, rain, 'author')).toBeNull()
    expect(ensureRecordForTag(db, thread, 'author')).toBeNull()
    const mara = createTag(db, { name: 'mara', category: 'character' })
    expect(ensureRecordForTag(db, mara, 'author')).not.toBeNull()
    expect(ensureRecordForTag(db, mara, 'author')).toBeNull()
    expect(listEntities(db)).toHaveLength(1)
  })

  it('links an untagged sheet of that name instead of making another', () => {
    const sheet = createEntity(db, { kind: 'character', name: 'Mara' }, 'author', { tag: false })
    const mara = createTag(db, { name: 'mara', category: 'character' })
    const write = ensureRecordForTag(db, mara, 'ai')
    expect(write?.entity.id).toBe(sheet.entity.id)
    expect(recordOf(mara.id)).toEqual(['character:Mara:author'])
  })

  it('skips an AI tag whose sheet the author deleted, and a name another tag’s sheet holds', () => {
    setObservedDismissed(db, withObservedDismissed(getObservedDismissed(db), 'character', 'Ghost'))
    const ghost = createTag(db, { name: 'ghost', category: 'character' }, 'ai')
    expect(ensureRecordForTag(db, ghost, 'ai')).toBeNull()

    // A character sheet "Lark" whose tag the author renamed: the name is taken by a sheet that
    // points elsewhere, so a new `lark` tag stays a label.
    const lark = createEntity(db, { kind: 'character', name: 'Lark' })
    updateTag(db, lark.entity.tagId ?? '', { name: 'skylark' })
    const other = createTag(db, { name: 'lark', category: 'character' })
    expect(ensureRecordForTag(db, other, 'author')).toBeNull()
    expect(recordOf(other.id)).toEqual([])
    expect(listEntities(db)).toHaveLength(1)
  })
})

describe('makeRecordForTag (F-9.12)', () => {
  it('makes a World record for a label tag and answers the same record again', () => {
    const rain = createTag(db, { name: 'rain', category: 'tone' })
    const made = makeRecordForTag(db, rain.id)
    expect(made.write).not.toBeNull()
    expect(made.entity).toMatchObject({ kind: 'world', name: 'Rain', tagId: rain.id })
    expect(made.tag.id).toBe(rain.id)
    const again = makeRecordForTag(db, rain.id)
    expect(again.write).toBeNull()
    expect(again.entity.id).toBe(made.entity.id)
  })

  it('is NOT_FOUND for an unknown tag', () => {
    expect(() => makeRecordForTag(db, 'missing')).toThrow(AppError)
  })
})

describe('applyAutoTags gives new name tags their record (F-9.12)', () => {
  it('makes an AI-made sheet for an AI-made character tag', () => {
    const scene = manuscriptDocuments(db)[0]?.id ?? ''
    const text = 'Brannoc came to the North Gate at dusk.'
    saveDocument(db, scene, doc(text))
    const change = applyAutoTags(db, scene, [{ name: 'Brannoc', category: 'character' }], text)
    const tagId = change.created[0]?.id ?? ''
    expect(recordOf(tagId)).toEqual(['character:Brannoc:ai'])
    expect(change.records.map((write) => write.entity.name)).toEqual(['Brannoc'])
  })
})

describe('convertKnowledgeIndex (F-9.12)', () => {
  it('gives every author-made name tag a record and every record a tag, once', () => {
    const mara = bareTag('mara', 'character')
    const brannoc = bareTag('brannoc', 'character', 'ai')
    const rain = bareTag('rain', 'tone')
    const lonely = createEntity(db, { kind: 'setting', name: 'Salt Flats' }, 'author', {
      tag: false
    })
    const notes = createEntity(
      db,
      { kind: 'world', name: PROJECT_NOTES_NAME, template: 'blank' },
      'author',
      { tag: false }
    )

    const result = convertKnowledgeIndex(db)
    expect(result?.records.map((write) => write.entity.name)).toEqual(['Mara'])
    expect(result?.tagged.map((write) => write.entity.name)).toEqual(['Salt Flats'])
    expect(recordOf(mara)).toEqual(['character:Mara:author'])
    // An AI-made tag gets none here (the author, 2026-10-08).
    expect(recordOf(brannoc)).toEqual([])
    expect(recordOf(rain)).toEqual([])
    const flats = listEntities(db).find((entity) => entity.id === lonely.entity.id)
    expect(flats?.tagId).not.toBeNull()
    expect(getTag(db, flats?.tagId ?? '')?.name).toBe('salt-flats')
    expect(listEntities(db).find((entity) => entity.id === notes.entity.id)?.tagId).toBeNull()
    expect(getKnowledgeModel(db).index).toBe(KNOWLEDGE_INDEX_VERSION)

    // Done once: a later open writes nothing, and a deleted record is not made again.
    expect(convertKnowledgeIndex(db)).toBeNull()
  })

  it('is idempotent when it runs again', () => {
    bareTag('mara', 'character')
    convertKnowledgeIndex(db)
    const entities = listEntities(db).length
    const tags = listTags(db).length
    setKnowledgeModel(db, { index: 0 })
    const again = convertKnowledgeIndex(db)
    expect(again).toEqual({ records: [], tagged: [] })
    expect(listEntities(db)).toHaveLength(entities)
    expect(listTags(db)).toHaveLength(tags)
  })

  it('keeps keys a later build stored beside its own', () => {
    db.run(
      sql`INSERT INTO settings (key, value) VALUES ('knowledgeModel', '{"index":0,"facts":1}')`
    )
    convertKnowledgeIndex(db)
    const row = db.all<{ value: string }>(
      sql`SELECT value FROM settings WHERE key = 'knowledgeModel'`
    )[0]
    expect(JSON.parse(row?.value ?? '{}')).toEqual({ index: 1, facts: 1 })
  })

  it('never changes scene text: the conversion and the full rescan leave every document byte-identical', () => {
    const scenes = manuscriptDocuments(db).map((row) => row.id)
    for (const [i, id] of scenes.entries()) {
      saveDocument(
        db,
        id,
        doc(`Mara met Brannoc at the North Gate (${i}).`, 'Rosé and the café, in the rain.')
      )
    }
    bareTag('mara', 'character')
    bareTag('brannoc', 'character', 'ai')
    bareTag('north-gate', 'setting')
    const read = (): string =>
      JSON.stringify(
        db.all(
          sql`SELECT id, content, notes, word_count, scene_meta, modified FROM node ORDER BY id`
        )
      )
    const drafts = (): string =>
      JSON.stringify(db.all(sql`SELECT * FROM draft_text ORDER BY draft_id, node_id`))
    const before = read()
    const draftsBefore = drafts()

    convertKnowledgeIndex(db)
    const stale = staleMentionNodeIds(db)
    expect(stale).toEqual(scenes)
    const at = new Date(Date.UTC(2026, 9, 8, 12, 0, 0))
    for (const id of stale) scanMentions(db, id, at)
    expect(staleMentionNodeIds(db)).toEqual([])

    expect(read()).toBe(before)
    expect(drafts()).toBe(draftsBefore)
    // The tag bank kept its names and categories too: only records and links were added.
    expect(
      db
        .select({ name: tagTable.name, category: tagTable.category })
        .from(tagTable)
        .where(eq(tagTable.name, 'north-gate'))
        .all()
    ).toEqual([{ name: 'north-gate', category: 'setting' }])
  })
})

describe('convertKnowledgeIndex: no resurrection, no duplicates, AI tags left alone (verifier)', () => {
  it('does not bring back an AI-made sheet the author deleted when its tag is author-made', () => {
    // The author made the `ghost` tag; the story-bible job (F-5.16) made a "Ghost" sheet on it,
    // and the author deleted that sheet, which leaves the name on the dismissed list.
    const ghost = bareTag('ghost', 'character')
    const sheet = createEntity(db, { kind: 'character', name: 'Ghost' }, 'ai')
    expect(sheet.entity.tagId).toBe(ghost)
    deleteEntity(db, sheet.entity.id)
    expect(recordOf(ghost)).toEqual([])

    convertKnowledgeIndex(db)
    expect(recordOf(ghost)).toEqual([])
    expect(isObservedDismissed(getObservedDismissed(db), 'character', 'Ghost')).toBe(true)
  })

  it('links a same-name untagged sheet of another category instead of making a second sheet', () => {
    createEntity(db, { kind: 'world', name: 'The Veil' }, 'author', { tag: false })
    const veil = bareTag('the-veil', 'setting')
    convertKnowledgeIndex(db)
    const named = listEntities(db).filter((entity) => entity.name === 'The Veil')
    expect(named).toHaveLength(1)
    expect(named[0]?.tagId).toBe(veil)
  })

  it('gives AI-made name tags no record at conversion, and does not sweep them in later (author, 2026-10-08)', () => {
    const mara = bareTag('mara', 'character')
    const brannoc = bareTag('brannoc', 'character', 'ai')
    convertKnowledgeIndex(db)
    expect(recordOf(mara)).toEqual(['character:Mara:author'])
    expect(recordOf(brannoc)).toEqual([])
    expect(convertKnowledgeIndex(db)).toBeNull()
    expect(recordOf(brannoc)).toEqual([])
    // The author can still make it by hand.
    expect(makeRecordForTag(db, brannoc).entity).toMatchObject({
      kind: 'character',
      name: 'Brannoc'
    })
  })
})

describe('a record the author deleted stays deleted (F-9.12)', () => {
  it('lists the name when an author-made sheet without facts goes and its tag stays', () => {
    const mara = createTag(db, { name: 'mara', category: 'character' })
    const record = ensureRecordForTag(db, mara, 'author')
    expect(record?.entity.origin).toBe('author')
    deleteEntity(db, record?.entity.id ?? '')
    expect(isObservedDismissed(getObservedDismissed(db), 'character', 'Mara')).toBe(true)

    // No silent hook brings it back: not the tag hook, not the conversion.
    expect(ensureRecordForTag(db, mara, 'author')).toBeNull()
    setKnowledgeModel(db, { index: 0 })
    convertKnowledgeIndex(db)
    expect(recordOf(mara.id)).toEqual([])

    // "Make a record" does, and takes the name off the list.
    expect(makeRecordForTag(db, mara.id).entity).toMatchObject({ name: 'Mara', tagId: mara.id })
    expect(isObservedDismissed(getObservedDismissed(db), 'character', 'Mara')).toBe(false)
  })

  it('lists nothing for an author-made sheet that had no tag', () => {
    const lonely = createEntity(db, { kind: 'setting', name: 'Salt Flats' }, 'author', {
      tag: false
    })
    deleteEntity(db, lonely.entity.id)
    expect(getObservedDismissed(db).names).toEqual([])
  })
})
