import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { saveDocument } from '../document/documentStore'
import { createEntity, getEntity, updateEntity } from '../entity/entityStore'
import { createTag } from '../tag/tagStore'
import { manuscriptDocuments } from '../voice/profile'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { createNode, listNodes, type TreeDb } from '../tree/treeStore'
import { loadOrganiseProject, organiseCandidates } from './organiseProject'
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

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

describe('Not names — remove? (the author’s tag rule, 2026-10-08)', () => {
  const SCENE =
    'Marta found the memorial fragments where the river bent. The custom in Greywater was to ' +
    'leave them be, but Marta had never cared for custom. She wrapped the memorial fragments in ' +
    'oilcloth and set them on the stones. Her trial would come later, said Reed. They spoke of ' +
    'the Trial at supper, of the Trial at dawn, of the Trial and its price; the Trial took one ' +
    'of them every year, and the memorial fragments knew it.'

  it('offers the AI’s ordinary-word tags for removal first, and plans no merge of ordinary words', () => {
    const scene = manuscriptDocuments(db)[0]?.id ?? ''
    saveDocument(db, scene, doc(SCENE))
    const custom = createTag(db, { name: 'custom', category: 'custom' }, 'ai')
    const stones = createTag(db, { name: 'stones', category: 'worldBuilding' }, 'ai')
    const trial = createTag(db, { name: 'trial', category: 'plotThread' }, 'ai')
    const marta = createTag(db, { name: 'marta', category: 'character' }, 'ai')
    const fragments = createTag(db, { name: 'memorial-fragments', category: 'worldBuilding' }, 'ai')
    const river = createTag(db, { name: 'river', category: 'setting' })
    const oilcloth = createTag(db, { name: 'oilcloth', category: 'custom' })
    const project = loadOrganiseProject(db)
    const found = organiseCandidates(project)
    // The Trial is unusual (proposed, F-4.12b), Marta a name, the fragments a coined term; the
    // author's own ordinary words are never offered for removal.
    expect(found.notNames).toEqual([
      { id: custom.id, name: 'custom' },
      { id: stones.id, name: 'stones' }
    ])
    expect(project.ordinaryTagIds.has(trial.id)).toBe(false)
    expect(project.ordinaryTagIds.has(marta.id)).toBe(false)
    expect(project.ordinaryTagIds.has(fragments.id)).toBe(false)
    expect(project.ordinaryTagIds.has(river.id)).toBe(true)

    const ref = (id: string): string => project.tagRef.get(id) ?? ''
    const resolver = new OrganiseResolver(project)
    resolver.addNotNames(found.notNames)
    resolver.add([
      { op: 'mergeTags', keep: ref(custom.id), merge: [ref(stones.id)] },
      { op: 'mergeTags', keep: ref(river.id), merge: [ref(oilcloth.id)] },
      { op: 'mergeTags', keep: ref(marta.id), merge: [ref(trial.id)] }
    ])
    expect(resolver.changes.map((c) => c.action)).toEqual([
      { kind: 'deleteTag', tagId: custom.id, name: 'custom', notName: true },
      { kind: 'deleteTag', tagId: stones.id, name: 'stones', notName: true },
      {
        kind: 'mergeTags',
        target: { id: marta.id, name: 'marta' },
        sources: [{ id: trial.id, name: 'trial' }]
      }
    ])
    expect(resolver.changes[0]?.reason).toContain('ordinary word')
    expect(resolver.skipped).toEqual([
      'mergeTags: #custom is merged or deleted by an earlier change',
      'mergeTags: #river and the tags to merge into it are ordinary words, not names'
    ])
  })
})
