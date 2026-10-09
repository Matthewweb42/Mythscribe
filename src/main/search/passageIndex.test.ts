import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import {
  createProject,
  openProject,
  projectFolderFor,
  type ProjectSession
} from '../project/projectStore'
import { WorkingCopy } from '../project/workingCopy'
import { getScanHash } from '../tag/mentionStore'
import { scanMentions } from '../tag/scanMentions'
import { createNode, deleteNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { ftsQuery, prunePassages, searchPassages } from './passageIndex'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const at = new Date(Date.UTC(2026, 9, 8, 10, 0, 0))

function addScene(title: string): string {
  const parentId = getNode(db, scenes[0] ?? '')?.parentId
  if (typeof parentId !== 'string') throw new Error('no parent')
  const id = createNode(db, 'novel', {
    parentId,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
  scenes.push(id)
  return id
}

function index(id: string, ...paragraphs: string[]): void {
  saveDocument(db, id, doc(...paragraphs))
  scanMentions(db, id, at)
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-fts-'))
  session = createProject(projectFolderFor(tmp, 'Index'), 'Index', 'novel')
  db = session.connection.orm
  scenes = manuscriptDocuments(db).map((row) => row.id)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('ftsQuery (F-9.12)', () => {
  it('quotes every word and joins them with OR', () => {
    expect(ftsQuery('Mara lantern')).toBe('"Mara" OR "lantern"')
  })

  it('turns FTS syntax into plain words, and answers null when no word is left', () => {
    expect(ftsQuery('NEAR(mara lantern) AND text:* "x')).toBe(
      '"NEAR" OR "mara" OR "lantern" OR "AND" OR "text" OR "x"'
    )
    expect(ftsQuery('" * ( ) :')).toBeNull()
    expect(ftsQuery('')).toBeNull()
  })
})

describe('searchPassages (F-9.12)', () => {
  beforeEach(() => {
    const first = scenes[0]
    if (first === undefined) throw new Error('no scene')
    index(
      first,
      'Mara lit the lantern at the gate.',
      'The rain kept on all night.',
      'She met Élodie at the café.'
    )
    index(
      addScene('Two'),
      'The lanterns burned. Mara was running to the lantern by the lantern post.'
    )
  })

  it('ranks the passage with more of the words first and names its paragraph', () => {
    const hits = searchPassages(db, 'Mara lantern')
    expect(hits.length).toBe(2)
    expect(hits[0]?.nodeId).toBe(scenes[1])
    expect(hits[0]?.para).toBe(0)
    expect(hits[1]).toMatchObject({ nodeId: scenes[0], para: 0 })
    expect(hits[0]?.score ?? 0).toBeGreaterThan(hits[1]?.score ?? 0)
    expect(hits[1]?.snippet).toContain('lantern')
  })

  it('stems and folds diacritics', () => {
    expect(searchPassages(db, 'runs').map((h) => h.nodeId)).toEqual([scenes[1]])
    expect(searchPassages(db, 'cafe elodie').map((h) => [h.nodeId, h.para])).toEqual([
      [scenes[0], 2]
    ])
  })

  it('treats hostile queries as words and never throws', () => {
    for (const query of ['"', 'NEAR(', '*', 'rain"', 'text:rain', '(', 'AND OR NOT', '^rain']) {
      expect(() => searchPassages(db, query)).not.toThrow()
    }
    expect(searchPassages(db, 'text:rain').map((h) => h.para)).toEqual([1])
    expect(searchPassages(db, '*')).toEqual([])
  })

  it('caps the results and answers nothing for a zero limit', () => {
    expect(searchPassages(db, 'the', 1)).toHaveLength(1)
    expect(searchPassages(db, 'the', 0)).toEqual([])
  })

  it('skips, then prunes, a document that left the manuscript', () => {
    const gone = scenes[1] ?? ''
    deleteNode(db, gone)
    expect(searchPassages(db, 'lantern').map((h) => h.nodeId)).toEqual([scenes[0]])
    expect(prunePassages(db)).toBe(1)
    const left = db.all<{ n: number }>(
      sql`SELECT count(*) AS n FROM passage_fts WHERE node_id = ${gone}`
    )
    expect(left[0]?.n).toBe(0)
    expect(prunePassages(db)).toBe(0)
    expect(getScanHash(db, scenes[0] ?? '')).not.toBeNull()
  })
})

describe('the passage index in a cloud working copy (F-9.12, F-8.1)', () => {
  it('survives the copy back to the cloud folder and reopens', () => {
    const cloud = path.join(tmp, 'My Drive', 'Book.mythscribe')
    const working = path.join(tmp, 'working')
    const first = createProject(cloud, 'Book', 'novel', {
      workingCopy: (folder) => WorkingCopy.create(folder, working, 'googleDrive')
    })
    const firstDb = first.connection.orm
    const scene = manuscriptDocuments(firstDb)[0]?.id ?? ''
    saveDocument(firstDb, scene, doc('Mara lit the lantern at the gate.'))
    scanMentions(firstDb, scene, at)
    first.close()

    // Another computer: a fresh working copy taken from the cloud file, used, and copied back.
    const other = openProject(cloud, (folder) =>
      WorkingCopy.open(folder, path.join(tmp, 'working-2'), 'googleDrive')
    )
    expect(searchPassages(other.connection.orm, 'gate').map((h) => h.nodeId)).toEqual([scene])
    saveDocument(other.connection.orm, scene, doc('Mara lit the lantern.', 'Rain at the gate.'))
    scanMentions(other.connection.orm, scene, at)
    other.close()

    // The cloud file alone, read without any working copy: the table is in it.
    fs.rmSync(working, { recursive: true, force: true })
    const reopened = openProject(cloud)
    try {
      const hits = searchPassages(reopened.connection.orm, 'gate')
      expect(hits.map((h) => [h.nodeId, h.para])).toEqual([[scene, 1]])
      const check = reopened.connection.sqlite.pragma('integrity_check', { simple: true })
      expect(check).toBe('ok')
    } finally {
      reopened.close()
    }
  })
})
