import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentEdit } from '@shared/agent'
import { createEntity } from '../entity/entityStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { addDocumentTag } from '../tag/documentTagStore'
import { createTag } from '../tag/tagStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { loadAgentProject, resolveAgentEdit, runAgentTool, type AgentProject } from './agentTools'

/**
 * F-5.25 (agent.v7, the audit's fixes 3, 4, and 6): bulk edits resolve to one change covering
 * many items, the story-bible edits resolve against the project, and list_sheets reads one field
 * across the sheets.
 */

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-bulk-'))
  session = createProject(projectFolderFor(tmp, 'Bulk'), 'Bulk', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const refOf = (project: AgentProject, id: string): string => project.refOf.get(id) ?? ''

/** The resolved edit, or a failure that names the reason. */
function resolved(project: AgentProject, raw: Record<string, unknown>): AgentEdit {
  const out = resolveAgentEdit(project, raw)
  if ('error' in out) throw new Error(out.error)
  return out.edit
}

/** The manuscript's documents and its first chapter, plus a second chapter with two scenes. */
function binder(): { chapter: string; scenes: string[]; other: string; otherScenes: string[] } {
  const rows = listNodes(db)
  const scene = rows.find((row) => row.kind === 'document' && row.sectionType === null)
  if (scene?.parentId == null) throw new Error('skeleton not seeded')
  const chapter = scene.parentId
  const chapterRow = rows.find((row) => row.id === chapter)
  const other = createNode(db, 'novel', {
    parentId: chapterRow?.parentId ?? '',
    kind: 'folder',
    hierarchyLevel: chapterRow?.hierarchyLevel ?? null,
    title: 'Chapter 2'
  }).id
  const sceneIn = (title: string): string =>
    createNode(db, 'novel', {
      parentId: other,
      kind: 'document',
      hierarchyLevel: scene.hierarchyLevel,
      title
    }).id
  const otherScenes = [sceneIn('Scene A'), sceneIn('Scene B')]
  return { chapter, scenes: [scene.id], other, otherScenes }
}

describe('bulk tag and move (F-5.25, fix 3)', () => {
  it('tags every manuscript scene that lacks the tag, as one edit', () => {
    const { scenes, otherScenes } = binder()
    const tag = createTag(db, { name: 'storm', category: 'tone' })
    addDocumentTag(db, scenes[0]!, tag.id)
    const edit = resolved(loadAgentProject(db), { edit: 'tag', ids: 'all', tag: 'storm' })
    expect(edit).toMatchObject({ kind: 'tagMany', tag: 'storm', add: true })
    if (edit.kind !== 'tagMany') throw new Error('not tagMany')
    expect(edit.nodes.map((n) => n.nodeId).sort()).toEqual([...otherScenes].sort())
  })

  it('takes a tag off the documents under a folder that have it, and refuses when none would change', () => {
    const { other, otherScenes } = binder()
    const tag = createTag(db, { name: 'storm', category: 'tone' })
    addDocumentTag(db, otherScenes[1]!, tag.id)
    const project = loadAgentProject(db)
    const edit = resolved(project, {
      edit: 'tag',
      ids: refOf(project, other),
      tag: 'storm',
      add: false
    })
    if (edit.kind !== 'tagMany') throw new Error('not tagMany')
    expect(edit.nodes.map((n) => n.nodeId)).toEqual([otherScenes[1]])
    expect(
      resolveAgentEdit(project, {
        edit: 'tag',
        ids: [refOf(project, otherScenes[0]!)],
        tag: 'storm',
        add: false
      })
    ).toEqual({ error: 'no document would change' })
  })

  it('moves every child of one folder into another, and never a folder into itself', () => {
    const { chapter, scenes, other, otherScenes } = binder()
    const project = loadAgentProject(db)
    const edit = resolved(project, {
      edit: 'move',
      from: refOf(project, other),
      in: refOf(project, chapter)
    })
    expect(edit).toMatchObject({ kind: 'moveMany', parentId: chapter })
    if (edit.kind !== 'moveMany') throw new Error('not moveMany')
    expect(edit.nodes.map((n) => n.nodeId)).toEqual(otherScenes)
    expect(
      resolveAgentEdit(project, {
        edit: 'move',
        ids: [refOf(project, other)],
        in: refOf(project, other)
      })
    ).toEqual({ error: 'cannot move a folder into itself' })
    // A single move still resolves as before.
    expect(
      resolved(project, {
        edit: 'move',
        id: refOf(project, scenes[0]!),
        in: refOf(project, other),
        after: ''
      })
    ).toMatchObject({ kind: 'move' })
  })
})

describe('story-bible edits (F-5.25, fix 4)', () => {
  it('renames a tag, refusing a name another tag has', () => {
    createTag(db, { name: 'storm', category: 'tone' })
    createTag(db, { name: 'gale', category: 'tone' })
    const project = loadAgentProject(db)
    expect(resolved(project, { edit: 'rename_tag', tag: 'storm', title: 'Tempest' })).toMatchObject(
      {
        kind: 'tagRename',
        name: 'storm',
        after: 'tempest'
      }
    )
    expect(resolveAgentEdit(project, { edit: 'rename_tag', tag: 'storm', title: 'gale' })).toEqual({
      error: '#gale exists'
    })
  })

  it('renames a sheet and moves a whole category’s sheets into another', () => {
    createEntity(db, { kind: 'character', name: 'Mara' })
    createEntity(db, { kind: 'character', name: 'Tomas' })
    const project = loadAgentProject(db)
    expect(
      resolved(project, { edit: 'rename_sheet', name: 'Mara', title: 'Mara Vell' })
    ).toMatchObject({
      kind: 'sheetPatch',
      rename: 'Mara Vell',
      to: null
    })
    const moved = resolved(project, { edit: 'recategorise', from: 'characters', to: 'world' })
    if (moved.kind !== 'sheetPatch') throw new Error('not sheetPatch')
    expect(moved.to).toBe('world')
    expect(moved.sheets.map((s) => s.name).sort()).toEqual(['Mara', 'Tomas'])
    expect(moved.sheets.every((s) => s.kind === 'character')).toBe(true)
  })

  it('merges sheets (a deletion that asks) and makes a new empty sheet, refusing a taken name', () => {
    createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '19' } })
    createEntity(db, { kind: 'character', name: 'Mara Vell' })
    const project = loadAgentProject(db)
    expect(
      resolved(project, { edit: 'merge_sheets', sheets: ['Mara'], into: 'Mara Vell' })
    ).toMatchObject({
      kind: 'sheetMerge',
      target: { name: 'Mara Vell' },
      sources: [{ name: 'Mara' }],
      withText: true
    })
    expect(
      resolved(project, { edit: 'create_sheet', name: 'Pell', category: 'character' })
    ).toMatchObject({
      kind: 'sheetCreate',
      category: 'character',
      name: 'Pell'
    })
    expect(
      resolveAgentEdit(project, { edit: 'create_sheet', name: 'mara', category: 'characters' })
    ).toEqual({
      error: 'a sheet called "mara" exists'
    })
  })
})

describe('list_sheets with a field (F-5.25, fix 6)', () => {
  it('lists one field across the sheets, or only the sheets where it is blank', () => {
    createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '19' } })
    createEntity(db, { kind: 'character', name: 'Tomas' })
    const project = loadAgentProject(db)
    const all = runAgentTool(project, null, 'list_sheets', { kind: 'character', field: 'Age' })
    expect(all.result).toContain('- Mara: 19')
    expect(all.result).toContain('- Tomas: (empty)')
    const empty = runAgentTool(project, null, 'list_sheets', {
      kind: 'character',
      field: 'age',
      empty: true
    })
    expect(empty.result).toContain('- Tomas: (empty)')
    expect(empty.result).not.toContain('Mara')
    // Without a field, the names as before.
    expect(runAgentTool(project, null, 'list_sheets', { kind: '' }).result).toContain('Mara, Tomas')
  })
})
