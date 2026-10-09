import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_CATEGORIES } from '@shared/categories'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { EMPTY_SCENE_META } from '@shared/sceneMeta'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetNotesStore } from '@renderer/features/editor/notesStore'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import {
  resetEntityDraftStore,
  useEntityDraftStore
} from '@renderer/features/entities/entityDraftStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { todoItem } from './todoFixture'
import { applyPick, withLine } from './todoPick'
import { resetTodoStore, useTodoStore } from './todoStore'

const mara: Entity = {
  id: 'e-mara',
  kind: 'character',
  name: 'Mara',
  template: 'structured',
  fields: { goals: 'Pay the debt', age: '31', gender: 'Woman' },
  body: null,
  image: null,
  tagId: null,
  aliases: [],
  origin: 'author',
  status: 'canon',
  created: '2026-10-09',
  modified: '2026-10-09'
}

let calls: [Channel, unknown][]
let notes: TiptapNodeT | null

beforeEach(() => {
  resetTodoStore()
  resetEntityStore()
  resetCategoryStore()
  resetNotesStore()
  resetSceneMetaStore()
  calls = []
  notes = null
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      switch (channel) {
        case 'entity:get':
          return mara as Output<C>
        case 'entity:update': {
          const patch = input as Input<'entity:update'>
          return { ...mara, ...patch, fields: patch.fields ?? mara.fields } as Output<C>
        }
        case 'entity:create': {
          const created = input as Input<'entity:create'>
          return {
            ...mara,
            id: 'e-new',
            kind: created.kind,
            name: created.name,
            fields: created.fields ?? {}
          } as Output<C>
        }
        case 'notes:get':
          return { id: 'sc-3', notes } as Output<C>
        case 'notes:save':
          notes = (input as Input<'notes:save'>).notes
          return { modified: '2026-10-09' } as Output<C>
        case 'sceneMeta:get':
          return { id: 'sc-3', meta: EMPTY_SCENE_META } as Output<C>
        case 'sceneMeta:set':
          return { id: 'sc-3', meta: EMPTY_SCENE_META } as Output<C>
        case 'todo:settle':
          return null as Output<C>
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  }
  setIpcClient(client)
  useTodoStore.setState({ items: [todoItem('t1')] })
})
afterEach(() => {
  resetTodoStore()
  resetEntityStore()
  resetNotesStore()
  resetSceneMetaStore()
})

const character = BUILTIN_CATEGORIES.find((category) => category.id === 'character')!

describe('withLine', () => {
  it('appends on a new line, after "; " in a one-line field, and replaces a single value', () => {
    expect(withLine('Pay the debt', 'Find her brother', 'goals', character)).toBe(
      'Pay the debt\nFind her brother'
    )
    expect(withLine('Woman', 'trans', 'gender', character)).toBe('Woman; trans')
    expect(withLine('31', '34', 'age', character)).toBe('34')
    expect(withLine('  ', 'Find her brother', 'goals', character)).toBe('Find her brother')
  })
})

describe('applyPick (F-9.16)', () => {
  it('appends the line to a filled sheet field through the entity store, then marks it done', async () => {
    await applyPick(
      todoItem('t1', { target: { kind: 'field', entityId: 'e-mara', field: 'goals' } }),
      '  Find her brother '
    )
    expect(calls).toContainEqual([
      'entity:update',
      { id: 'e-mara', fields: { ...mara.fields, goals: 'Pay the debt\nFind her brother' } }
    ])
    expect(useEntityStore.getState().byId['e-mara']?.fields.goals).toBe(
      'Pay the debt\nFind her brother'
    )
    expect(calls.at(-1)).toEqual(['todo:settle', { id: 't1', status: 'done' }])
    expect(useTodoStore.getState().items).toEqual([])
  })

  it('adds the line to a scene’s notes as a point', async () => {
    await applyPick(
      todoItem('t1', { target: { kind: 'notes', nodeId: 'sc-3' } }),
      'Where Kael went'
    )
    expect(notes).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '• Where Kael went' }] }]
    })
    expect(calls.map(([channel]) => channel)).toEqual(['notes:get', 'notes:save', 'todo:settle'])
  })

  it('makes a new record with the line as its description', async () => {
    await applyPick(
      todoItem('t1', { target: { kind: 'newRecord', category: 'world', name: 'Hollowing' } }),
      'A drowned quarter'
    )
    expect(calls[0]).toEqual([
      'entity:create',
      {
        kind: 'world',
        name: 'Hollowing',
        template: 'structured',
        fields: { description: 'A drowned quarter' }
      }
    ])
    expect(useEntityStore.getState().byId['e-new']?.name).toBe('Hollowing')
  })

  it('makes the new record in the category the author picked', async () => {
    await applyPick(
      todoItem('t1', { target: { kind: 'newRecord', category: 'character', name: 'Hollowing' } }),
      '',
      { category: 'world' }
    )
    expect(calls[0]).toEqual([
      'entity:create',
      { kind: 'world', name: 'Hollowing', template: 'structured' }
    ])
  })

  it('refuses an empty line for a field, and writes nothing', async () => {
    await expect(
      applyPick(
        todoItem('t1', { target: { kind: 'field', entityId: 'e-mara', field: 'goals' } }),
        '   '
      )
    ).rejects.toThrowError(/Write a line/)
    expect(calls).toEqual([])
    expect(useTodoStore.getState().items).toHaveLength(1)
  })
})

describe('applyPick beside an open sheet (F-9.16, verifier)', () => {
  beforeEach(() => {
    resetEntityDraftStore()
    useEntityStore.setState({ byId: { [mara.id]: mara }, ids: [mara.id] })
  })
  afterEach(() => {
    resetEntityDraftStore()
  })

  it('keeps the added line when the sheet page that was open writes its draft back', async () => {
    // The author has Mara's sheet open in the pane (the strip sits above it) and adds a goal.
    useEntityDraftStore.getState().open(mara)
    await applyPick(
      todoItem('t1', { target: { kind: 'field', entityId: 'e-mara', field: 'goals' } }),
      'Find her brother'
    )
    // Leaving the sheet writes the page's draft back (close → flush).
    await useEntityDraftStore.getState().flush()
    const updates = calls.filter(([channel]) => channel === 'entity:update')
    const last = updates.at(-1)?.[1] as { fields?: Record<string, string> } | undefined
    expect(last?.fields?.goals ?? useEntityStore.getState().byId['e-mara']?.fields.goals).toContain(
      'Find her brother'
    )
  })

  it('keeps what the author typed on the open page and shows the added line there', async () => {
    useEntityDraftStore.getState().open(mara)
    useEntityDraftStore.getState().edit({ fields: { age: '32' } })
    await applyPick(
      todoItem('t1', { target: { kind: 'field', entityId: 'e-mara', field: 'goals' } }),
      'Find her brother'
    )
    expect(calls).toContainEqual([
      'entity:update',
      { id: 'e-mara', fields: { goals: 'Pay the debt\nFind her brother', age: '32' } }
    ])
    expect(useEntityDraftStore.getState().draft?.fields.goals).toBe(
      'Pay the debt\nFind her brother'
    )
  })
})
