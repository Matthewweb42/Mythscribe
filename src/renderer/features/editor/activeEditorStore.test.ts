import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { resetActiveEditorStore, useActiveEditorStore } from './activeEditorStore'
import { buildExtensions } from './extensions'

const make = (id: string): Editor =>
  new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: id })
  })

const store = (): ReturnType<typeof useActiveEditorStore.getState> =>
  useActiveEditorStore.getState()

let a: Editor
let b: Editor

beforeEach(() => {
  resetTagStore()
  resetActiveEditorStore()
  a = make('sc-1')
  b = make('sc-2')
})
afterEach(() => {
  a.destroy()
  b.destroy()
  resetActiveEditorStore()
})

describe('useActiveEditorStore (F-5.4)', () => {
  it('starts empty and holds the last registered editor', () => {
    expect(store().active).toBeNull()
    store().set('sc-1', a)
    expect(store().active).toEqual({ id: 'sc-1', editor: a })
    store().set('sc-2', b)
    expect(store().active).toEqual({ id: 'sc-2', editor: b })
  })

  it('re-registering the active editor keeps the same state object', () => {
    store().set('sc-1', a)
    const before = store().active
    store().set('sc-1', a)
    expect(store().active).toBe(before)
  })

  it('release drops only the active editor and leaves another registration alone', () => {
    store().set('sc-1', a)
    store().release(b)
    expect(store().active).toEqual({ id: 'sc-1', editor: a })
    store().release(a)
    expect(store().active).toBeNull()
    store().release(a)
    expect(store().active).toBeNull()
  })
})
