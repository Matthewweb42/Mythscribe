import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, getNode, type TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { listDismissed } from './dismissedStore'
import { answerQuestion, listNameQuestions, resetNameQuestionCache } from './questions'
import { createRecord, listRecords, requireRecord } from './recordStore'

let tmp: string
let session: ProjectSession
let db: TreeDb
let scenes: string[]

const NOW = new Date(Date.UTC(2026, 9, 11, 12, 0, 0))

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

beforeEach(() => {
  resetNameQuestionCache()
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-questions-'))
  session = createProject(projectFolderFor(tmp, 'Questions'), 'Questions', 'novel')
  db = session.connection.orm
  const first = manuscriptDocuments(db)[0]?.id ?? ''
  const second = createNode(db, 'novel', {
    parentId: getNode(db, first)?.parentId ?? '',
    kind: 'document',
    hierarchyLevel: 'scene',
    title: 'Two'
  }).id
  scenes = [first, second]
  const made = createRecord(db, { name: 'Rynna Falsire', categoryId: 'character' }, NOW)
  if (!('record' in made)) throw new Error('blocked')
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const rynna = (): string => listRecords(db)[0]?.id ?? ''

describe('name questions (F-16.4)', () => {
  it('asks about a new name and a nickname, and answers each way', () => {
    saveDocument(db, scenes[0] ?? '', doc('They met Hesk at noon, and Ry laughed at Hesk.'))
    saveDocument(db, scenes[1] ?? '', doc('Later Hesk left, and Ry followed.'))
    const questions = listNameQuestions(db)
    expect(questions.map((q) => [q.kind, q.name, q.nodeIds.length, q.recordId])).toEqual([
      ['newName', 'Hesk', 2, null],
      ['nickname', 'Ry', 2, rynna()]
    ])

    const yes = answerQuestion(db, { kind: 'yes', name: 'Ry', recordId: rynna() }, NOW)
    expect(yes.kind).toBe('record')
    expect(requireRecord(db, rynna()).aliases.map((a) => [a.text, a.origin])).toContainEqual([
      'Ry',
      'confirmed'
    ])
    const added = answerQuestion(db, { kind: 'addAs', name: 'Hesk', categoryId: 'setting' }, NOW)
    expect(added).toMatchObject({ kind: 'record', record: { name: 'Hesk', kind: 'place' } })
    expect(listNameQuestions(db)).toEqual([])
  })

  it('never asks again after Not a name or No', () => {
    saveDocument(db, scenes[0] ?? '', doc('They met Hesk and Ry, and Hesk met Ry.'))
    answerQuestion(db, { kind: 'notAName', name: 'Hesk' }, NOW)
    answerQuestion(db, { kind: 'no', name: 'Ry', recordId: rynna() }, NOW)
    expect(listNameQuestions(db)).toEqual([])
    expect(
      listDismissed(db)
        .items.map((row) => row.kind)
        .sort()
    ).toEqual(['alias', 'name'])
  })
})
