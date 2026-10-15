import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTEBOOK_VERSIONS_KEPT, notebookDocFromText } from '@shared/notebook'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { TreeDb } from '../tree/treeStore'
import {
  createNotebookItem,
  deleteNotebookItem,
  getNotebookPage,
  listNotebook,
  listNotebookPages,
  listNotebookVersions,
  moveNotebookItem,
  restoreNotebookItem,
  restoreNotebookVersion,
  updateNotebookItem
} from './notebookStore'

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-notebook-'))
  session = createProject(projectFolderFor(tmp, 'Notes'), 'Notes', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.connection.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the notebook store (notes redesign phase 1)', () => {
  it('starts empty, then lists folders and pages in order with their plain text', () => {
    expect(listNotebook(db)).toEqual([])
    const people = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'People' })
    const tash = createNotebookItem(db, {
      parentId: people.id,
      kind: 'page',
      title: 'Tash',
      content: notebookDocFromText('Outgoing.\nUncaring.')
    })
    const rynna = createNotebookItem(db, { parentId: people.id, kind: 'page', title: 'Rynna' })
    expect(listNotebook(db).map((item) => item.title)).toEqual(['People', 'Tash', 'Rynna'])
    expect(tash.position).toBe(0)
    expect(rynna.position).toBe(1)
    expect(getNotebookPage(db, tash.id).plain).toBe('Outgoing.\nUncaring.')
    expect(listNotebookPages(db).map((page) => page.title)).toEqual(['Tash', 'Rynna'])
  })

  it('refuses a page as a parent and a folder inside itself', () => {
    const page = createNotebookItem(db, { parentId: null, kind: 'page', title: 'Plot' })
    expect(() =>
      createNotebookItem(db, { parentId: page.id, kind: 'page', title: 'Inside' })
    ).toThrow(/inside a folder/)
    const outer = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'Outer' })
    const inner = createNotebookItem(db, { parentId: outer.id, kind: 'folder', title: 'Inner' })
    expect(() => moveNotebookItem(db, { id: outer.id, parentId: inner.id, position: 0 })).toThrow(
      /inside itself/
    )
    moveNotebookItem(db, { id: page.id, parentId: inner.id, position: 0 })
    expect(getNotebookPage(db, page.id).parentId).toBe(inner.id)
  })

  it("keeps no version for the author's typing, and one before Ms Scribe's edit, which Undo restores", () => {
    const page = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Timeline',
      content: notebookDocFromText('Year 1: the fall.')
    })
    updateNotebookItem(db, { id: page.id, content: notebookDocFromText('Year 1: the fall of Ruin.') })
    expect(listNotebookVersions(db, page.id)).toEqual([])

    const { versionId } = updateNotebookItem(
      db,
      { id: page.id, content: notebookDocFromText('Year 1: the fall of Ruin.\nYear 2: exile.') },
      'ai'
    )
    expect(versionId).not.toBeNull()
    expect(getNotebookPage(db, page.id).plain).toContain('exile')
    const restored = restoreNotebookVersion(db, versionId ?? '')
    expect(restored.plain).toBe('Year 1: the fall of Ruin.')
    expect(listNotebookVersions(db, page.id).map((v) => v.author)).toEqual(['me', 'ai'])
  })

  it(`keeps at most ${NOTEBOOK_VERSIONS_KEPT} versions per page`, () => {
    const page = createNotebookItem(db, { parentId: null, kind: 'page', title: 'Powers' })
    for (let i = 0; i < NOTEBOOK_VERSIONS_KEPT + 5; i++) {
      updateNotebookItem(db, { id: page.id, content: notebookDocFromText(`v${i}`) }, 'ai')
    }
    expect(listNotebookVersions(db, page.id)).toHaveLength(NOTEBOOK_VERSIONS_KEPT)
  })

  it('deletes a folder with what is in it, and Undo brings them all back', () => {
    const folder = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'World' })
    const page = createNotebookItem(db, { parentId: folder.id, kind: 'page', title: 'Memorance' })
    const before = createNotebookItem(db, { parentId: folder.id, kind: 'page', title: 'Old' })
    deleteNotebookItem(db, before.id)
    deleteNotebookItem(db, folder.id)
    expect(listNotebook(db)).toEqual([])
    expect(() => getNotebookPage(db, page.id)).toThrow(/gone/)
    restoreNotebookItem(db, folder.id)
    // The page deleted on its own earlier stays deleted.
    expect(listNotebook(db).map((item) => item.title)).toEqual(['World', 'Memorance'])
  })

  it('puts a restored item at the top level when its folder is still deleted', () => {
    const folder = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'World' })
    const page = createNotebookItem(db, { parentId: folder.id, kind: 'page', title: 'Map' })
    deleteNotebookItem(db, page.id)
    deleteNotebookItem(db, folder.id)
    expect(restoreNotebookItem(db, page.id).parentId).toBeNull()
  })

  it('refuses text on a folder', () => {
    const folder = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'World' })
    expect(() =>
      updateNotebookItem(db, { id: folder.id, content: notebookDocFromText('x') })
    ).toThrow(/no text/)
  })
})
