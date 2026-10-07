import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { selectEntries } from '@shared/compileModel'
import { emptySceneMeta } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { node, type NodeRow } from '../db/schema'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { createNode, deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import { compileManuscript, compileSection, compileSource } from './compileStore'
import { saveDocument } from './documentStore'
import { saveNotes } from './notesStore'
import { setSceneMeta } from './sceneMetaStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function section(type: NodeRow['sectionType']): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === type)
  if (!row) throw new Error(`no ${type}`)
  return row
}

function byTitle(title: string, level: NodeRow['hierarchyLevel']): NodeRow[] {
  return listNodes(db).filter((r) => r.title === title && r.hierarchyLevel === level)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-compile-'))
  session = createSeededProject(projectFolderFor(tmp, 'Compile'), 'Compile', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('compileManuscript (F-3.12)', () => {
  it('walks the manuscript in reading order with depths, leaving matter out', () => {
    const [part1] = byTitle('Part 1', 'part')
    const [chapter1] = listNodes(db).filter(
      (r) => r.parentId === part1?.id && r.hierarchyLevel === 'chapter'
    )
    if (!part1 || !chapter1) throw new Error('seed changed')
    createNode(db, 'novel', {
      parentId: chapter1.id,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Scene 2'
    })
    createNode(db, 'novel', {
      parentId: section('front').id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    })

    const entries = compileManuscript(db).entries
    expect(entries.map((e) => [e.depth, e.level, e.title])).toEqual([
      [0, 'part', 'Part 1'],
      [1, 'chapter', 'Chapter 1'],
      [2, 'scene', 'Scene 1'],
      [2, 'scene', 'Scene 2'],
      [1, 'chapter', 'Chapter 2'],
      [2, 'scene', 'Scene 1'],
      [1, 'chapter', 'Chapter 3'],
      [2, 'scene', 'Scene 1'],
      [0, 'part', 'Part 2'],
      [1, 'chapter', 'Chapter 1'],
      [2, 'scene', 'Scene 1'],
      [1, 'chapter', 'Chapter 2'],
      [2, 'scene', 'Scene 1'],
      [1, 'chapter', 'Chapter 3'],
      [2, 'scene', 'Scene 1']
    ])
    expect(entries.every((e) => e.title !== 'Dedication')).toBe(true)
    expect(entries[0]?.kind).toBe('folder')
    expect(entries[0]?.content).toBeNull()
  })

  it('carries content, scene metadata only when a shown field has text, and tags with colors', () => {
    const scene = listNodes(db).find((r) => r.hierarchyLevel === 'scene')
    const other = listNodes(db).filter((r) => r.hierarchyLevel === 'scene')[1]
    if (!scene || !other) throw new Error('seed changed')
    saveDocument(db, scene.id, para('The storm broke.'))
    setSceneMeta(db, scene.id, { ...emptySceneMeta(), location: ' Harbor ', pov: 'Mara' })
    // A brief alone is not shown in the header, so it does not make a header.
    setSceneMeta(db, other.id, {
      ...emptySceneMeta(),
      brief: { goal: 'Escape', conflict: '', turn: '', beat: '', after: '' }
    })
    const rain = createTag(db, { name: 'Rain', category: 'tone', color: '#123abc' })
    const mara = createTag(db, { name: 'Mara', category: 'character' })
    addDocumentTag(db, scene.id, rain.id)
    addDocumentTag(db, scene.id, mara.id)

    const entries = compileManuscript(db).entries
    const compiled = entries.find((e) => e.id === scene.id)
    expect(compiled?.content).toEqual(para('The storm broke.'))
    expect(compiled?.meta).toEqual({ location: 'Harbor', pov: 'Mara', timeline: '' })
    expect(compiled?.tags).toEqual([
      { id: mara.id, name: 'mara', color: mara.color },
      { id: rain.id, name: 'rain', color: '#123abc' }
    ])
    const plain = entries.find((e) => e.id === other.id)
    expect(plain?.meta).toBeNull()
    expect(plain?.tags).toEqual([])
    expect(plain?.content).toBeNull()
  })

  it('answers null content for a document whose stored content is corrupt', () => {
    const scene = listNodes(db).find((r) => r.hierarchyLevel === 'scene')
    if (!scene) throw new Error('seed changed')
    db.update(node).set({ content: '{not json' }).where(eq(node.id, scene.id)).run()
    const compiled = compileManuscript(db).entries.find((e) => e.id === scene.id)
    expect(compiled).toBeDefined()
    expect(compiled?.content).toBeNull()
  })

  it('is empty for a manuscript with nothing under it', () => {
    const manuscript = section('manuscript')
    for (const row of listNodes(db).filter((r) => r.parentId === manuscript.id))
      deleteNode(db, row.id)
    expect(compileManuscript(db)).toEqual({ entries: [] })
  })
})

describe('compileSection (F-12.1) with the compile model selection', () => {
  it('keeps a chosen chapter with the part above it and the scenes below it', () => {
    const [part2] = byTitle('Part 2', 'part')
    const chapter = listNodes(db).find(
      (r) => r.parentId === part2?.id && r.hierarchyLevel === 'chapter' && r.title === 'Chapter 2'
    )
    if (!part2 || !chapter) throw new Error('seed changed')
    const entries = selectEntries(
      compileSection(db, 'manuscript'),
      new Set(),
      new Set([chapter.id])
    )
    expect(entries.map((e) => [e.depth, e.level, e.title])).toEqual([
      [0, 'part', 'Part 2'],
      [1, 'chapter', 'Chapter 2'],
      [2, 'scene', 'Scene 1']
    ])
    expect(entries[1]?.id).toBe(chapter.id)
  })

  it('keeps every chosen node in reading order and nothing for an unknown id', () => {
    // By part, not by `listNodes` order: that sorts by the parents' random ids.
    const [part1] = byTitle('Part 1', 'part')
    const [part2] = byTitle('Part 2', 'part')
    const rows = listNodes(db)
    const first = rows.find((r) => r.parentId === part1?.id && r.title === 'Chapter 1')
    const last = rows.find((r) => r.parentId === part2?.id && r.title === 'Chapter 3')
    if (!first || !last) throw new Error('seed changed')
    const titles = selectEntries(
      compileSection(db, 'manuscript'),
      new Set(),
      new Set([last.id, first.id])
    ).map((e) => e.title)
    expect(titles).toEqual(['Part 1', 'Chapter 1', 'Scene 1', 'Part 2', 'Chapter 3', 'Scene 1'])
    expect(
      selectEntries(compileSection(db, 'manuscript'), new Set(), new Set(['missing']))
    ).toEqual([])
  })

  it('walks front matter the same way', () => {
    const dedication = createNode(db, 'novel', {
      parentId: section('front').id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    })
    saveDocument(db, dedication.id, para('For M.'))
    const entries = compileSection(db, 'front')
    expect(entries.map((e) => [e.depth, e.title, e.content])).toEqual([
      [0, 'Dedication', para('For M.')]
    ])
  })
})

describe('compileSource (Compile v2)', () => {
  it('walks all three sections with synopsis and notes, unreadable notes as null', () => {
    const [part1] = byTitle('Part 1', 'part')
    const chapter = listNodes(db).find(
      (r) => r.parentId === part1?.id && r.hierarchyLevel === 'chapter' && r.title === 'Chapter 1'
    )
    const scene = listNodes(db).find(
      (r) => r.parentId === chapter?.id && r.hierarchyLevel === 'scene'
    )
    if (!chapter || !scene) throw new Error('seed changed')
    saveDocument(db, scene.id, para('Text.'))
    setSceneMeta(db, scene.id, { ...emptySceneMeta(), synopsis: 'Mara arrives.' })
    saveNotes(db, scene.id, para('Check the tide tables.'))
    db.update(node).set({ notes: '{broken' }).where(eq(node.id, chapter.id)).run()
    const afterword = createNode(db, 'novel', {
      parentId: section('end').id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Afterword'
    })

    const source = compileSource(db)
    expect(source.front).toEqual([])
    expect(source.end.map((n) => [n.id, n.depth, n.synopsis, n.notes])).toEqual([
      [afterword.id, 0, '', null]
    ])
    expect(source.manuscript.find((n) => n.id === scene.id)).toMatchObject({
      synopsis: 'Mara arrives.',
      notes: para('Check the tide tables.'),
      content: para('Text.'),
      depth: 2
    })
    expect(source.manuscript.find((n) => n.id === chapter.id)?.notes).toBeNull()
    // The manuscript part is the preview's walk.
    expect(source.manuscript.map((n) => n.id)).toEqual(
      compileManuscript(db).entries.map((e) => e.id)
    )
  })
})
