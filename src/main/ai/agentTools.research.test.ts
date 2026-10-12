import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { ensureResearchRoot } from '../project/seed'
import { createResearchNote, setResearchNotCanon } from '../research/researchStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { loadAgentProject, resolveAgentEdit, runAgentTool } from './agentTools'

/**
 * F-16.8 (story memory v2): until Ms Scribe reads Research through her own tools (P3), the chat
 * agent's run holds no Research node. A page, a Not canon one above all, is never in the outline,
 * never read, never merged into a scene or moved, and an open page is not the run's focus.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: NodeRow
let page: NodeRow
let maybe: NodeRow

const doc = (...paragraphs: { text: string; notCanon?: true }[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map(({ text, notCanon }) => ({
    type: 'paragraph',
    ...(notCanon ? { attrs: { notCanon: true } } : {}),
    content: [{ type: 'text', text }]
  }))
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-agent-research-'))
  session = createProject(projectFolderFor(tmp, 'Agent'), 'Agent', 'novel')
  db = session.connection.orm
  const [first] = manuscriptDocuments(db)
  if (first === undefined) throw new Error('skeleton not seeded')
  scene = first
  saveDocument(db, scene.id, doc({ text: 'Mara waited on the ridge.' }))
  const root = ensureResearchRoot(db)
  const folder = createNode(db, 'novel', {
    parentId: root,
    kind: 'folder',
    hierarchyLevel: null,
    title: 'Reef notes'
  })
  page = createResearchNote(db, 'novel', { parentId: folder.id, title: 'Quillback rockfish' })
  saveDocument(
    db,
    page.id,
    doc({ text: 'Quillback live forty fathoms down.' }, { text: 'Mara dies here.', notCanon: true })
  )
  maybe = createResearchNote(db, 'novel', { title: 'Possible ending' })
  saveDocument(db, maybe.id, doc({ text: 'The harbour floods and Pell drowns.' }))
  setResearchNotCanon(db, maybe.id, true)
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the chat agent leaves Research out until P3 (F-16.8)', () => {
  it('gives no Research node a ref, an outline line, or a place in the run', () => {
    const project = loadAgentProject(db, null, 'v2')
    const research = listNodes(db).filter(
      (row) => row.sectionType === 'research' || [page.id, maybe.id].includes(row.id)
    )
    for (const row of research) {
      expect(project.refOf.has(row.id)).toBe(false)
      expect(project.byId.has(row.id)).toBe(false)
    }
    expect(project.rows.some((row) => row.title === 'Reef notes')).toBe(false)
    expect(project.refOf.has(scene.id)).toBe(true)
    const outline = runAgentTool(project, null, 'outline', {}).result
    for (const title of ['Reef notes', 'Quillback rockfish', 'Possible ending']) {
      expect(outline).not.toContain(title)
    }
    expect(outline).toContain(scene.title)
  })

  it('reads no page and merges, moves or writes into none: every ref past the book is unknown', () => {
    const project = loadAgentProject(db, null, 'v2')
    const unknown = `n${project.rows.length + 1}`
    const read = runAgentTool(project, null, 'read_scene', { id: unknown }).result
    expect(read).toContain('is not an id')
    expect(read).not.toContain('Mara dies here.')
    const sceneRef = project.refOf.get(scene.id) ?? ''
    const merged = resolveAgentEdit(project, { edit: 'merge', id: unknown, into: sceneRef })
    expect(merged).toEqual({ error: `${unknown} is not a document` })
    const moved = resolveAgentEdit(project, { edit: 'move', id: sceneRef, into: unknown })
    expect('error' in moved).toBe(true)
  })

  it('does not focus a Research page the author has open, Not canon or not', () => {
    for (const open of [page.id, maybe.id]) {
      const project = loadAgentProject(db, open, 'v2')
      expect(project.byId.get(open)).toBeUndefined()
      expect(project.time.nowId).not.toBe(open)
    }
  })
})
