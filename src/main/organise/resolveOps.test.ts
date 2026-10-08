import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createEntity, getEntity, updateEntity } from '../entity/entityStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { loadOrganiseProject } from './organiseProject'
import { OrganiseResolver } from './resolveOps'

let tmp: string
let session: ProjectSession
let db: TreeDb

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-resolve-'))
  session = createProject(projectFolderFor(tmp, 'Res'), 'Res', 'novel')
  db = session.connection.orm
})
afterEach(() => {
  session.close()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('OrganiseResolver binder ops (F-9.10)', () => {
  it('does not plan deleting a folder that an earlier change of the plan fills', () => {
    const nodes = listNodes(db)
    const scene = nodes.find((n) => n.kind === 'document' && n.parentId !== null)
    const chapter = nodes.find((n) => n.id === scene?.parentId)
    if (scene === undefined || chapter?.parentId == null) throw new Error('starter project changed')
    const spare = createNode(db, 'novel', {
      parentId: chapter.parentId,
      kind: 'folder',
      hierarchyLevel: chapter.hierarchyLevel,
      title: 'Spare'
    })
    const project = loadOrganiseProject(db)
    const ref = (id: string): string => project.agent.refOf.get(id) ?? ''
    const resolver = new OrganiseResolver(project)
    resolver.add([
      { op: 'move', id: ref(scene.id), in: ref(spare.id), after: '' },
      { op: 'delete', id: ref(spare.id) }
    ])
    // Applying both would delete the moved scene with its text (`tree:delete` takes the subtree).
    const kinds = resolver.changes.map((c) =>
      c.action.kind === 'binder' ? c.action.edit.kind : c.action.kind
    )
    expect(kinds).toEqual(['move'])
    expect(resolver.skipped).toHaveLength(1)
  })
})

describe('OrganiseResolver sheet moves (F-9.10)', () => {
  it('records what Undo needs to move a sheet back with every value and field as it was', () => {
    const { entity } = createEntity(db, {
      kind: 'character',
      name: 'Rynna',
      fields: { age: '19', notes: 'Quiet.' }
    })
    const project = loadOrganiseProject(db)
    const ref = project.sheetRef.get(entity.id) ?? ''
    const resolver = new OrganiseResolver(project)
    resolver.add([{ op: 'sheet', sheet: ref, category: 'Places', add: { notes: 'A river town.' } }])
    const action = resolver.changes[0]?.action
    if (action?.kind !== 'sheet') throw new Error(`not planned: ${resolver.skipped.join('; ')}`)
    updateEntity(db, entity.id, action.patch)
    expect(getEntity(db, entity.id)?.kind).toBe('setting')
    updateEntity(db, entity.id, action.before)
    const back = getEntity(db, entity.id)
    expect(back?.kind).toBe('character')
    expect(back?.fields).toEqual(entity.fields)
  })
})
