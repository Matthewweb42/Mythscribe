import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEdit } from '@shared/agent'
import { notebookDocFromText } from '@shared/notebook'
import { SCRIBE_MAX_STRUCTURE, SCRIBE_MAX_WRITES, type ScribeAccess } from '@shared/scribe2'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import {
  createNotebookItem,
  getNotebookPage,
  listNotebook,
  moveNotebookItem,
  notebookSectionId,
  updateNotebookItem
} from '../notebook/notebookStore'
import { loadScribeSources } from './source'
import { runScribeTool, type ScribeRun } from './tools'
import { findFolder } from './structure'

/**
 * Notes structure part C (scribe.v5, 2026-10-16): Ms Scribe's structure tools. Notes folders and
 * pages are made, moved and renamed at once (each change carrying its Undo's data), a deletion
 * only asks; the manuscript's tools resolve to the chat agent's own edits, left for the chat to
 * apply; Brainstorm refuses them all; one message makes at most `SCRIBE_MAX_STRUCTURE`.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let changed: string[][]
let chapter: string
let scene: string

const WRITE: ScribeAccess = { notes: true, prose: true, structure: true }

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-structure-'))
  session = createProject(projectFolderFor(tmp, 'Structure'), 'Structure', 'novel')
  db = session.connection.orm
  const row = listNodes(db).find((each) => each.kind === 'document' && each.sectionType === null)
  if (row?.parentId == null) throw new Error('skeleton not seeded')
  scene = row.id
  chapter = row.parentId
  changed = []
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function run(access: ScribeAccess = WRITE): Promise<ScribeRun> {
  const material = await loadScribeSources(db, session.folder, scene)
  return {
    db,
    project: material.project,
    pages: material.pages,
    scenes: material.scenes,
    access,
    proseMax: SCRIBE_MAX_WRITES,
    profile: null,
    changes: [],
    used: new Set(),
    notebookChanged: (ids) => changed.push(ids)
  }
}

const page = (title: string, parentId: string | null = null): string =>
  createNotebookItem(db, {
    parentId,
    kind: 'page',
    title,
    content: notebookDocFromText(`${title}'s page`)
  }).id

const folder = (title: string, parentId: string | null = null): string =>
  createNotebookItem(db, { parentId, kind: 'folder', title }).id

const edits = (r: ScribeRun): AgentEdit[] => r.changes.map((change) => change.proposal.edit)

/** The notes binder: the Documents section, where the top's things go. */
const documents = (): string => notebookSectionId(db, 'documents')

/** The items that are not section roots. */
const ordinary = (): ReturnType<typeof listNotebook> =>
  listNotebook(db).filter((item) => item.role == null)

describe('Ms Scribe’s Notes structure tools (scribe.v5)', () => {
  it('create_folder makes a folder, its missing parent too, and refuses a duplicate', async () => {
    const r = await run()
    // The notes binder: a path that is not under a section is made in Documents.
    expect(runScribeTool(r, 'create_folder', { title: 'Minor', parent: 'Characters' }).result).toBe(
      'Made the folder Documents › Characters › Minor.'
    )
    const items = listNotebook(db)
    const characters = items.find((item) => item.title === 'Characters')
    expect(characters?.parentId).toBe(documents())
    expect(items.find((item) => item.title === 'Minor')?.parentId).toBe(characters?.id)
    expect(edits(r)).toEqual([
      {
        kind: 'notebookFolder',
        folderId: characters?.id,
        title: 'Characters',
        parent: 'Documents'
      },
      {
        kind: 'notebookFolder',
        folderId: items.find((item) => item.title === 'Minor')?.id,
        title: 'Minor',
        parent: 'Documents › Characters'
      }
    ])
    expect(r.changes.every((change) => change.applied)).toBe(true)
    expect(changed).toHaveLength(2)
    expect(runScribeTool(r, 'create_folder', { title: 'characters' }).result).toBe(
      'characters already exists there.'
    )
    expect(r.changes).toHaveLength(2)
  })

  it('create_note into a missing folder makes it in Write; Brainstorm-to-save keeps it at the top', async () => {
    const r = await run()
    expect(runScribeTool(r, 'create_note', { title: 'Tash', folder: 'Smugglers' }).result).toBe(
      'Created p1 Tash in Smugglers.'
    )
    const smugglers = listNotebook(db).find((item) => item.title === 'Smugglers')
    expect(listNotebook(db).find((item) => item.title === 'Tash')?.parentId).toBe(smugglers?.id)
    expect(edits(r).map((edit) => edit.kind)).toEqual(['notebookFolder', 'notebook'])

    const save = await run({ notes: true, prose: false, structure: false })
    expect(runScribeTool(save, 'create_note', { title: 'Rook', folder: 'Places' }).result).toBe(
      'Created p2 Rook (no such folder; made in Documents).'
    )
    expect(listNotebook(db).some((item) => item.title === 'Places')).toBe(false)
    expect(listNotebook(db).find((item) => item.title === 'Rook')?.parentId).toBe(documents())
    // A section's name finds its root: a page made in Outline.
    expect(runScribeTool(r, 'create_note', { title: 'Beats', folder: 'Outline' }).result).toBe(
      'Created p2 Beats in Outline.'
    )
    expect(listNotebook(db).find((item) => item.title === 'Beats')?.parentId).toBe(
      notebookSectionId(db, 'outline')
    )
  })

  it('move_note moves several pages into a folder in one call, made when missing, keeping where each was', async () => {
    const tash = page('Tash')
    const mara = page('Mara')
    const r = await run()
    const out = runScribeTool(r, 'move_note', { ids: ['p1', 'Mara'], to: 'Characters' })
    expect(out.result).toBe('Moved Tash, Mara into Characters.')
    const characters = listNotebook(db).find((item) => item.title === 'Characters')
    const moved = listNotebook(db).filter((item) => item.parentId === characters?.id)
    expect(moved.map((item) => item.title)).toEqual(['Tash', 'Mara'])
    const move = edits(r).find((edit) => edit.kind === 'notebookMove')
    expect(move).toEqual({
      kind: 'notebookMove',
      items: [
        { id: tash, title: 'Tash', folder: false, fromParentId: documents(), fromPosition: 0 },
        { id: mara, title: 'Mara', folder: false, fromParentId: documents(), fromPosition: 1 }
      ],
      parentId: characters?.id,
      parentTitle: 'Characters'
    })
    // Her pages know their new folder.
    expect(r.pages.map((p) => p.folder)).toEqual([
      'Documents › Characters',
      'Documents › Characters'
    ])
    // The Undo's data puts each back where it was.
    if (move?.kind !== 'notebookMove') throw new Error('no move')
    for (const item of [...move.items].reverse()) {
      moveNotebookItem(db, {
        id: item.id,
        parentId: item.fromParentId,
        position: item.fromPosition
      })
    }
    expect(
      listNotebook(db)
        .filter((item) => item.parentId === documents() && item.kind === 'page')
        .map((item) => item.title)
    ).toEqual(['Tash', 'Mara'])
    expect(runScribeTool(r, 'move_note', { ids: ['Tash'], to: 'top' }).result).toBe(
      'Already there; nothing moved.'
    )
  })

  it('move_note refuses a folder into itself and an unknown page, moving nothing', async () => {
    const world = folder('World')
    folder('Magic', world)
    page('Tash')
    const r = await run()
    expect(runScribeTool(r, 'move_note', { ids: ['World'], to: 'World › Magic' }).result).toBe(
      'Nothing moved: World cannot go inside itself.'
    )
    expect(runScribeTool(r, 'move_note', { ids: ['p1', 'Nobody'], to: 'World' }).result).toContain(
      'Nothing moved: no page or folder is “Nobody”'
    )
    expect(r.changes).toEqual([])
    expect(listNotebook(db).find((item) => item.title === 'Tash')?.parentId).toBe(documents())
  })

  it('never moves, renames or deletes a section (the notes binder)', async () => {
    page('Tash')
    const r = await run()
    expect(runScribeTool(r, 'move_note', { ids: ['Outline'], to: 'Documents' }).result).toBe(
      'Nothing moved: Outline is one of the Notes sections; it cannot be moved.'
    )
    expect(runScribeTool(r, 'rename_note', { id: 'Timeline', title: 'Events' }).result).toBe(
      'Not renamed: Timeline is one of the Notes sections; it cannot be renamed.'
    )
    expect(runScribeTool(r, 'delete_note', { id: 'Documents' }).result).toBe(
      'Not asked: Documents is one of the Notes sections; it cannot be deleted.'
    )
    expect(r.changes).toEqual([])
    // "Put it in Outline" finds the section.
    expect(runScribeTool(r, 'move_note', { ids: ['Tash'], to: 'Outline' }).result).toBe(
      'Moved Tash into Outline.'
    )
  })

  it('rename_note renames a page or folder at once with the old title for its Undo', async () => {
    const id = page('Tash')
    const r = await run()
    expect(runScribeTool(r, 'rename_note', { id: 'p1', title: 'Tash Venn' }).result).toBe(
      'Renamed Tash to “Tash Venn”.'
    )
    expect(getNotebookPage(db, id).title).toBe('Tash Venn')
    expect(edits(r)).toEqual([
      { kind: 'notebookRename', id, folder: false, title: 'Tash', after: 'Tash Venn' }
    ])
    expect(r.pages[0]?.title).toBe('Tash Venn')
    updateNotebookItem(db, { id, title: 'Tash' })
    expect(getNotebookPage(db, id).title).toBe('Tash')
  })

  it('delete_note only asks: nothing is deleted until the author presses Delete', async () => {
    const world = folder('World')
    page('Magic', world)
    page('Rivers', world)
    const r = await run()
    expect(runScribeTool(r, 'delete_note', { id: 'World' }).result).toBe(
      'Asked her to delete World; nothing is deleted until she presses Delete.'
    )
    expect(r.changes).toEqual([
      {
        proposal: {
          edit: { kind: 'notebookDelete', id: world, title: 'World', folder: true, pages: 2 },
          violation: null
        },
        applied: false
      }
    ])
    expect(ordinary()).toHaveLength(3)
  })

  it('list_notes names the folders by path, Templates left out', async () => {
    const characters = folder('Characters')
    folder('Minor', characters)
    const templates = folder('Templates')
    folder('Old', templates)
    const r = await run()
    expect(runScribeTool(r, 'list_notes', {}).result).toBe(
      'There are no note pages yet.\nFolders: Documents, Documents › Characters, Documents › Characters › Minor, Outline, Timeline'
    )
  })

  it('finds a folder by path, by name (shallowest first), a section by its name, and the top as Documents', () => {
    const characters = folder('Characters')
    const minor = folder('Minor', characters)
    const top = folder('Minor')
    const plans = folder('Chapter plans', notebookSectionId(db, 'outline'))
    const items = listNotebook(db)
    expect(findFolder(items, 'Characters › Minor')?.id).toBe(minor)
    expect(findFolder(items, 'Documents › Characters › Minor')?.id).toBe(minor)
    expect(findFolder(items, 'characters/minor')?.id).toBe(minor)
    expect(findFolder(items, 'minor')?.id).toBe(top)
    expect(findFolder(items, 'Outline')?.id).toBe(notebookSectionId(db, 'outline'))
    expect(findFolder(items, 'timeline')?.id).toBe(notebookSectionId(db, 'timeline'))
    expect(findFolder(items, 'Outline › Chapter plans')?.id).toBe(plans)
    expect(findFolder(items, 'top')?.id).toBe(documents())
    expect(findFolder(items, 'Places')).toBeUndefined()
    // Before the sections exist the top is null, as it was.
    expect(findFolder([], 'top')).toBeNull()
  })
})

describe('Ms Scribe’s manuscript structure tools (scribe.v5)', () => {
  const ref = (r: ScribeRun, id: string): string => r.project.refOf.get(id) ?? ''

  it('create_chapter makes the old agent’s create edit at the top of the book, with scenes to move in', async () => {
    const r = await run()
    const out = runScribeTool(r, 'create_chapter', {
      title: 'The Fall',
      scenes: [ref(r, scene)]
    })
    const root = listNodes(db).find(
      (row) => row.parentId === null && row.sectionType === 'manuscript'
    )
    expect(out.result).toBe(
      'Done: Created the chapter “The Fall” in Manuscript, with one item moved in (she can undo it).'
    )
    expect(r.changes).toEqual([
      {
        proposal: {
          edit: {
            kind: 'create',
            level: 'chapter',
            parentId: root?.id,
            parentTitle: 'Manuscript',
            afterId: null,
            title: 'The Fall',
            text: '',
            moveIn: [{ nodeId: scene, title: r.project.titleOf(scene) }]
          },
          violation: null
        },
        applied: false
      }
    ])
    // Nothing in the tree changes in main: the chat applies it.
    expect(listNodes(db).some((row) => row.title === 'The Fall')).toBe(false)
  })

  it('move_scene into a chapter made earlier in the message goes in with it', async () => {
    const r = await run()
    runScribeTool(r, 'create_chapter', { title: 'The Fall' })
    expect(runScribeTool(r, 'move_scene', { ids: [ref(r, scene)], to: 'the fall' }).result).toBe(
      'Done: they go into the new chapter The Fall as it is made (she can undo it).'
    )
    const made = edits(r)[0]
    expect(made?.kind === 'create' ? made.moveIn.map((n) => n.nodeId) : null).toEqual([scene])
    expect(r.changes).toHaveLength(1)
  })

  it('move_scene, rename_scene and split_scene resolve to the old agent’s edits, by ref or title', async () => {
    const root = listNodes(db).find(
      (row) => row.parentId === null && row.sectionType === 'manuscript'
    )
    if (root === undefined) throw new Error('no manuscript')
    const other = createNode(db, 'novel', {
      parentId: root.id,
      kind: 'folder',
      hierarchyLevel: 'chapter',
      title: 'Act Two'
    })
    const r = await run()
    const chapterTitle = listNodes(db).find((row) => row.id === chapter)?.title
    expect(runScribeTool(r, 'move_scene', { ids: [ref(r, scene)], to: 'Act Two' }).result).toMatch(
      /^Done: Moved .* into Act Two/
    )
    expect(
      runScribeTool(r, 'rename_scene', { id: ref(r, chapter), title: 'Opening' }).result
    ).toMatch(/^Done: Renamed .* to “Opening”/)
    expect(edits(r)).toEqual([
      {
        kind: 'moveMany',
        nodes: [{ nodeId: scene, title: r.project.titleOf(scene) }],
        parentId: other.id,
        parentTitle: r.project.titleOf(other.id) || 'Act Two'
      },
      { kind: 'rename', nodeId: chapter, title: chapterTitle, after: 'Opening' }
    ])
    expect(runScribeTool(r, 'split_scene', { id: ref(r, scene), at: 'not there' }).result).toBe(
      `Not done: the "at" passage is not in ${r.project.titleOf(scene)}.`
    )
    expect(runScribeTool(r, 'move_scene', { ids: ['n999'], to: 'Nowhere' }).result).toContain(
      'Not done: nothing is called “n999”.'
    )
    expect(r.changes.every((change) => !change.applied)).toBe(true)
  })

  it('merge_scenes and delete_scene only ask', async () => {
    const r = await run()
    const out = runScribeTool(r, 'delete_scene', { id: ref(r, scene) })
    expect(out.result).toBe(
      `Asked her: Delete ${r.project.titleOf(scene)}. Nothing goes until she presses Delete.`
    )
    expect(edits(r)).toEqual([
      { kind: 'delete', target: 'node', id: scene, name: r.project.titleOf(scene) }
    ])
    expect(runScribeTool(r, 'delete_scene', { id: 'manuscript' }).result).toBe(
      'Not asked: the manuscript stays.'
    )
    expect(listNodes(db).some((row) => row.id === scene)).toBe(true)
  })
})

describe('structure tools by mode and cap (scribe.v5)', () => {
  it('Brainstorm refuses every structure tool, even asked to save', async () => {
    page('Tash')
    for (const access of [
      { notes: false, prose: false, structure: false },
      { notes: true, prose: false, structure: false }
    ]) {
      const r = await run(access)
      for (const [tool, args] of [
        ['create_folder', { title: 'X' }],
        ['move_note', { ids: ['p1'], to: 'X' }],
        ['rename_note', { id: 'p1', title: 'Y' }],
        ['delete_note', { id: 'p1' }],
        ['create_chapter', { title: 'X' }],
        ['move_scene', { ids: ['n1'], to: 'manuscript' }],
        ['delete_scene', { id: 'n1' }]
      ] as const) {
        expect(runScribeTool(r, tool, args).result).toBe(
          'Brainstorm changes nothing; answer instead.'
        )
      }
      expect(r.changes).toEqual([])
    }
    expect(ordinary()).toHaveLength(1)
  })

  it('caps structure changes at 40 a message, each item moved counted, apart from the 8 writes', async () => {
    const ids = Array.from({ length: SCRIBE_MAX_STRUCTURE }, (_, i) => page(`Page ${i + 1}`))
    const target = folder('All')
    const r = await run()
    const out = runScribeTool(r, 'move_note', { ids: ids.map((_, i) => `p${i + 1}`), to: 'All' })
    expect(out.result).toMatch(/^Moved Page 1, /)
    expect(listNotebook(db).filter((item) => item.parentId === target)).toHaveLength(40)
    expect(runScribeTool(r, 'create_folder', { title: 'More' }).result).toBe(
      'Refused: at most 40 structure changes a message (40 made); answer now and say what is left.'
    )
    // Note writes still have their own eight.
    expect(runScribeTool(r, 'edit_note', { id: 'p1', text: 'Still writes.' }).result).toBe(
      'Edited p1 Page 1.'
    )
  })
})
