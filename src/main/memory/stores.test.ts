import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'
import { SCENE_META_TIMELINE_MAX } from '@shared/sceneMeta'
import { LABEL_DEFAULT_COLOUR } from '@shared/storyLabels'
import { sceneDetail } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import {
  createAuthorTodo,
  deleteAuthorTodo,
  listAuthorTodos,
  reorderAuthorTodos,
  updateAuthorTodo
} from './authorTodoStore'
import { dismiss, dismissedKeys, isDismissed, listDismissed, undoDismissed } from './dismissedStore'
import {
  assignLabel,
  createLabel,
  deleteLabel,
  labelsForNode,
  listLabelLinks,
  listLabels,
  nodesOfLabel,
  reorderLabels,
  unassignLabel,
  updateLabel
} from './labelStore'
import { createRecord, deleteRecord } from './recordStore'
import {
  allSceneDetails,
  getSceneDetails,
  setSceneDetails,
  typedFlashbacks
} from './sceneDetailStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const at = (minute: number): Date => new Date(Date.UTC(2026, 9, 11, 12, minute, 0))

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-memory-stores-'))
  session = createProject(projectFolderFor(tmp, 'Stores'), 'Stores', 'novel')
  db = session.connection.orm
  scene = manuscriptDocuments(db)[0]?.id ?? ''
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const record = (name: string): string => {
  const made = createRecord(db, { name, categoryId: 'character', force: true }, at(0))
  if (!('record' in made)) throw new Error('blocked')
  return made.record.id
}

describe('labelStore (F-16.7)', () => {
  it('creates labels with their kind’s colour, unique by name whatever the case', () => {
    const tone = createLabel(db, { name: 'Wry', kind: 'tone' }, at(0))
    expect(tone).toMatchObject({ name: 'Wry', colour: LABEL_DEFAULT_COLOUR.tone, position: 0 })
    expect(() => createLabel(db, { name: ' wry ', kind: 'custom' }, at(1))).toThrow(
      /already a label/
    )
    const custom = createLabel(
      db,
      { name: 'Needs research', kind: 'custom', colour: '#123456' },
      at(1)
    )
    expect(custom).toMatchObject({ colour: '#123456', position: 1 })
    expect(updateLabel(db, custom.id, { name: 'Check facts', kind: 'theme' }, at(2))).toMatchObject(
      {
        name: 'Check facts',
        kind: 'theme'
      }
    )
    expect(() => updateLabel(db, custom.id, { name: 'WRY' }, at(3))).toThrow(/already a label/)
  })

  it('reorders, deletes and closes up', () => {
    const a = createLabel(db, { name: 'A', kind: 'tone' }, at(0))
    const b = createLabel(db, { name: 'B', kind: 'tone' }, at(0))
    const c = createLabel(db, { name: 'C', kind: 'tone' }, at(0))
    expect(reorderLabels(db, [c.id, a.id, b.id]).map((row) => row.name)).toEqual(['C', 'A', 'B'])
    expect(() => reorderLabels(db, [c.id, a.id])).toThrow(/every label once/)
    expect(deleteLabel(db, a.id).map((row) => [row.name, row.position])).toEqual([
      ['C', 0],
      ['B', 1]
    ])
  })

  it('assigns a label to a node once, lists both ways, and refuses a section root', () => {
    const tone = createLabel(db, { name: 'Wry', kind: 'tone' }, at(0))
    expect(assignLabel(db, tone.id, scene).map((row) => row.id)).toEqual([tone.id])
    expect(assignLabel(db, tone.id, scene)).toHaveLength(1)
    expect(nodesOfLabel(db, tone.id)).toEqual([scene])
    const root = listNodes(db).find((row) => row.parentId === null)
    expect(() => assignLabel(db, tone.id, root?.id ?? '')).toThrow(/section/)
    expect(unassignLabel(db, tone.id, scene)).toEqual([])
    expect(labelsForNode(db, scene)).toEqual([])
    assignLabel(db, tone.id, scene)
    deleteNode(db, scene)
    expect(nodesOfLabel(db, tone.id)).toEqual([])
    expect(listLabels(db)).toHaveLength(1)
  })

  it('lists every link by node, each node’s labels in label order (F-16.7 chips and filters)', () => {
    const wry = createLabel(db, { name: 'Wry', kind: 'tone' }, at(0))
    const grim = createLabel(db, { name: 'Grim', kind: 'tone' }, at(1))
    const other = createNode(db, 'novel', {
      parentId: listNodes(db).find((row) => row.id === scene)?.parentId ?? '',
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Two'
    }).id
    assignLabel(db, grim.id, scene)
    assignLabel(db, wry.id, scene)
    assignLabel(db, wry.id, other)
    const links = listLabelLinks(db)
    expect(links.filter((link) => link.nodeId === scene).map((link) => link.labelId)).toEqual([
      wry.id,
      grim.id
    ])
    expect(links.filter((link) => link.nodeId === other)).toEqual([
      { labelId: wry.id, nodeId: other }
    ])
    deleteLabel(db, wry.id)
    expect(listLabelLinks(db)).toEqual([{ labelId: grim.id, nodeId: scene }])
  })
})

describe('dismissedStore (F-16.10)', () => {
  it('writes one tombstone per kind and key, lists newest first, and undoes', () => {
    const first = dismiss(db, { kind: 'name', key: 'hesk', label: 'Hesk: not a name' }, at(0))
    expect(dismiss(db, { kind: 'name', key: 'hesk', label: 'again' }, at(1)).id).toBe(first.id)
    dismiss(db, { kind: 'alias', key: 'r|ry', label: 'Ry is not R' }, at(2))
    expect(listDismissed(db).items.map((row) => row.key)).toEqual(['r|ry', 'hesk'])
    expect(listDismissed(db).count).toBe(2)
    expect(dismissedKeys(db, 'name')).toEqual(new Set(['hesk']))
    expect(undoDismissed(db, first.id).key).toBe('hesk')
    expect(isDismissed(db, 'name', 'hesk')).toBe(false)
    expect(() => undoDismissed(db, first.id)).toThrow(/no longer dismissed/)
  })
})

describe('authorTodoStore (F-16.10)', () => {
  it('adds, ticks with a date, unticks, reorders and deletes; a link clears when its target goes', () => {
    const mara = record('Mara')
    const a = createAuthorTodo(
      db,
      { text: ' Fix the timeline ', nodeId: scene, recordId: mara },
      at(0)
    )
    const b = createAuthorTodo(db, { text: 'Name the ship', nodeId: null, recordId: null }, at(1))
    expect(a).toMatchObject({ text: 'Fix the timeline', position: 0, done: false, doneAt: null })
    expect(updateAuthorTodo(db, a.id, { done: true }, at(2)).doneAt).toBe(at(2).toISOString())
    expect(updateAuthorTodo(db, a.id, { done: false }, at(3)).doneAt).toBeNull()
    expect(reorderAuthorTodos(db, [b.id, a.id]).map((row) => row.id)).toEqual([b.id, a.id])
    expect(() =>
      createAuthorTodo(db, { text: 'x', nodeId: 'missing', recordId: null }, at(4))
    ).toThrow(/no longer exists/)
    deleteRecord(db, mara)
    deleteNode(db, scene)
    expect(listAuthorTodos(db).find((row) => row.id === a.id)).toMatchObject({
      nodeId: null,
      recordId: null
    })
    expect(deleteAuthorTodo(db, b.id).map((row) => [row.id, row.position])).toEqual([[a.id, 0]])
  })
})

describe('sceneDetailStore (F-16.11)', () => {
  it('reads empty details, saves typed ones that point at records, and reports gone ones', () => {
    const mara = record('Mara')
    const tomas = record('Tomas')
    expect(getSceneDetails(db, scene)).toEqual({
      povRecordId: null,
      place: { recordId: null, text: '' },
      time: { text: '' },
      storyYear: null,
      alsoHere: [],
      flashback: null,
      gone: []
    })
    const saved = setSceneDetails(
      db,
      scene,
      {
        povRecordId: mara,
        place: { recordId: null, text: ' the harbour ' },
        time: { text: 'December, evening' },
        storyYear: 1811,
        alsoHere: [tomas, tomas],
        flashback: null
      },
      at(0)
    )
    expect(saved).toMatchObject({
      povRecordId: mara,
      place: { text: 'the harbour' },
      alsoHere: [tomas]
    })
    expect(() => setSceneDetails(db, scene, { ...saved, povRecordId: 'missing' }, at(1))).toThrow(
      /no longer exists/
    )
  })

  it('reads a stored row field by field: one value that does not parse empties only itself', () => {
    const mara = record('Mara')
    setSceneDetails(
      db,
      scene,
      {
        povRecordId: mara,
        place: { recordId: null, text: 'the harbour' },
        time: { text: 'x'.repeat(SCENE_META_TIMELINE_MAX) },
        storyYear: 1811,
        alsoHere: [],
        flashback: null
      },
      at(0)
    )
    db.update(sceneDetail)
      .set({ timeText: 'x'.repeat(SCENE_META_TIMELINE_MAX + 1) })
      .where(eq(sceneDetail.nodeId, scene))
      .run()
    expect(getSceneDetails(db, scene)).toMatchObject({
      povRecordId: mara,
      place: { text: 'the harbour' },
      time: { text: '' },
      storyYear: 1811
    })
  })

  it('keeps the Flashback switch both ways and unset, and lists only the scenes that set it (2026-10-14)', () => {
    const empty = {
      povRecordId: null,
      place: { recordId: null, text: '' },
      time: { text: '' },
      storyYear: 1798,
      alsoHere: []
    }
    expect(typedFlashbacks(db).size).toBe(0)
    expect(setSceneDetails(db, scene, { ...empty, flashback: true }, at(0))).toMatchObject({
      storyYear: 1798,
      flashback: true
    })
    expect([...typedFlashbacks(db)]).toEqual([[scene, true]])
    expect(setSceneDetails(db, scene, { ...empty, flashback: false }, at(1)).flashback).toBe(false)
    expect([...typedFlashbacks(db)]).toEqual([[scene, false]])
    expect(allSceneDetails(db).get(scene)?.flashback).toBe(false)
    // Follow the book: unset, and no longer listed.
    expect(setSceneDetails(db, scene, { ...empty, flashback: null }, at(2)).flashback).toBeNull()
    expect(typedFlashbacks(db).size).toBe(0)
    expect(getSceneDetails(db, scene)).toMatchObject({ storyYear: 1798, flashback: null })
  })

  it('reads every stored node’s details in one query, and no node without any (F-16.23)', () => {
    const mara = record('Mara')
    expect(allSceneDetails(db).size).toBe(0)
    setSceneDetails(
      db,
      scene,
      {
        povRecordId: mara,
        place: { recordId: null, text: '' },
        time: { text: 'dawn' },
        storyYear: 1811,
        alsoHere: [],
        flashback: null
      },
      at(0)
    )
    const all = allSceneDetails(db)
    expect([...all.keys()]).toEqual([scene])
    expect(all.get(scene)).toMatchObject({
      povRecordId: mara,
      storyYear: 1811,
      time: { text: 'dawn' }
    })
  })

  it('refuses a node outside the manuscript, and a section root', () => {
    const root = listNodes(db).find(
      (row) => row.parentId === null && row.sectionType === 'manuscript'
    )
    expect(() => getSceneDetails(db, root?.id ?? '')).toThrow(/manuscript/)
    const notes = listNodes(db).find(
      (row) => row.parentId === null && row.sectionType !== 'manuscript'
    )
    const page = createNode(db, 'novel', {
      parentId: notes?.id ?? '',
      kind: 'document',
      hierarchyLevel: null,
      title: 'Page'
    })
    expect(() => getSceneDetails(db, page.id)).toThrow(/manuscript/)
  })
})
