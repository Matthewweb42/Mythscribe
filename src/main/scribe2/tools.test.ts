import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { notebookDocFromText } from '@shared/notebook'
import { SCRIBE_MAX_WRITES, SCRIBE_VIBE_PROSE_MAX } from '@shared/scribe2'
import type { TiptapNodeT } from '@shared/tiptap'
import { node } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import {
  createNotebookItem,
  getNotebookPage,
  listNotebookPages,
  restoreNotebookVersion
} from '../notebook/notebookStore'
import { loadScribeSources } from './source'
import { diffWindow, editedContent, runScribeTool, sectionRange, type ScribeRun } from './tools'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string
let changed: string[][]

const doc = (text: string): string =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-scribe2-'))
  session = createProject(projectFolderFor(tmp, 'Scribe'), 'Scribe', 'novel')
  db = session.connection.orm
  const row = listNodes(db).find((each) => each.kind === 'document' && each.sectionType === null)
  if (row === undefined) throw new Error('skeleton not seeded')
  scene = row.id
  db.update(node)
    .set({ content: doc('Mara climbed the ridge alone.') })
    .where(eq(node.id, scene))
    .run()
  changed = []
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

async function run(
  access = { notes: true, prose: true },
  proseMax = SCRIBE_MAX_WRITES
): Promise<ScribeRun> {
  const material = await loadScribeSources(db, session.folder, scene)
  return {
    db,
    project: material.project,
    pages: material.pages,
    scenes: material.scenes,
    access,
    proseMax,
    profile: null,
    changes: [],
    used: new Set(),
    notebookChanged: (ids) => changed.push(ids)
  }
}

const sceneRef = (r: ScribeRun): string => r.project.refOf.get(scene) ?? ''

describe('Ms Scribe’s v1 tools (notes redesign phase 1)', () => {
  it('reads: lists the pages, opens a page and a scene, and records what she used', async () => {
    const mara = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Mara',
      content: notebookDocFromText('Eyes: grey')
    })
    const r = await run()
    expect(runScribeTool(r, 'list_notes', {}).result).toBe('p1 Mara (note, 2 words)')
    expect(runScribeTool(r, 'open_note', { id: 'p1' }).result).toBe('p1 Mara:\nEyes: grey')
    expect(runScribeTool(r, 'open_note', { id: 'mara' }).step.label).toBe('Reading Mara…')
    const opened = runScribeTool(r, 'open_scene', { id: sceneRef(r) })
    expect(opened.result).toContain('Mara climbed the ridge alone.')
    expect([...r.used]).toEqual([mara.id, scene])
    expect(runScribeTool(r, 'open_scene', { id: 'n999' }).result).toContain('is not a scene')
    expect(runScribeTool(r, 'fly', {}).result).toContain('There is no tool "fly"')
  })

  it('edit_note rewrites a page through the store, keeps the version for Undo, and tells the windows', async () => {
    const mara = createNotebookItem(db, {
      parentId: null,
      kind: 'page',
      title: 'Mara',
      content: notebookDocFromText('Eyes: grey')
    })
    const r = await run()
    const out = runScribeTool(r, 'edit_note', { id: 'p1', text: 'Eyes: grey\nFears the sea' })
    expect(out.result).toBe('Edited p1 Mara.')
    expect(getNotebookPage(db, mara.id).plain).toBe('Eyes: grey\nFears the sea')
    expect(changed).toEqual([[mara.id]])
    const change = r.changes[0]
    expect(change?.applied).toBe(true)
    expect(change?.proposal.edit).toMatchObject({
      kind: 'notebook',
      pageId: mara.id,
      created: false,
      before: 'Eyes: grey',
      after: 'Eyes: grey\nFears the sea'
    })
    const edit = change?.proposal.edit
    if (edit?.kind !== 'notebook' || edit.versionId === null) throw new Error('no version kept')
    restoreNotebookVersion(db, edit.versionId)
    expect(getNotebookPage(db, mara.id).plain).toBe('Eyes: grey')
  })

  it('create_note makes a page (in a folder by title), which later tools can name', async () => {
    const people = createNotebookItem(db, { parentId: null, kind: 'folder', title: 'People' })
    const r = await run()
    const out = runScribeTool(r, 'create_note', {
      title: 'Rook',
      text: 'A smuggler.',
      folder: 'people'
    })
    expect(out.result).toBe('Created p1 Rook in People.')
    const [page] = listNotebookPages(db)
    expect(page).toMatchObject({ title: 'Rook', parentId: people.id, plain: 'A smuggler.' })
    expect(r.changes[0]?.proposal.edit).toMatchObject({
      kind: 'notebook',
      created: true,
      versionId: null
    })
    expect(runScribeTool(r, 'edit_note', { id: 'p1', text: 'More', append: true }).result).toBe(
      'Edited p1 Rook.'
    )
    expect(getNotebookPage(db, page?.id ?? '').plain).toBe('A smuggler.\nMore')
  })

  it('Brainstorm refuses every write; a sheet is read-only', async () => {
    createNotebookItem(db, { parentId: null, kind: 'page', title: 'Mara' })
    const r = await run({ notes: false, prose: false })
    expect(runScribeTool(r, 'edit_note', { id: 'p1', text: 'x' }).result).toContain('Brainstorm')
    expect(runScribeTool(r, 'create_note', { title: 'X' }).result).toContain('Brainstorm')
    expect(
      runScribeTool(r, 'propose_prose_edit', { id: sceneRef(r), find: 'Mara', replace: 'She' })
        .result
    ).toContain('No prose changes')
    expect(r.changes).toEqual([])
    const sheet = await run()
    sheet.pages.push({ ref: 'p9', id: 'e-1', kind: 'sheet', title: 'Pell', folder: '', text: '' })
    expect(runScribeTool(sheet, 'edit_note', { id: 'p9', text: 'x' }).result).toContain('read-only')
  })

  it('propose_prose_edit offers a replacement for the author, never writing the book', async () => {
    const r = await run()
    const out = runScribeTool(r, 'propose_prose_edit', {
      id: sceneRef(r),
      find: 'climbed the ridge alone',
      replace: 'climbed the ridge with Rook'
    })
    expect(out.result).toBe('Offered to the author.')
    expect(r.changes[0]).toMatchObject({
      applied: false,
      proposal: { edit: { kind: 'text', nodeId: scene, replace: 'climbed the ridge with Rook' } }
    })
    const missing = runScribeTool(r, 'propose_prose_edit', {
      id: sceneRef(r),
      find: 'not in the scene',
      replace: 'x'
    })
    expect(missing.result).toContain('Not offered')
    expect(listNodes(db).find((row) => row.id === scene)?.content).toBe(
      doc('Mara climbed the ridge alone.')
    )
  })
})

describe('Vibe’s prose suggestions (scribe.v3, 2026-10-15)', () => {
  it('keeps at most three a message in Vibe, note edits not counted', async () => {
    db.update(node)
      .set({ content: doc('One. Two. Three. Four. Five.') })
      .where(eq(node.id, scene))
      .run()
    createNotebookItem(db, { parentId: null, kind: 'page', title: 'Mara' })
    const r = await run({ notes: true, prose: true }, SCRIBE_VIBE_PROSE_MAX)
    expect(runScribeTool(r, 'edit_note', { id: 'p1', text: 'Grey eyes.' }).result).toContain(
      'Edited'
    )
    for (const find of ['One.', 'Two.', 'Three.']) {
      const out = runScribeTool(r, 'propose_prose_edit', { id: sceneRef(r), find, replace: 'Yes.' })
      expect(out.result).toBe('Offered to the author.')
    }
    const fourth = runScribeTool(r, 'propose_prose_edit', {
      id: sceneRef(r),
      find: 'Four.',
      replace: 'Yes.'
    })
    expect(fourth.result).toBe('No more prose suggestions in this message (at most 3); answer now.')
    expect(r.changes.filter((change) => !change.applied)).toHaveLength(3)
    expect(r.changes).toHaveLength(4)
  })
})

describe('section edits', () => {
  const heading = (text: string, level = 2): TiptapNodeT => ({
    type: 'heading',
    attrs: { level },
    content: [{ type: 'text', text }]
  })
  const para = (text: string): TiptapNodeT =>
    text === '' ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text }] }
  const page: TiptapNodeT = {
    type: 'doc',
    content: [
      heading('Mara', 1),
      heading('Powers'),
      para('Reads tides.'),
      para('Hears bells.'),
      heading('Fears'),
      para('The sea.')
    ]
  }
  const plain = (content: TiptapNodeT | { error: string }): string[] =>
    'error' in content
      ? [content.error]
      : (content.content ?? []).map((block) =>
          (block.content ?? []).map((inline) => inline.text ?? '').join('')
        )

  it('finds a heading section up to the next heading of its level, and a plain line up to a blank one', () => {
    expect(sectionRange(page.content ?? [], '## Powers:')).toEqual({ start: 1, end: 4 })
    expect(sectionRange(page.content ?? [], 'mara')).toEqual({ start: 0, end: 6 })
    const flat = [para('Powers:'), para('Reads tides.'), para(''), para('Fears:')]
    expect(sectionRange(flat, 'powers')).toEqual({ start: 0, end: 2 })
    expect(sectionRange(flat, 'Wants')).toBeNull()
  })

  it('replaces the text under a heading, keeps the heading, and appends within a section', () => {
    expect(plain(editedContent(page, 'Reads storms.', 'Powers', false))).toEqual([
      'Mara',
      'Powers',
      'Reads storms.',
      'Fears',
      'The sea.'
    ])
    expect(plain(editedContent(page, 'Sees ghosts.', 'Powers', true))).toEqual([
      'Mara',
      'Powers',
      'Reads tides.',
      'Hears bells.',
      'Sees ghosts.',
      'Fears',
      'The sea.'
    ])
    expect(plain(editedContent(page, 'x', 'Wants', false))[0]).toContain('No line reads “Wants”')
  })

  it('keeps a short window around the change for its highlight', () => {
    const before = `${'a'.repeat(500)} grey ${'b'.repeat(500)}`
    const after = `${'a'.repeat(500)} brown ${'b'.repeat(500)}`
    const window = diffWindow(before, after)
    expect(window.before).toContain(' grey ')
    expect(window.after).toContain(' brown ')
    expect(window.before.length).toBeLessThan(300)
  })
})
