import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ClearSelection } from '@shared/bibleClear'
import type { TiptapNodeT } from '@shared/tiptap'
import { resolveAgentEdit, loadAgentProject } from '../ai/agentTools'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { getNotes, saveNotes } from '../document/notesStore'
import { createEntity, getEntity, listEntities } from '../entity/entityStore'
import { listFactsForEntity } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { addContextFiles, listContextFiles } from '../library/libraryStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getDismissedNames, getObservedDismissed } from '../project/settingsStore'
import { addDocumentTag, listDocumentTags } from '../tag/documentTagStore'
import { createTag, deleteTag, getTagWithUsage, listTags } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { clearOptions, clearStoryBible } from './bibleClear'
import { listChanges, undoChange, undoRun } from './changeLog'

/**
 * F-5.25: Clear the story bible. One transaction removes whole kinds (sheets by category, tags by
 * tag category, Library uploads, notes), logs one Changes row, and its Undo puts every row back.
 * Scene text is never touched; binder documents are never deleted.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const NOW = '2026-10-10T10:00:00.000Z'
const SCENE_DOC: TiptapNodeT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mara rowed out to the elm.' }] }]
}
const NOTES_DOC: TiptapNodeT = {
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Mara lies here.' }] }]
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-clear-'))
  session = createProject(projectFolderFor(tmp, 'Clear'), 'Clear', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const refusal = (run: () => unknown): string => {
  try {
    run()
  } catch (err) {
    if (err instanceof AppError) return `${err.code}: ${err.message}`
    throw err
  }
  return 'no refusal'
}

/** A small story bible: two characters (one with a tag on the scene), a place, a tone tag, an upload, notes. */
async function seed(): Promise<{ mara: string; tomas: string; elm: string; tone: string }> {
  saveDocument(db, scene, SCENE_DOC)
  const mara = createEntity(db, {
    kind: 'character',
    name: 'Mara',
    fields: { age: '19', personality: 'Patient' }
  }).entity
  const tomas = createEntity(db, { kind: 'character', name: 'Tomas' }).entity
  const elm = createEntity(db, { kind: 'setting', name: 'The Elm' }).entity
  const tone = createTag(db, { name: 'dread', category: 'tone' })
  addDocumentTag(db, scene, tone.id)
  if (mara.tagId !== null) addDocumentTag(db, scene, mara.tagId)
  await addContextFiles(db, session.folder, [
    { name: 'people.md', read: () => Buffer.from('Mara is 19.', 'utf8') }
  ])
  saveNotes(db, scene, NOTES_DOC)
  return { mara: mara.id, tomas: tomas.id, elm: elm.id, tone: tone.id }
}

const ALL: ClearSelection = {
  sheets: ['character', 'setting'],
  tags: ['character', 'setting', 'worldBuilding', 'tone', 'content', 'plotThread', 'custom'],
  library: true,
  notes: true
}

describe('clearOptions (F-5.25)', () => {
  it('lists each kind the project has with its count, ticked as the request named it', async () => {
    await seed()
    const options = clearOptions(db, {
      sheets: new Set(['character']),
      tags: 'all',
      library: true,
      notes: false
    })
    const line = (group: string, id: string) =>
      options.find((o) => o.group === group && o.id === id)
    expect(line('sheets', 'character')).toMatchObject({ count: 2, checked: true })
    expect(line('sheets', 'setting')).toMatchObject({ count: 1, checked: false })
    expect(line('tags', 'tone')).toMatchObject({ count: 1, checked: true })
    expect(line('library', 'library')).toMatchObject({ count: 1, checked: true })
    expect(line('notes', 'notes')).toMatchObject({ count: 1, checked: false })
    // Empty kinds are left out.
    expect(line('tags', 'content')).toBeUndefined()
  })
})

describe('clearStoryBible (F-5.25)', () => {
  it('removes every ticked kind in one logged row, never touching scene text or the binder', async () => {
    const ids = await seed()
    const nodesBefore = listNodes(db).map((row) => row.id)
    const dismissedBefore = getDismissedNames(db)
    const observedBefore = getObservedDismissed(db)
    const outcome = clearStoryBible(db, ALL, 'chat:m1', NOW)

    expect(outcome.counts).toMatchObject({ sheets: 3, library: 1, notes: 1 })
    expect(outcome.counts.tags).toBe(listTags(db).length + outcome.removedTagIds.length)
    expect(listEntities(db)).toEqual([])
    expect(listTags(db)).toEqual([])
    expect(listContextFiles(db)).toEqual([])
    expect(listDocumentTags(db, scene)).toEqual([])
    expect(outcome.removedEntityIds.sort()).toEqual([ids.mara, ids.tomas, ids.elm].sort())
    // The scene's text is byte for byte what it was; no binder document went.
    expect(getDocumentContent(db, scene).content).toEqual(SCENE_DOC)
    expect(listNodes(db).map((row) => row.id)).toEqual(nodesBefore)
    expect(JSON.stringify(getNotes(db, scene).notes)).not.toContain('Mara lies here')
    // A fresh start: nothing joins the dismissed lists.
    expect(getDismissedNames(db)).toEqual(dismissedBefore)
    expect(getObservedDismissed(db)).toEqual(observedBefore)

    const page = listChanges(db, { limit: 10 })
    expect(page.entries).toHaveLength(1)
    expect(page.entries[0]).toMatchObject({
      runId: 'chat:m1',
      source: 'chat',
      kind: 'clear',
      undoable: true,
      label: 'Cleared 3 sheets, ' + `${outcome.counts.tags} tags, 1 upload, the notes of 1 document`
    })
  })

  it('removes only the ticked categories', async () => {
    const ids = await seed()
    clearStoryBible(
      db,
      { sheets: ['setting'], tags: ['tone'], library: false, notes: false },
      'chat:m2',
      NOW
    )
    expect(
      listEntities(db)
        .map((e) => e.id)
        .sort()
    ).toEqual([ids.mara, ids.tomas].sort())
    expect(getTagWithUsage(db, ids.tone)).toBeUndefined()
    expect(listContextFiles(db)).toHaveLength(1)
    expect(JSON.stringify(getNotes(db, scene).notes)).toContain('Mara lies here')
  })

  it('refuses an empty selection, and one whose kinds are already empty', async () => {
    expect(
      refusal(() =>
        clearStoryBible(db, { sheets: [], tags: [], library: false, notes: false }, 'chat:m3', NOW)
      )
    ).toBe('VALIDATION: Nothing is ticked to delete')
    expect(
      refusal(() =>
        clearStoryBible(
          db,
          { sheets: ['world'], tags: [], library: true, notes: false },
          'chat:m3',
          NOW
        )
      )
    ).toBe('VALIDATION: There is nothing of that kind left to delete')
    expect(listChanges(db, { limit: 10 }).entries).toEqual([])
  })

  it('Undo puts every row back: sheets with their facts, tags and their links, uploads, notes', async () => {
    const ids = await seed()
    const maraBefore = getEntity(db, ids.mara)
    const factsBefore = listFactsForEntity(db, ids.mara)
    const tagsBefore = listTags(db)
    const linksBefore = listDocumentTags(db, scene)
    const filesBefore = listContextFiles(db)
    const notesBefore = getNotes(db, scene).notes
    const outcome = clearStoryBible(db, ALL, 'chat:m4', NOW)

    const undone = undoChange(db, outcome.entry.id)
    expect(undone.entries[0]).toMatchObject({ kind: 'clear', status: 'undone' })
    expect(getEntity(db, ids.mara)).toEqual(maraBefore)
    expect(listFactsForEntity(db, ids.mara)).toEqual(factsBefore)
    expect(listTags(db)).toEqual(tagsBefore)
    expect(listDocumentTags(db, scene)).toEqual(linksBefore)
    expect(listContextFiles(db)).toEqual(filesBefore)
    expect(getNotes(db, scene).notes).toEqual(notesBefore)
    expect(getDocumentContent(db, scene).content).toEqual(SCENE_DOC)
    expect(undone.restoredEntityIds).toEqual(expect.arrayContaining([ids.mara, ids.tomas, ids.elm]))
    expect(undone.restoredLibraryIds).toHaveLength(1)
    expect(undone.restoredNotesNodeIds).toEqual([scene])
    expect(undone.nodeIds).toContain(scene)
  })

  it('puts a kept sheet’s tag back when only its tag was cleared', async () => {
    const ids = await seed()
    const before = getEntity(db, ids.mara)
    expect(before?.tagId).not.toBeNull()
    const outcome = clearStoryBible(
      db,
      { sheets: [], tags: ['character'], library: false, notes: false },
      'chat:m5',
      NOW
    )
    expect(getEntity(db, ids.mara)?.tagId).toBeNull()
    undoRun(db, outcome.entry.runId)
    expect(getEntity(db, ids.mara)?.tagId).toBe(before?.tagId)
  })

  it('refuses the Undo whole when something of the same name was made again since', async () => {
    const ids = await seed()
    const outcome = clearStoryBible(db, ALL, 'chat:m6', NOW)
    createTag(db, { name: 'dread', category: 'tone' })
    expect(refusal(() => undoChange(db, outcome.entry.id))).toMatch(
      /^VALIDATION: #dread was made again since the clear/
    )
    // Nothing came back, and the row is still applied.
    expect(getEntity(db, ids.mara)).toBeUndefined()
    expect(listChanges(db, { limit: 10 }).entries[0]?.status).toBe('applied')
  })

  it('refuses the Undo when the cleared notes have been written in since', async () => {
    await seed()
    const outcome = clearStoryBible(
      db,
      { sheets: [], tags: [], library: false, notes: true },
      'chat:m7',
      NOW
    )
    saveNotes(db, scene, NOTES_DOC)
    expect(refusal(() => undoChange(db, outcome.entry.id))).toMatch(
      /^VALIDATION: You have written notes in .* since the clear/
    )
  })

  it('puts a sheet back without the links to a tag deleted since', async () => {
    const ids = await seed()
    const outcome = clearStoryBible(
      db,
      { sheets: ['character'], tags: [], library: false, notes: false },
      'chat:m8',
      NOW
    )
    deleteTag(db, ids.tone)
    undoChange(db, outcome.entry.id)
    expect(getEntity(db, ids.mara)?.name).toBe('Mara')
  })
})

describe('the clear edit (agent.v7)', () => {
  it('resolves "everything in the story bible" to every kind the request named, ticked', async () => {
    await seed()
    const resolved = resolveAgentEdit(loadAgentProject(db), {
      edit: 'clear',
      sheets: 'all',
      tags: 'all',
      library: true
    })
    if (!('edit' in resolved) || resolved.edit.kind !== 'clear') throw new Error('not a clear')
    const ticked = resolved.edit.options.filter((o) => o.checked).map((o) => `${o.group}:${o.id}`)
    expect(ticked).toEqual(
      expect.arrayContaining(['sheets:character', 'sheets:setting', 'library:library'])
    )
    expect(resolved.edit.options.find((o) => o.group === 'notes')?.checked).toBe(false)
  })

  it('reads category names leniently and refuses a request naming nothing the project has', async () => {
    await seed()
    const project = loadAgentProject(db)
    const resolved = resolveAgentEdit(project, { edit: 'clear', sheets: ['Characters'] })
    if (!('edit' in resolved) || resolved.edit.kind !== 'clear') throw new Error('not a clear')
    expect(resolved.edit.options.filter((o) => o.checked).map((o) => o.id)).toEqual(['character'])
    expect(resolveAgentEdit(project, { edit: 'clear', sheets: ['dragons'] })).toEqual({
      error: 'nothing of those kinds'
    })
  })
})
