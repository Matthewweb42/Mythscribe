import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isDeletion, isOpenAction, type AgentEdit } from '@shared/agent'
import { node, todoItem } from '../db/schema'
import { createEntity } from '../entity/entityStore'
import {
  addAuthorStatement,
  listFactsForEntity,
  setFactStatus,
  writeAuthorFact
} from '../entity/factStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { loadAgentProject, resolveAgentEdit, runAgentTool, type AgentProject } from './agentTools'

/**
 * F-5.25 (agent.v8, the audit's fixes 5, 7, and 8): a document's notes cleared, statuses set,
 * To do items settled by the refs the `todo` tool prints, and the answer actions.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb
let scene: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-v8-'))
  session = createProject(projectFolderFor(tmp, 'V8'), 'V8', 'novel')
  db = session.connection.orm
  const row = listNodes(db).find((each) => each.kind === 'document' && each.sectionType === null)
  if (row === undefined) throw new Error('skeleton not seeded')
  scene = row.id
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const ref = (project: AgentProject): string => project.refOf.get(scene) ?? ''

function resolved(project: AgentProject, raw: Record<string, unknown>): AgentEdit {
  const out = resolveAgentEdit(project, raw)
  if ('error' in out) throw new Error(out.error)
  return out.edit
}

const errorOf = (project: AgentProject, raw: Record<string, unknown>): string => {
  const out = resolveAgentEdit(project, raw)
  return 'error' in out ? out.error : 'resolved'
}

const doc = (text: string): string =>
  JSON.stringify({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
  })

describe('notes cleared (fix 5)', () => {
  it('reads "text":"" as a clear of the notes, a deletion; refuses empty notes', () => {
    let project = loadAgentProject(db)
    expect(errorOf(project, { edit: 'notes', id: ref(project), text: '' })).toBe(
      'the notes are empty'
    )
    db.update(node)
      .set({ notes: doc('Pell lies here.') })
      .where(eq(node.id, scene))
      .run()
    project = loadAgentProject(db)
    const edit = resolved(project, { edit: 'notes', id: ref(project), text: '' })
    expect(edit).toMatchObject({ kind: 'notesClear', nodeId: scene })
    expect(isDeletion(edit)).toBe(true)
    expect(errorOf(project, { edit: 'notes', id: ref(project) })).toBe('no "text"')
  })
})

describe('statuses (fix 7)', () => {
  it('marks a record, naming its status before; no change is refused', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara Vell' }).entity
    const project = loadAgentProject(db)
    expect(resolved(project, { edit: 'status', name: 'Mara', status: 'Idea' })).toEqual({
      kind: 'status',
      target: 'record',
      id: mara.id,
      name: 'Mara Vell',
      label: '',
      status: 'idea',
      items: [{ id: mara.id, before: 'canon' }]
    })
    expect(errorOf(project, { edit: 'status', name: 'Mara', status: 'canon' })).toBe('no change')
    expect(errorOf(project, { edit: 'status', name: 'Mara', status: 'maybe' })).toBe(
      'status must be canon, plan, or idea'
    )
    expect(errorOf(project, { edit: 'status', name: 'Nobody', status: 'plan' })).toBe(
      'no record called "Nobody"'
    )
  })

  it('marks what is stated of a field (by id or label, narrowed by value), and a relationship type', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara Vell' }).entity
    const tomas = createEntity(db, { kind: 'character', name: 'Tomas' }).entity
    writeAuthorFact(db, mara.id, 'age', '19', scene)
    addAuthorStatement(db, {
      entityId: mara.id,
      attribute: 'relation:enemy',
      value: '',
      objectEntityId: tomas.id,
      nodeId: null
    })
    const facts = listFactsForEntity(db, mara.id)
    const age = facts.find((f) => f.attribute === 'age')
    const enemy = facts.find((f) => f.attribute === 'relation:enemy')
    if (age === undefined || enemy === undefined) throw new Error('facts not written')
    const project = loadAgentProject(db)
    expect(
      resolved(project, { edit: 'status', name: 'Mara Vell', field: 'Age', status: 'plan' })
    ).toEqual({
      kind: 'status',
      target: 'facts',
      id: mara.id,
      name: 'Mara Vell',
      label: 'Age',
      status: 'plan',
      items: [{ id: age.id, before: 'canon' }]
    })
    expect(
      errorOf(project, {
        edit: 'status',
        name: 'Mara Vell',
        field: 'age',
        value: '21',
        status: 'plan'
      })
    ).toBe("nothing stated of Mara Vell's age would change")
    expect(
      resolved(project, { edit: 'status', name: 'Mara Vell', field: 'enemy', status: 'idea' })
    ).toMatchObject({ target: 'facts', items: [{ id: enemy.id, before: 'canon' }] })
    setFactStatus(db, age.id, 'plan')
    expect(
      errorOf(loadAgentProject(db), {
        edit: 'status',
        name: 'Mara Vell',
        field: 'age',
        status: 'plan'
      })
    ).toBe("nothing stated of Mara Vell's age would change")
  })

  it('marks a document’s notes, plan by default', () => {
    const project = loadAgentProject(db)
    expect(resolved(project, { edit: 'status', id: ref(project), status: 'canon' })).toEqual({
      kind: 'status',
      target: 'notes',
      id: scene,
      name: expect.any(String) as string,
      label: '',
      status: 'canon',
      items: [{ id: scene, before: 'plan' }]
    })
    expect(errorOf(project, { edit: 'status', id: ref(project), status: 'plan' })).toBe('no change')
  })
})

describe('To do items settled (fix 5)', () => {
  const add = (id: string, kind: 'gap' | 'looseEnd'): void => {
    const at = '2026-10-10T10:00:00.000Z'
    db.insert(todoItem)
      .values({
        id,
        key: `question:${id}`,
        kind,
        rule: kind === 'gap' ? 'timeline' : 'question',
        source: 'ai',
        subject: `Item ${id}`,
        nodeId: null,
        why: `Why ${id}.`,
        target: '{"kind":"none"}',
        createdAt: at,
        updatedAt: at
      })
      .run()
  }

  it('names the items by the refs the todo tool printed; done false dismisses', () => {
    add('g1', 'gap')
    add('l1', 'looseEnd')
    const project = loadAgentProject(db)
    const listed = runAgentTool(project, null, 'todo', { kind: 'gap' }).result
    // The refs count across the whole list, so a filtered call keeps them.
    expect(listed).toBe('Open To do items:\nt2 [Gap] Item g1: Why g1.')
    expect(resolved(project, { edit: 'todo', ids: ['t2', 'T1', 't2'], done: true })).toEqual({
      kind: 'todo',
      items: [
        { id: 'g1', subject: 'Item g1' },
        { id: 'l1', subject: 'Item l1' }
      ],
      status: 'done'
    })
    expect(resolved(project, { edit: 'todo', ids: '1', done: false })).toMatchObject({
      status: 'dismissed',
      items: [{ id: 'l1' }]
    })
    expect(errorOf(project, { edit: 'todo', ids: ['t9'] })).toBe('t9 is not an open To do item')
  })
})

describe('answer actions (fix 8)', () => {
  it('resolves undo, summaries, and open; only open runs at once, only undo asks', () => {
    const project = loadAgentProject(db)
    const undo = resolved(project, { edit: 'undo' })
    expect(undo).toEqual({ kind: 'undoTurn' })
    expect(isDeletion(undo)).toBe(true)
    expect(resolved(project, { edit: 'summaries' })).toEqual({ kind: 'summaries' })
    const open = resolved(project, { edit: 'open', dialog: 'Library' })
    expect(open).toEqual({ kind: 'open', dialog: 'library' })
    expect(isOpenAction(open)).toBe(true)
    expect(isDeletion(open)).toBe(false)
    expect(errorOf(project, { edit: 'open', dialog: 'settings' })).toBe(
      'dialog is upload or library'
    )
  })
})
