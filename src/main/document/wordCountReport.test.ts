import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import type { NodeRow } from '../db/schema'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { saveDocument } from './documentStore'
import { wordCountReport } from './wordCountReport'

let tmp: string
let session: ProjectSession
let db: TreeDb

const para = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

function first(level: NodeRow['hierarchyLevel']): NodeRow {
  const row = listNodes(db).find((r) => r.hierarchyLevel === level)
  if (!row) throw new Error(`no ${level}`)
  return row
}

function section(type: NodeRow['sectionType']): NodeRow {
  const row = listNodes(db).find((r) => r.sectionType === type)
  if (!row) throw new Error(`no ${type}`)
  return row
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-wordcount-'))
  session = createProject(projectFolderFor(tmp, 'Counts'), 'Counts', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('wordCountReport (F-10.4)', () => {
  it('counts the chapter around a scene and the whole manuscript, leaving matter out', () => {
    const scene1 = first('scene')
    const chapter1 = listNodes(db).find((r) => r.id === scene1.parentId)
    if (chapter1?.hierarchyLevel !== 'chapter') throw new Error('scene outside a chapter')
    saveDocument(db, scene1.id, para('The storm broke.'))
    const scene2 = createNode(db, 'novel', {
      parentId: chapter1.id,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Scene 2'
    })
    saveDocument(db, scene2.id, para('Rain fell'))
    const chapter2 = createNode(db, 'novel', {
      parentId: chapter1.parentId ?? '',
      kind: 'folder',
      hierarchyLevel: 'chapter',
      title: 'Chapter 2'
    })
    const scene3 = createNode(db, 'novel', {
      parentId: chapter2.id,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: 'Scene 3'
    })
    saveDocument(db, scene3.id, para('Then silence.'))
    const dedication = createNode(db, 'novel', {
      parentId: section('front').id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    })
    saveDocument(db, dedication.id, para('For everyone who waited.'))

    const report = wordCountReport(db, scene2.id)
    expect(report.chapter).toEqual({
      id: chapter1.id,
      title: chapter1.title,
      stats: { words: 5, characters: 25, charactersNoSpaces: 22 }
    })
    expect(report.manuscript).toEqual({ words: 7, characters: 38, charactersNoSpaces: 34 })
    expect(wordCountReport(db, chapter2.id).chapter).toEqual({
      id: chapter2.id,
      title: 'Chapter 2',
      stats: { words: 2, characters: 13, charactersNoSpaces: 12 }
    })
  })

  it('answers no chapter for matter, an unknown id, or none, and zeros for an empty chapter', () => {
    const dedication = createNode(db, 'novel', {
      parentId: section('front').id,
      kind: 'document',
      hierarchyLevel: null,
      title: 'Dedication'
    })
    expect(wordCountReport(db, dedication.id).chapter).toBeNull()
    expect(wordCountReport(db, 'nope').chapter).toBeNull()
    expect(wordCountReport(db, null)).toEqual({
      chapter: null,
      manuscript: { words: 0, characters: 0, charactersNoSpaces: 0 }
    })
    expect(wordCountReport(db, first('chapter').id).chapter?.stats).toEqual({
      words: 0,
      characters: 0,
      charactersNoSpaces: 0
    })
  })
})
