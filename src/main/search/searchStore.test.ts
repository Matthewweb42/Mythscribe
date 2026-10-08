import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SEARCH_MAX_RESULTS, SEARCH_TYPES, type SearchRequest } from '@shared/search'
import type { TiptapNodeT } from '@shared/tiptap'
import { node, type NodeRow } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { createEntity } from '../entity/entityStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { replaceNodeMentions } from '../tag/mentionStore'
import { createTag } from '../tag/tagStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { clearSearchCache, searchCacheSize, searchProject } from './searchStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The seeded manuscript's scenes, in reading order. */
let scenes: NodeRow[]

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const search = (
  query: string,
  patch: Partial<SearchRequest> = {}
): ReturnType<typeof searchProject> =>
  searchProject(db, { query, types: [...SEARCH_TYPES], tagId: null, ...patch })

const scene = (index: number): NodeRow => {
  const row = scenes[index]
  if (row === undefined) throw new Error(`no scene ${index}`)
  return row
}

beforeEach(() => {
  clearSearchCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-search-'))
  session = createProject(projectFolderFor(tmp, 'Search'), 'Search', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db)
  // The seed is one scene; the tests need three in reading order.
  const first = scene(0)
  for (let i = 0; i < 2; i++) {
    createNode(db, 'novel', {
      parentId: first.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: `Extra ${i + 1}`
    })
  }
  scenes = manuscriptDocuments(db)
})
afterEach(() => {
  clearSearchCache()
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('searchProject (F-10.1)', () => {
  it('answers nothing for a query under the minimum or a request with no type', () => {
    saveDocument(db, scene(0).id, doc('A lantern.'))
    expect(search(' a ')).toEqual({ results: [], total: 0, truncated: false })
    expect(search('lantern', { types: [] })).toEqual({ results: [], total: 0, truncated: false })
    expect(search('nothing here')).toEqual({ results: [], total: 0, truncated: false })
  })

  it('finds a document by its text: title, parent as location, snippet, highlights, count', () => {
    const row = scene(0)
    saveDocument(db, row.id, doc('The Lantern swung.', 'She raised the lantern again.'))
    const parent = listNodes(db).find((other) => other.id === row.parentId)
    const { results, total, truncated } = search('  LANTERN ')
    expect({ total, truncated }).toEqual({ total: 1, truncated: false })
    expect(results).toEqual([
      {
        type: 'document',
        id: row.id,
        title: row.title,
        location: `Part 1 › ${parent?.title}`,
        field: null,
        snippet: {
          text: 'The Lantern swung. She raised the lantern again.',
          highlights: [
            [4, 11],
            [34, 41]
          ]
        },
        titleHighlights: [],
        count: 2
      }
    ])
  })

  it('finds a phrase that crosses a paragraph break', () => {
    saveDocument(db, scene(0).id, doc('It ended.', 'Then it began.'))
    expect(search('ended. then').results).toHaveLength(1)
  })

  it('finds a document by its title alone, showing the start of its text unhighlighted', () => {
    const row = scene(1)
    saveDocument(db, row.id, doc('Nothing of note happens.'))
    const [hit] = search('extra 1', { types: ['document'] }).results
    expect(hit).toMatchObject({
      type: 'document',
      id: row.id,
      title: 'Extra 1',
      titleHighlights: [[0, 7]],
      snippet: { text: 'Nothing of note happens.', highlights: [] },
      count: 1
    })
  })

  it('finds notes as their own result, by the notes text only', () => {
    const row = scene(0)
    saveDocument(db, row.id, doc('The lantern swung.'))
    saveNotes(db, row.id, doc('Check the lantern continuity.'))
    const folder = listNodes(db).find((other) => other.id === row.parentId)
    if (!folder) throw new Error('no chapter')
    saveNotes(db, folder.id, doc('Chapter goal: lose the lantern.'))
    const results = search('lantern').results
    expect(results.map((r) => [r.type, r.id])).toEqual([
      ['document', row.id],
      ['notes', folder.id],
      ['notes', row.id]
    ])
    expect(results[1]).toMatchObject({ title: folder.title, count: 1 })
    expect(results[2]?.snippet.text).toBe('Check the lantern continuity.')
    // A title hit is the document's result, never a second one for its notes.
    saveNotes(db, scene(1).id, doc('Unrelated.'))
    expect(search('extra 1').results.map((r) => r.type)).toEqual(['document'])
  })

  it('finds an entity by name, by a template field (with its label), and by its page', () => {
    const ada = createEntity(db, {
      kind: 'character',
      name: 'Ada Lantern',
      fields: { age: '36', goals: 'Keep the lantern lit. The Lantern matters.' }
    }).entity
    const harbor = createEntity(db, {
      kind: 'setting',
      name: 'Harbor',
      template: 'blank',
      body: 'Fog, and one lantern on the quay.'
    }).entity
    const law = createEntity(db, { kind: 'world', name: 'Lantern Law' }).entity
    const results = search('lantern').results
    expect(results.map((r) => [r.type, r.id])).toEqual([
      ['character', ada.id],
      ['setting', harbor.id],
      ['world', law.id]
    ])
    expect(results[0]).toMatchObject({
      title: 'Ada Lantern',
      location: 'character',
      field: 'Goals / motivations',
      titleHighlights: [[4, 11]],
      count: 3
    })
    expect(results[0]?.snippet.highlights).toHaveLength(2)
    expect(results[1]).toMatchObject({ location: 'place', field: null, count: 1 })
    expect(results[1]?.snippet.text).toBe('Fog, and one lantern on the quay.')
    expect(results[2]).toMatchObject({
      location: 'world-building item',
      field: null,
      snippet: { text: '', highlights: [] },
      count: 1
    })
  })

  it('filters by type', () => {
    saveDocument(db, scene(0).id, doc('The lantern.'))
    saveNotes(db, scene(0).id, doc('lantern note'))
    createEntity(db, { kind: 'character', name: 'Lantern Jack' })
    createEntity(db, { kind: 'setting', name: 'Lantern Row' })
    createEntity(db, { kind: 'world', name: 'Lantern Law' })
    const typesOf = (types: SearchRequest['types']): string[] =>
      search('lantern', { types }).results.map((r) => r.type)
    expect(typesOf([...SEARCH_TYPES])).toEqual([
      'document',
      'notes',
      'character',
      'setting',
      'world'
    ])
    expect(typesOf(['document'])).toEqual(['document'])
    expect(typesOf(['notes'])).toEqual(['notes'])
    expect(typesOf(['setting', 'world'])).toEqual(['setting', 'world'])
    expect(typesOf(['character', 'notes'])).toEqual(['notes', 'character'])
  })

  it('filters by tag: linked or mentioned for a node, the linked tag for an entity', () => {
    const [a, b, c] = [scene(0), scene(1), scene(2)]
    for (const row of [a, b, c]) saveDocument(db, row.id, doc('The lantern.'))
    saveNotes(db, b.id, doc('lantern note'))
    const rain = createTag(db, { name: 'rain', category: 'setting' })
    const other = createTag(db, { name: 'other', category: 'setting' })
    addDocumentTag(db, a.id, rain.id)
    replaceNodeMentions(db, b.id, new Map([[rain.id, [[1, 5]]]]), 'hash', new Date())
    addDocumentTag(db, c.id, other.id)
    const tagged = createEntity(db, { kind: 'character', name: 'Lantern Jack' }).entity
    createEntity(db, { kind: 'character', name: 'Lantern Jill' })
    expect(search('lantern', { tagId: rain.id }).results.map((r) => [r.type, r.id])).toEqual([
      ['document', a.id],
      ['document', b.id],
      ['notes', b.id]
    ])
    expect(tagged.tagId).not.toBeNull()
    expect(search('lantern', { tagId: tagged.tagId }).results.map((r) => r.id)).toEqual([tagged.id])
    expect(search('lantern', { tagId: 'no-such-tag' }).total).toBe(0)
  })

  it('orders documents in tree order across sections and chapters', () => {
    const rows = listNodes(db)
    const front = rows.find((row) => row.parentId === null && row.sectionType === 'front')
    if (!front) throw new Error('no front matter')
    const preface = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Preface'
    })
    saveDocument(db, preface.id, doc('lantern'))
    for (const row of [scene(2), scene(0), scene(1)]) saveDocument(db, row.id, doc('lantern'))
    const order = search('lantern', { types: ['document'] }).results.map((r) => r.id)
    const sections = rows
      .filter((row) => row.parentId === null)
      .sort((x, y) => x.position - y.position)
    const manuscriptIds = [scene(0).id, scene(1).id, scene(2).id]
    expect(order).toEqual(
      sections[0]?.sectionType === 'front'
        ? [preface.id, ...manuscriptIds]
        : [...manuscriptIds, preface.id]
    )
  })

  it('caps the results and still counts every match', () => {
    const parentId = scene(0).parentId ?? ''
    const extra = SEARCH_MAX_RESULTS + 5 - scenes.length
    for (let i = 0; i < extra; i++) {
      createNode(db, 'novel', {
        parentId,
        kind: 'document',
        hierarchyLevel: 'scene',
        title: `S${i}`
      })
    }
    db.update(node)
      .set({ content: JSON.stringify(doc('lantern')) })
      .where(eq(node.kind, 'document'))
      .run()
    const { results, total, truncated } = search('lantern', { types: ['document'] })
    expect(results).toHaveLength(SEARCH_MAX_RESULTS)
    expect(total).toBeGreaterThanOrEqual(SEARCH_MAX_RESULTS + 5)
    expect(truncated).toBe(true)
  })

  it('reuses the cached text while the stored JSON is the same, and re-reads it after a save', () => {
    const row = scene(0)
    saveDocument(db, row.id, doc('The lantern.'))
    saveNotes(db, row.id, doc('lantern note'))
    expect(searchCacheSize()).toBe(0)
    expect(search('lantern').total).toBe(2)
    const cached = searchCacheSize()
    expect(cached).toBeGreaterThanOrEqual(2)
    expect(search('lantern').total).toBe(2)
    expect(searchCacheSize()).toBe(cached)
    saveDocument(db, row.id, doc('The candle.'))
    expect(search('lantern').results.map((r) => r.type)).toEqual(['notes'])
    expect(search('candle').results.map((r) => r.type)).toEqual(['document'])
    expect(searchCacheSize()).toBe(cached)
    clearSearchCache()
    expect(searchCacheSize()).toBe(0)
  })

  it('reads a corrupt stored column as no text instead of failing the search', () => {
    saveDocument(db, scene(1).id, doc('The lantern.'))
    db.update(node)
      .set({ content: '{not json', notes: '[]' })
      .where(eq(node.id, scene(0).id))
      .run()
    expect(search('lantern').results.map((r) => r.id)).toEqual([scene(1).id])
  })
})
