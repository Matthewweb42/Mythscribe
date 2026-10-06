import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SNAPSHOT_AUTO_KEEP, autoSnapshotName, type SnapshotList } from '@shared/snapshots'
import type { TiptapNodeT } from '@shared/tiptap'
import { node, snapshot, snapshotText, writingLog, type NodeRow } from '../db/schema'
import { getDocumentContent, saveDocument } from '../document/documentStore'
import { listDrafts } from '../draft/draftStore'
import { projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createSeededProject } from '../project/testProject'
import { createNode, deleteNode, getNode, listNodes, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments, projectDocuments } from '../voice/profile'
import {
  compareSnapshot,
  deleteSnapshot,
  listSnapshots,
  restoreSnapshot,
  takeSnapshot,
  updateSnapshot
} from './snapshotStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
/** The manuscript's documents in reading order; the first three hold text. */
let scenes: NodeRow[]
/** A front-matter and an end-matter document, both empty. */
let preface: NodeRow
let afterword: NodeRow

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

const scene = (index: number): NodeRow => {
  const row = scenes[index]
  if (row === undefined) throw new Error(`no scene ${index}`)
  return row
}

const sectionRoot = (type: 'front' | 'end'): NodeRow => {
  const root = listNodes(db).find((row) => row.parentId === null && row.sectionType === type)
  if (!root) throw new Error(`no ${type} root`)
  return root
}

const contentOf = (id: string): TiptapNodeT | null => getDocumentContent(db, id).content

const only = (list: SnapshotList, name: string): SnapshotList[number] => {
  const found = list.filter((each) => each.name === name)
  if (found.length !== 1 || found[0] === undefined) throw new Error(`no single snapshot ${name}`)
  return found[0]
}

const takeProject = (name: string, milestone = false): SnapshotList =>
  takeSnapshot(db, { scope: 'project', name, note: '', milestone })

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-snapshots-'))
  session = createSeededProject(projectFolderFor(tmp, 'Snapshots'), 'Snapshots', 'novel')
  db = session.connection.orm
  preface = createNode(db, 'novel', {
    parentId: sectionRoot('front').id,
    kind: 'document',
    hierarchyLevel: null,
    title: 'Preface'
  })
  afterword = createNode(db, 'novel', {
    parentId: sectionRoot('end').id,
    kind: 'document',
    hierarchyLevel: null,
    title: 'Afterword'
  })
  scenes = manuscriptDocuments(db)
  saveDocument(db, scene(0).id, doc('The storm broke at dawn.'))
  saveDocument(db, scene(1).id, doc('Mara waited by the gate.'))
  saveDocument(db, scene(2).id, doc('Nothing changed here.'))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('projectDocuments (F-8.6)', () => {
  it('lists every document of all three sections in tree order', () => {
    expect(projectDocuments(db).map((row) => row.id)).toEqual([
      preface.id,
      ...scenes.map((row) => row.id),
      afterword.id
    ])
  })
})

describe('takeSnapshot (F-8.6)', () => {
  it('copies every document of the project with counts, newest first', () => {
    takeProject('First')
    saveDocument(db, scene(0).id, doc('The squall broke.'))
    const list = takeSnapshot(db, {
      scope: 'document',
      nodeId: scene(0).id,
      name: '  Second  ',
      note: ' a note ',
      milestone: true
    })
    expect(list.map((each) => each.name)).toEqual(['Second', 'First'])
    expect(list[1]).toMatchObject({
      kind: 'manual',
      scope: 'project',
      nodeId: null,
      nodeTitle: null,
      draftName: null,
      docCount: scenes.length + 2,
      wordCount: 5 + 5 + 3
    })
    expect(list[0]).toMatchObject({
      note: 'a note',
      kind: 'milestone',
      scope: 'document',
      nodeId: scene(0).id,
      nodeTitle: scene(0).title,
      docCount: 1,
      wordCount: 3
    })
    expect(listSnapshots(db)).toEqual(list)
  })

  it('records the active draft’s name without creating drafts', () => {
    expect(takeProject('No drafts')[0]?.draftName).toBeNull()
    listDrafts(db)
    expect(takeProject('With drafts')[0]?.draftName).toBe('Draft 1')
  })

  it('refuses an unknown document, a folder, and a bad name', () => {
    const take = (nodeId: string, name = 'Snap'): unknown =>
      takeSnapshot(db, { scope: 'document', nodeId, name, note: '', milestone: false })
    expect(() => take('ghost')).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
    expect(() => take(scene(0).parentId ?? '')).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => take(scene(0).id, '   ')).toThrow(expect.objectContaining({ code: 'VALIDATION' }))
    expect(listSnapshots(db)).toEqual([])
  })

  it('drops a deleted document’s text and a document snapshot with its document', () => {
    takeProject('Project')
    takeSnapshot(db, {
      scope: 'document',
      nodeId: scene(1).id,
      name: 'Doc',
      note: '',
      milestone: false
    })
    deleteNode(db, scene(1).id)
    const list = listSnapshots(db)
    expect(list.map((each) => each.name)).toEqual(['Project'])
    expect(list[0]).toMatchObject({ docCount: scenes.length + 1, wordCount: 5 + 3 })
  })
})

describe('updateSnapshot (F-8.6)', () => {
  it('renames, edits the note, and flags or unflags a milestone', () => {
    const id = only(takeProject('Old'), 'Old').id
    let list = updateSnapshot(db, { id, name: 'New', note: 'Why', milestone: true })
    expect(list[0]).toMatchObject({ name: 'New', note: 'Why', kind: 'milestone' })
    list = updateSnapshot(db, { id, milestone: false })
    expect(list[0]).toMatchObject({ name: 'New', note: 'Why', kind: 'manual' })
    expect(() => updateSnapshot(db, { id, name: '' })).toThrow(
      expect.objectContaining({ code: 'VALIDATION' })
    )
    expect(() => updateSnapshot(db, { id: 'ghost', name: 'X' })).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })

  it('keeps an automatic snapshot automatic unless it is flagged', () => {
    const id = only(takeProject('Base'), 'Base').id
    saveDocument(db, scene(0).id, doc('Changed.'))
    const auto = only(restoreSnapshot(db, id).snapshots, autoSnapshotName('Base'))
    expect(updateSnapshot(db, { id: auto.id, name: 'Kept', milestone: false })[0]).toMatchObject({
      name: 'Kept',
      kind: 'auto'
    })
    expect(updateSnapshot(db, { id: auto.id, milestone: true })[0]?.kind).toBe('milestone')
  })
})

describe('deleteSnapshot (F-8.6)', () => {
  it('deletes a snapshot and its texts', () => {
    const id = only(takeProject('Gone'), 'Gone').id
    takeProject('Stays')
    expect(deleteSnapshot(db, id).map((each) => each.name)).toEqual(['Stays'])
    expect(db.select().from(snapshotText).where(eq(snapshotText.snapshotId, id)).all()).toEqual([])
    expect(() => deleteSnapshot(db, id)).toThrow(expect.objectContaining({ code: 'NOT_FOUND' }))
  })
})

describe('compareSnapshot (F-8.6)', () => {
  it('compares with the current text in tree order', () => {
    const id = only(takeProject('Base'), 'Base').id
    saveDocument(db, scene(1).id, doc('Mara waited by the old gate.'))
    saveDocument(db, scene(0).id, doc('The squall broke at dawn.'))
    const result = compareSnapshot(db, id)
    expect(result).toMatchObject({ snapshotId: id, againstId: null, unchanged: scenes.length })
    expect(result.docs.map((each) => each.nodeId)).toEqual([scene(0).id, scene(1).id])
    expect(result.docs[0]?.segments).toEqual([
      { op: 'same', text: 'The ' },
      { op: 'del', text: 'storm' },
      { op: 'add', text: 'squall' },
      { op: 'same', text: ' broke at dawn.' }
    ])
    expect(result.docs[1]).toMatchObject({ wordsAdded: 1, wordsRemoved: 0 })
    expect(result.docs[1]?.path.length).toBeGreaterThan(0)
  })

  it('compares two snapshots; a side without a copy reads the current text', () => {
    const projectId = only(takeProject('Project'), 'Project').id
    saveDocument(db, scene(0).id, doc('The squall broke at dawn.'))
    saveDocument(db, scene(1).id, doc('Mara left.'))
    const docId = only(
      takeSnapshot(db, {
        scope: 'document',
        nodeId: scene(0).id,
        name: 'Doc',
        note: '',
        milestone: false
      }),
      'Doc'
    ).id
    const result = compareSnapshot(db, projectId, docId)
    expect(result.againstId).toBe(docId)
    // Scene 1 from the doc snapshot; scene 2 has no copy there, so it reads current.
    expect(result.docs.map((each) => each.nodeId)).toEqual([scene(0).id, scene(1).id])
    // Only documents in either snapshot take part: the document snapshot alone holds one.
    const reverse = compareSnapshot(db, docId)
    expect(reverse).toMatchObject({ docs: [], unchanged: 1 })
    expect(() => compareSnapshot(db, projectId, 'ghost')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })
})

describe('restoreSnapshot (F-8.6)', () => {
  it('restores the changed documents after keeping them as an automatic snapshot', () => {
    const id = only(takeProject('Base'), 'Base').id
    saveDocument(db, scene(0).id, doc('The squall broke.'))
    saveDocument(db, scene(1).id, doc('Mara left.'))
    saveDocument(db, preface.id, doc('For Ada.'))
    const result = restoreSnapshot(db, id)
    expect(result.changed).toEqual([
      { id: preface.id, wordCount: 0 },
      { id: scene(0).id, wordCount: 5 },
      { id: scene(1).id, wordCount: 5 }
    ])
    expect(contentOf(preface.id)).toBeNull()
    expect(getNode(db, preface.id)?.wordCount).toBe(0)
    expect(contentOf(scene(0).id)).toEqual(doc('The storm broke at dawn.'))
    expect(contentOf(scene(1).id)).toEqual(doc('Mara waited by the gate.'))

    const auto = only(result.snapshots, autoSnapshotName('Base'))
    expect(result.snapshots[0]?.id).toBe(auto.id)
    expect(auto).toMatchObject({ kind: 'auto', scope: 'project', nodeId: null, docCount: 3 })
    // The automatic snapshot holds the text that was overwritten.
    expect(compareSnapshot(db, auto.id).docs.map((each) => each.nodeId)).toEqual([
      preface.id,
      scene(0).id,
      scene(1).id
    ])
    expect(db.select().from(writingLog).all()).toEqual([])
  })

  it('restores only the listed documents, as a document-scoped automatic snapshot', () => {
    const id = only(takeProject('Base'), 'Base').id
    saveDocument(db, scene(0).id, doc('The squall broke.'))
    saveDocument(db, scene(1).id, doc('Mara left.'))
    const result = restoreSnapshot(db, id, [scene(1).id, 'ghost'])
    expect(result.changed).toEqual([{ id: scene(1).id, wordCount: 5 }])
    expect(contentOf(scene(0).id)).toEqual(doc('The squall broke.'))
    expect(only(result.snapshots, autoSnapshotName('Base'))).toMatchObject({
      scope: 'document',
      nodeId: scene(1).id,
      nodeTitle: scene(1).title,
      docCount: 1,
      wordCount: 2
    })
  })

  it('takes nothing when nothing differs', () => {
    const id = only(takeProject('Base'), 'Base').id
    const result = restoreSnapshot(db, id)
    expect(result).toEqual({ snapshots: listSnapshots(db), changed: [] })
    expect(result.snapshots).toHaveLength(1)
    expect(() => restoreSnapshot(db, 'ghost')).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND' })
    )
  })

  it(`keeps the newest ${SNAPSHOT_AUTO_KEEP} automatic snapshots and every other kind`, () => {
    const id = only(takeProject('Base', true), 'Base').id
    takeProject('Manual')
    for (let i = 0; i <= SNAPSHOT_AUTO_KEEP; i++) {
      saveDocument(db, scene(0).id, doc(`Edit ${i}.`))
      restoreSnapshot(db, id, [scene(0).id])
    }
    const autos = db.select().from(snapshot).where(eq(snapshot.kind, 'auto')).all()
    expect(autos).toHaveLength(SNAPSHOT_AUTO_KEEP)
    const kept = new Set(
      autos.flatMap((row) =>
        db
          .select()
          .from(snapshotText)
          .where(eq(snapshotText.snapshotId, row.id))
          .all()
          .map((text) => text.content)
      )
    )
    // The oldest automatic snapshot ("Edit 0.") was pruned; the newest is kept.
    expect(kept.has(JSON.stringify(doc('Edit 0.')))).toBe(false)
    expect(kept.has(JSON.stringify(doc(`Edit ${SNAPSHOT_AUTO_KEEP}.`)))).toBe(true)
    const names = listSnapshots(db).map((each) => each.name)
    expect(names).toContain('Base')
    expect(names).toContain('Manual')
    expect(
      db
        .select()
        .from(node)
        .where(eq(node.id, scene(0).id))
        .get()?.wordCount
    ).toBe(5)
  })
})
