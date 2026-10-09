import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TiptapNodeT } from '@shared/tiptap'
import { insertFindings } from '../ai/continuityFindingStore'
import { node, todoItem } from '../db/schema'
import { saveDocument } from '../document/documentStore'
import { saveNotes } from '../document/notesStore'
import { setSceneMeta } from '../document/sceneMetaStore'
import { createEntity, deleteEntity, listEntities, updateEntity } from '../entity/entityStore'
import { getDismissedNames } from '../project/settingsStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { listProposedTags, resetProposedTagCache } from '../tag/proposedTags'
import { scanMentions } from '../tag/scanMentions'
import { deleteNode, listNodes, type TreeDb } from '../tree/treeStore'
import { applyDerivedKnowledge } from './derive'
import { listTodo, reopenTodo, settleTodo, syncLocalTodo } from './todoStore'

const FILLER =
  ' The rain kept on through the evening, and the lamps along the quay burned low while the ' +
  'boats knocked against the posts and nobody on the landing said a word about the weather, ' +
  'not the ferryman, not the girl with the lantern, and not the old man who sold the tickets.'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

let tmp: string
let session: ProjectSession
let db: TreeDb
let first: string

function addScene(id: string, text: string, offset: number): string {
  const seeded = listNodes(db).find((row) => row.id === first)
  if (!seeded) throw new Error('no seeded scene')
  const now = new Date().toISOString()
  db.insert(node)
    .values({
      id,
      parentId: seeded.parentId,
      kind: 'document',
      hierarchyLevel: 'scene',
      title: id,
      position: seeded.position + offset,
      created: now,
      modified: now
    })
    .run()
  write(id, text)
  return id
}

function write(id: string, text: string): void {
  saveDocument(db, id, doc(text))
  scanMentions(db, id, new Date())
}

const contents = (): unknown[] =>
  db
    .select({ id: node.id, content: node.content })
    .from(node)
    .all()
    .map((row) => [row.id, row.content])

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-todo-'))
  session = createProject(projectFolderFor(tmp, 'Todo'), 'Todo', 'novel')
  db = session.connection.orm
  resetProposedTagCache()
  first =
    listNodes(db).find((row) => row.kind === 'document' && row.hierarchyLevel === 'scene')?.id ?? ''
})
afterEach(() => {
  session.connection.close()
  resetProposedTagCache()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('the local To do list (F-9.16)', () => {
  it('lists a record two scenes name that nothing explains, with its sentence and target', () => {
    const hollowing = createEntity(db, { kind: 'world', name: 'Hollowing' }).entity
    write(first, `Mara reached the Hollowing at dusk.${FILLER}`)
    addScene('s2', `Nobody went into the Hollowing after dark.${FILLER}`, 1)
    const before = contents()

    expect(syncLocalTodo(db).changed).toBe(true)
    const view = listTodo(db)
    expect(view.items).toMatchObject([
      {
        kind: 'undefined',
        rule: 'emptyRecord',
        subject: 'Hollowing',
        entityId: hollowing.id,
        nodeId: first,
        quote: 'Mara reached the Hollowing at dusk.',
        target: { kind: 'field', entityId: hollowing.id, field: 'description' },
        targetLabel: 'Hollowing › Description',
        status: 'open'
      }
    ])
    expect(view.counts).toEqual({ undefined: 1, contradiction: 0, looseEnd: 0, gap: 0 })
    // Nothing the sync does writes a scene: every document is byte-identical.
    expect(contents()).toEqual(before)
    // An unchanged book writes nothing.
    expect(syncLocalTodo(db).changed).toBe(false)

    // The author explains it: the open item goes.
    updateEntity(db, hollowing.id, { fields: { description: 'A sunken quarter.' } })
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
  })

  it('skips a record the notes explain, and one only one scene names', () => {
    createEntity(db, { kind: 'world', name: 'Hollowing' })
    write(first, `Mara reached the Hollowing at dusk.${FILLER}`)
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
    addScene('s2', `Nobody went into the Hollowing after dark.${FILLER}`, 1)
    saveNotes(db, 's2', doc('The hollowing is the drowned quarter.'))
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
  })

  it('never brings back a dismissed or done item, and Undo reopens it', () => {
    createEntity(db, { kind: 'world', name: 'Hollowing' })
    write(first, `Mara reached the Hollowing at dusk.${FILLER}`)
    addScene('s2', `Nobody went into the Hollowing after dark.${FILLER}`, 1)
    syncLocalTodo(db)
    const [item] = listTodo(db).items
    settleTodo(db, item?.id ?? '', 'dismissed')
    write('s2', `Nobody went into the Hollowing, not even at noon.${FILLER}`)
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
    expect(() => settleTodo(db, item?.id ?? '', 'done')).toThrowError(/gone/)

    reopenTodo(db, item?.id ?? '')
    expect(listTodo(db).items.map((each) => each.id)).toEqual([item?.id])
    settleTodo(db, item?.id ?? '', 'done')
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
    expect(
      db
        .select()
        .from(todoItem)
        .all()
        .map((row) => row.status)
    ).toEqual(['done'])
  })

  it('drops the open items of a deleted record', () => {
    const hollowing = createEntity(db, { kind: 'world', name: 'Hollowing' }).entity
    write(first, `Mara reached the Hollowing at dusk.${FILLER}`)
    addScene('s2', `Nobody went into the Hollowing after dark.${FILLER}`, 1)
    syncLocalTodo(db)
    expect(listTodo(db).items).toHaveLength(1)
    deleteEntity(db, hollowing.id)
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
    expect(db.select().from(todoItem).all()).toEqual([])
  })

  it('lists an untagged name, and its Dismiss is the Tags panel’s too', () => {
    write(first, `But Tash saw Tash, then Tash.${FILLER}`)
    syncLocalTodo(db)
    const [item] = listTodo(db).items
    expect(item).toMatchObject({
      rule: 'unknownName',
      subject: 'Tash',
      quote: 'But Tash saw Tash, then Tash.',
      target: { kind: 'newRecord', category: 'character', name: 'Tash' },
      targetLabel: 'New character: Tash'
    })
    expect(settleTodo(db, item?.id ?? '', 'dismissed').namesChanged).toBe(true)
    expect(getDismissedNames(db).names).toEqual(['tash'])
    expect(listProposedTags(db)).toEqual([])
    expect(reopenTodo(db, item?.id ?? '').namesChanged).toBe(true)
    expect(getDismissedNames(db).names).toEqual([])
  })

  it('flags a point-of-view character with no stated goal', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara' }).entity
    write(first, `The tide turned.${FILLER}`)
    addScene('s2', `The bell rang twice.${FILLER}`, 1)
    setSceneMeta(db, first, { location: '', pov: 'Mara', timeline: '' })
    syncLocalTodo(db)
    expect(listTodo(db).items.filter((each) => each.rule === 'noGoal')).toEqual([])
    setSceneMeta(db, 's2', { location: '', pov: 'mara', timeline: '' })
    syncLocalTodo(db)
    expect(listTodo(db).items.filter((each) => each.rule === 'noGoal')).toMatchObject([
      {
        kind: 'gap',
        subject: 'Mara',
        nodeId: first,
        quote: null,
        target: { kind: 'field', entityId: mara.id, field: 'goals' },
        targetLabel: 'Mara › Goals / motivations'
      }
    ])
    // An idea scene does not count.
    setSceneMeta(db, 's2', { location: '', pov: 'Mara', timeline: '', status: 'idea' })
    syncLocalTodo(db)
    expect(listTodo(db).items.filter((each) => each.rule === 'noGoal')).toEqual([])
  })

  it('lists two ages one scene states, with both values as the options', () => {
    const text = `Mara was thirty that spring. Mara was thirty-four, said the clerk.${FILLER}`
    write(first, text)
    applyDerivedKnowledge(db, {
      nodeId: first,
      facts: [
        {
          entity: 'Mara',
          kind: 'character',
          attribute: 'age',
          value: '30',
          quote: 'Mara was thirty'
        },
        {
          entity: 'Mara',
          kind: 'character',
          attribute: 'age',
          value: '34',
          quote: 'Mara was thirty-four'
        }
      ],
      tags: [],
      sceneText: text,
      now: new Date().toISOString()
    })
    syncLocalTodo(db)
    expect(listTodo(db).items.filter((each) => each.rule === 'factConflict')).toMatchObject([
      {
        kind: 'contradiction',
        subject: 'Mara · Age',
        nodeId: first,
        quote: 'Mara was thirty-four',
        target: { kind: 'field', field: 'age' },
        suggestions: ['30', '34'],
        suggested: true
      }
    ])
  })

  it('lists the open findings of the consistency checker live, and settles them there', () => {
    const mara = createEntity(db, { kind: 'character', name: 'Mara', fields: { age: '31' } }).entity
    const [finding] = insertFindings(
      db,
      first,
      [
        {
          ref: {
            kind: 'sheet',
            entityId: mara.id,
            entityName: 'Mara',
            entityKind: 'character',
            attribute: 'age',
            label: 'Age',
            value: '31',
            nodeId: null,
            quote: null
          },
          quote: 'Mara, barely twenty',
          why: 'The sheet says 31.',
          fix: null,
          flagged: false,
          violation: null
        }
      ],
      { origin: 'background', proposalId: null, createdAt: new Date().toISOString() }
    )
    const id = `c:${finding?.id ?? ''}`
    expect(listTodo(db).items).toMatchObject([
      {
        id,
        kind: 'contradiction',
        rule: 'continuity',
        subject: 'Mara',
        quote: 'Mara, barely twenty',
        target: { kind: 'field', entityId: mara.id, field: 'age' },
        suggested: true
      }
    ])
    // Never copied into the To do table.
    syncLocalTodo(db)
    expect(db.select().from(todoItem).all()).toEqual([])
    expect(settleTodo(db, id, 'done').continuityNodeId).toBe(first)
    expect(listTodo(db).items).toEqual([])
    expect(() => reopenTodo(db, id)).toThrowError(/cannot be reopened/)
  })

  it('drops an open AI item whose scene was deleted, and keeps a settled one', () => {
    addScene('s2', `The bell rang twice.${FILLER}`, 1)
    const now = new Date().toISOString()
    const row = {
      kind: 'gap' as const,
      rule: 'timeline' as const,
      source: 'ai' as const,
      subject: 'The crossing',
      entityId: null,
      nodeId: 's2',
      quote: null,
      why: 'Three days pass with no word of when.',
      target: JSON.stringify({ kind: 'notes', nodeId: 's2' }),
      createdAt: now,
      updatedAt: now
    }
    db.insert(todoItem)
      .values([
        { ...row, id: 'open', key: 'timeline:the crossing' },
        { ...row, id: 'kept', key: 'timeline:the bridge', status: 'dismissed' }
      ])
      .run()
    syncLocalTodo(db)
    expect(listTodo(db).items.map((each) => each.id)).toEqual(['open'])
    deleteNode(db, 's2')
    syncLocalTodo(db)
    expect(listTodo(db).items).toEqual([])
    expect(
      db
        .select({ id: todoItem.id, nodeId: todoItem.nodeId })
        .from(todoItem)
        .where(eq(todoItem.id, 'kept'))
        .all()
    ).toEqual([{ id: 'kept', nodeId: null }])
  })
})

describe('the local caps count open items only (F-9.16, verifier)', () => {
  it('shows the next item of a rule once its first 20 are settled', () => {
    const names = Array.from({ length: 21 }, (_, at) => `Zan${String.fromCharCode(97 + at)}ork`)
    for (const name of names) createEntity(db, { kind: 'world', name })
    const line = `${names.join(' and ')} were all there.${FILLER}`
    write(first, line)
    addScene('s2', line, 1)
    syncLocalTodo(db)
    const open = listTodo(db).items.filter((item) => item.rule === 'emptyRecord')
    expect(open).toHaveLength(20)
    for (const item of open) settleTodo(db, item.id, 'dismissed')
    syncLocalTodo(db)
    // Plan: "20 open items per rule". The 21st record is just as empty and named in two scenes.
    expect(listTodo(db).items.filter((item) => item.rule === 'emptyRecord')).toHaveLength(1)
  })
})

describe('a fact conflict the consistency checker already had (F-9.16, verifier)', () => {
  it('does not come back as a new item once the author dismisses the finding', () => {
    const text = `Mara was thirty that spring. Mara was thirty-four, said the clerk.${FILLER}`
    write(first, text)
    applyDerivedKnowledge(db, {
      nodeId: first,
      facts: [
        {
          entity: 'Mara',
          kind: 'character',
          attribute: 'age',
          value: '30',
          quote: 'Mara was thirty'
        },
        {
          entity: 'Mara',
          kind: 'character',
          attribute: 'age',
          value: '34',
          quote: 'Mara was thirty-four'
        }
      ],
      tags: [],
      sceneText: text,
      now: new Date().toISOString()
    })
    const mara = listEntities(db).find((entity) => entity.name === 'Mara')
    const [finding] = insertFindings(
      db,
      first,
      [
        {
          ref: {
            kind: 'sheet',
            entityId: mara?.id ?? '',
            entityName: 'Mara',
            entityKind: 'character',
            attribute: 'age',
            label: 'Age',
            value: '30',
            nodeId: null,
            quote: null
          },
          quote: 'Mara was thirty-four',
          why: 'Two ages in one scene.',
          fix: null,
          flagged: false,
          violation: null
        }
      ],
      { origin: 'background', proposalId: null, createdAt: new Date().toISOString() }
    )
    syncLocalTodo(db)
    // The open finding stands for the conflict: no local duplicate.
    expect(listTodo(db).items.map((each) => each.rule)).toEqual(['continuity'])
    settleTodo(db, `c:${finding?.id ?? ''}`, 'dismissed')
    syncLocalTodo(db)
    // "Not a problem" holds: the same entity, field, and scene must not return as a new item.
    expect(listTodo(db).items.filter((each) => each.rule === 'factConflict')).toEqual([])
  })
})
