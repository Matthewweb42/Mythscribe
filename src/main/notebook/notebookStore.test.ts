import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { NOTEBOOK_VERSIONS_KEPT, notebookDocFromText } from '@shared/notebook'
import { notebookItem } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import type { TreeDb } from '../tree/treeStore'
import {
  createNotebookItem,
  deleteNotebookItem,
  ensureNotebookSections,
  getNotebookPage,
  listNotebook,
  listNotebookPages,
  listNotebookVersions,
  moveNotebookItem,
  notebookSectionId,
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

/** The items that are not section roots, by title, in list order. */
const ordinary = (): string[] =>
  listNotebook(db)
    .filter((item) => item.role == null)
    .map((item) => item.title)

describe('the notebook store (notes redesign phase 1)', () => {
  it('starts empty, then lists folders and pages in order with their plain text', () => {
    expect(listNotebook(db)).toEqual([])
    const people = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'People' })
    // The notes binder: made at the top means made in Documents.
    expect(people.parentId).toBe(notebookSectionId(db, 'documents'))
    const tash = createNotebookItem(db, {
      parentId: people.id,
      kind: 'page',
      title: 'Tash',
      content: notebookDocFromText('Outgoing.\nUncaring.')
    })
    const rynna = createNotebookItem(db, { parentId: people.id, kind: 'page', title: 'Rynna' })
    // In the tree's order: the sections, then each folder's children by position.
    expect(listNotebook(db).map((item) => item.title)).toEqual([
      'Outline',
      'Timeline',
      'Documents',
      'People',
      'Tash',
      'Rynna'
    ])
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
    expect(ordinary()).toEqual([])
    expect(() => getNotebookPage(db, page.id)).toThrow(/gone/)
    restoreNotebookItem(db, folder.id)
    // The page deleted on its own earlier stays deleted.
    expect(ordinary()).toEqual(['World', 'Memorance'])
  })

  it('puts a restored item in Documents when its folder is still deleted', () => {
    const folder = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'World' })
    const page = createNotebookItem(db, { parentId: folder.id, kind: 'page', title: 'Map' })
    deleteNotebookItem(db, page.id)
    deleteNotebookItem(db, folder.id)
    expect(restoreNotebookItem(db, page.id).parentId).toBe(notebookSectionId(db, 'documents'))
  })

  it('refuses text on a folder', () => {
    const folder = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'World' })
    expect(() =>
      updateNotebookItem(db, { id: folder.id, content: notebookDocFromText('x') })
    ).toThrow(/no text/)
  })
})

describe('the notes binder’s sections (2026-10-16)', () => {
  /** An item as a project from before the sections stored it: at the top, no role. */
  function oldItem(
    id: string,
    kind: 'folder' | 'page',
    parentId: string | null,
    position: number
  ): void {
    db.insert(notebookItem)
      .values({
        id,
        parentId,
        kind,
        title: id,
        content: null,
        plain: '',
        position,
        deleted: null,
        created: '2026-10-15T00:00:00.000Z',
        modified: '2026-10-15T00:00:00.000Z',
        role: null
      })
      .run()
  }

  const top = (): [string, string | null | undefined][] =>
    listNotebook(db)
      .filter((item) => item.parentId === null)
      .map((item) => [item.title, item.role])

  it('makes Outline, Timeline and Documents at the top of a fresh project, once', () => {
    expect(ensureNotebookSections(db)).toHaveLength(3)
    expect(top()).toEqual([
      ['Outline', 'outline'],
      ['Timeline', 'timeline'],
      ['Documents', 'documents']
    ])
    const before = JSON.stringify(listNotebook(db))
    expect(ensureNotebookSections(db)).toEqual([])
    expect(JSON.stringify(listNotebook(db))).toBe(before)
  })

  it('moves an older project’s top-level notes into Documents, in their order, and changes nothing the second time', () => {
    oldItem('Docs', 'folder', null, 0)
    oldItem('Powers', 'page', 'Docs', 0)
    oldItem('Ideas', 'page', null, 2)
    oldItem('Characters', 'folder', null, 1)
    ensureNotebookSections(db)
    expect(top().map(([title]) => title)).toEqual(['Outline', 'Timeline', 'Documents'])
    const documents = notebookSectionId(db, 'documents')
    expect(
      listNotebook(db)
        .filter((item) => item.parentId === documents)
        .map((item) => item.title)
    ).toEqual(['Docs', 'Characters', 'Ideas'])
    expect(getNotebookPage(db, 'Powers').parentId).toBe('Docs')
    const before = JSON.stringify(listNotebook(db))
    expect(ensureNotebookSections(db)).toEqual([])
    expect(JSON.stringify(listNotebook(db))).toBe(before)
  })

  it('never renames, moves or deletes a section; a move to the top goes into Documents', () => {
    ensureNotebookSections(db)
    const outline = notebookSectionId(db, 'outline')
    const documents = notebookSectionId(db, 'documents')
    expect(() => updateNotebookItem(db, { id: outline, title: 'Plans' })).toThrow(
      /Outline is one of the Notes sections; it cannot be renamed/
    )
    expect(() => moveNotebookItem(db, { id: outline, parentId: documents, position: 0 })).toThrow(
      /cannot be moved/
    )
    expect(() => deleteNotebookItem(db, documents)).toThrow(/cannot be deleted/)
    const beats = createNotebookItem(db, { parentId: outline, kind: 'page', title: 'Beats' })
    moveNotebookItem(db, { id: beats.id, parentId: null, position: 4 })
    expect(getNotebookPage(db, beats.id).parentId).toBe(documents)
    expect(top().map(([title]) => title)).toEqual(['Outline', 'Timeline', 'Documents'])
  })
})
