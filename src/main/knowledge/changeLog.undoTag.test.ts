import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag, listDocumentTags } from '../tag/documentTagStore'
import { listTags, updateTag } from '../tag/tagStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { listChanges, undoChange, undoRun } from './changeLog'
import { applyDerivedKnowledge } from './derive'

/**
 * Verifier (F-9.13): "refused when the author edited since" holds for a sheet (`deleteRecord`
 * checks `origin`). A tag the AI made and the author then took over (recoloured, so its origin
 * is `author`) and put on another scene by hand must not be deleted by an Undo from the log,
 * taking the author's own links with it.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

const TEXT = 'The stormbound ferry waited off Greywater, and the storm broke over Greywater.'
const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-undotag-'))
  session = createProject(projectFolderFor(tmp, 'UndoTag'), 'UndoTag', 'novel')
  db = session.connection.orm
  scene = listNodes(db).find((row) => row.kind === 'document' && row.sectionType === null)?.id ?? ''
  if (!scene) throw new Error('skeleton not seeded')
  saveDocument(db, scene, doc(TEXT))
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('undo of an AI-made tag the author has taken over (verifier)', () => {
  it('refuses, or at least keeps the tag and the author’s own link on another scene', () => {
    applyDerivedKnowledge(db, {
      nodeId: scene,
      facts: [],
      tags: [{ name: 'Greywater', category: 'setting' }],
      sceneText: TEXT,
      now: new Date().toISOString()
    })
    const made = listTags(db).find((each) => each.name === 'greywater')
    if (made === undefined) throw new Error('the reading made no tag')
    const tagRow = listChanges(db, { limit: 50 }).entries.find((e) => e.kind === 'tag')
    if (tagRow === undefined) throw new Error('no tag change logged')

    // The author takes the tag over: recolours it and tags another scene with it by hand.
    updateTag(db, made.id, { color: '#336699' })
    const parent = listNodes(db).find((row) => row.id === scene)?.parentId
    if (parent == null) throw new Error('scene has no parent')
    const other = createNode(db, 'novel', {
      parentId: parent,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Harbour'
    })
    addDocumentTag(db, other.id, made.id)

    let refused = false
    try {
      undoChange(db, tagRow.id)
    } catch {
      refused = true
    }
    // Either the undo is refused (as for a sheet the author edited), or it leaves the author's
    // tag and link alone. Today it deletes both.
    expect(refused || listTags(db).some((each) => each.id === made.id)).toBe(true)
    expect(listDocumentTags(db, other.id).map((link) => link.id)).toContain(made.id)
  })

  it('refuses the whole run when only the author has linked the AI tag by hand', () => {
    applyDerivedKnowledge(db, {
      nodeId: scene,
      facts: [],
      tags: [{ name: 'Greywater', category: 'setting' }],
      sceneText: TEXT,
      now: new Date().toISOString()
    })
    const made = listTags(db).find((each) => each.name === 'greywater')
    if (made === undefined) throw new Error('the reading made no tag')
    const tagRow = listChanges(db, { limit: 50 }).entries.find((e) => e.kind === 'tag')
    if (tagRow === undefined) throw new Error('no tag change logged')
    const parent = listNodes(db).find((row) => row.id === scene)?.parentId
    if (parent == null) throw new Error('scene has no parent')
    const other = createNode(db, 'novel', {
      parentId: parent,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Harbour'
    })
    addDocumentTag(db, other.id, made.id)

    expect(() => undoRun(db, tagRow.runId)).toThrow(/yours now/)
    // Nothing of the run was taken back: the tag, both links, and the log rows stay.
    expect(listTags(db).some((each) => each.id === made.id)).toBe(true)
    expect(listDocumentTags(db, scene).map((link) => link.id)).toContain(made.id)
    expect(listDocumentTags(db, other.id).map((link) => link.id)).toContain(made.id)
    expect(
      listChanges(db, { limit: 50 })
        .entries.filter((e) => e.runId === tagRow.runId)
        .map((e) => e.status)
    ).not.toContain('undone')
  })

  it('still deletes an untouched AI tag', () => {
    applyDerivedKnowledge(db, {
      nodeId: scene,
      facts: [],
      tags: [{ name: 'Greywater', category: 'setting' }],
      sceneText: TEXT,
      now: new Date().toISOString()
    })
    const made = listTags(db).find((each) => each.name === 'greywater')
    const tagRow = listChanges(db, { limit: 50 }).entries.find((e) => e.kind === 'tag')
    if (made === undefined || tagRow === undefined) throw new Error('the reading made no tag')
    const result = undoRun(db, tagRow.runId)
    expect(result.removedTagIds).toContain(made.id)
    expect(listTags(db).some((each) => each.id === made.id)).toBe(false)
  })
})
