import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AI_ORIGIN_MARK } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import { node } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { buildProvenanceReport } from './report'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let chapter: string

const text = (t: string, proposalId?: string): TiptapNodeT =>
  proposalId === undefined
    ? { type: 'text', text: t }
    : {
        type: 'text',
        text: t,
        marks: [{ type: AI_ORIGIN_MARK, attrs: { proposalId, accepted: t.length } }]
      }

const doc = (...paragraphs: TiptapNodeT[][]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((content) => ({ type: 'paragraph', content }))
})

function addScene(title: string): string {
  return createNode(db, 'novel', {
    parentId: chapter,
    kind: 'document',
    hierarchyLevel: 'scene',
    title
  }).id
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-provenance-'))
  session = createProject(projectFolderFor(tmp, 'Ledger'), 'Ledger', 'novel')
  db = session.connection.orm
  const row = listNodes(db).find((r) => r.kind === 'document' && r.hierarchyLevel === 'scene')
  if (row?.parentId == null) throw new Error('skeleton not seeded')
  scene = row.id
  chapter = row.parentId
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('buildProvenanceReport (F-14.6)', () => {
  it('reports zero for an empty manuscript, every document in tree order', () => {
    const report = buildProvenanceReport(db)
    expect(report).toMatchObject({ projectPercent: 0, aiChars: 0, totalChars: 0 })
    expect(report.documents.map((d) => d.id)).toEqual(manuscriptDocuments(db).map((r) => r.id))
    expect(report.documents.length).toBeGreaterThan(0)
    for (const entry of report.documents) {
      expect(entry).toMatchObject({ aiChars: 0, totalChars: 0, percent: 0, proposals: 0 })
    }
  })

  it('counts marked characters and distinct proposals per document and for the project', () => {
    saveDocument(
      db,
      scene,
      doc(
        [text('The storm '), text('broke at dusk.', 'p1')],
        [text('Rain ', 'p2'), text('followed.'), text(' Then hail.', 'p1')]
      )
    )
    const second = addScene('Scene 2')
    saveDocument(db, second, doc([text('All mine, every word of it.')]))
    const third = addScene('Scene 3')
    saveDocument(db, third, doc([text('Only theirs.', 'p3')]))

    const report = buildProvenanceReport(db)
    const byId = new Map(report.documents.map((d) => [d.id, d]))
    expect(byId.get(scene)).toEqual({
      id: scene,
      title: 'Scene 1',
      aiChars: 30,
      totalChars: 49,
      percent: 61,
      proposals: 2
    })
    expect(byId.get(second)).toMatchObject({ aiChars: 0, totalChars: 27, percent: 0, proposals: 0 })
    expect(byId.get(third)).toMatchObject({
      aiChars: 12,
      totalChars: 12,
      percent: 100,
      proposals: 1
    })
    expect(report.aiChars).toBe(42)
    expect(report.totalChars).toBe(88)
    expect(report.projectPercent).toBe(48)
  })

  it('ignores front matter and treats an unreadable row as empty', () => {
    const front = listNodes(db).find((r) => r.sectionType === 'front')
    if (!front) throw new Error('front matter root missing')
    const matter = createNode(db, 'novel', {
      parentId: front.id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    }).id
    saveDocument(db, matter, doc([text('For the AI.', 'p9')]))
    saveDocument(db, scene, doc([text('Fine.', 'p1')]))
    db.update(node).set({ content: '{not json' }).where(eq(node.id, scene)).run()

    const report = buildProvenanceReport(db)
    expect(report.documents.some((d) => d.id === matter)).toBe(false)
    expect(report.documents.find((d) => d.id === scene)).toMatchObject({
      aiChars: 0,
      totalChars: 0,
      proposals: 0
    })
    expect(report).toMatchObject({ projectPercent: 0, aiChars: 0, totalChars: 0 })
  })
})
