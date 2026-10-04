import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REPLACE_QUERY_MAX } from '@shared/replace'
import { compileFind } from '@shared/findInDocument'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { resetActiveEditorStore, useActiveEditorStore } from './activeEditorStore'
import { buildExtensions } from './extensions'
import { escapeRegex, resetFindStore, useFindStore } from './findStore'

let editor: Editor

beforeEach(() => {
  resetFindStore()
  resetActiveEditorStore()
  resetTagStore()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Rain (again) fell.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line.' }] }
      ]
    }
  })
})
afterEach(() => {
  editor.destroy()
  resetFindStore()
})

describe('findStore (F-3.10)', () => {
  it('opens with or without the replace row and bumps the focus tick each time', () => {
    useFindStore.getState().openFind(false)
    expect(useFindStore.getState()).toMatchObject({ open: true, showReplace: false, focusTick: 1 })
    useFindStore.getState().openFind(true)
    expect(useFindStore.getState()).toMatchObject({ open: true, showReplace: true, focusTick: 2 })
    useFindStore.getState().close()
    expect(useFindStore.getState().open).toBe(false)
  })

  it('prefills the query from a single-line selection in the active editor', () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    useFindStore.getState().setQuery('old')
    editor.commands.setTextSelection({ from: 6, to: 13 })
    useFindStore.getState().openFind(false)
    expect(useFindStore.getState().query).toBe('(again)')
  })

  it('escapes the prefill in regex mode so it finds itself', () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    useFindStore.getState().setRegex(true)
    editor.commands.setTextSelection({ from: 6, to: 13 })
    useFindStore.getState().openFind(false)
    const query = useFindStore.getState().query
    expect(query).toBe('\\(again\\)')
    const compiled = compileFind({ query, matchCase: true, wholeWord: false, regex: true })
    expect(compiled.ok && compiled.find('Rain (again) fell.')).toEqual([
      expect.objectContaining({ from: 5, to: 12 })
    ])
  })

  it('keeps the last query for a caret, a multi-line selection, or no editor', () => {
    useFindStore.getState().setQuery('kept')
    useFindStore.getState().openFind(false)
    expect(useFindStore.getState().query).toBe('kept')
    useActiveEditorStore.getState().set('sc-1', editor)
    editor.commands.setTextSelection(3)
    useFindStore.getState().openFind(false)
    expect(useFindStore.getState().query).toBe('kept')
    editor.commands.setTextSelection({ from: 3, to: 25 })
    useFindStore.getState().openFind(false)
    expect(useFindStore.getState().query).toBe('kept')
  })

  it('caps the query and resets to closed and empty', () => {
    useFindStore.getState().setQuery('x'.repeat(REPLACE_QUERY_MAX + 10))
    expect(useFindStore.getState().query).toHaveLength(REPLACE_QUERY_MAX)
    useFindStore.getState().openFind(true)
    resetFindStore()
    expect(useFindStore.getState()).toMatchObject({ open: false, query: '', focusTick: 0 })
  })

  it('escapeRegex covers the syntax characters', () => {
    expect(escapeRegex('a.b*c?(d)[e]{f}|g^h$i\\j+k/l')).toBe(
      'a\\.b\\*c\\?\\(d\\)\\[e\\]\\{f\\}\\|g\\^h\\$i\\\\j\\+k\\/l'
    )
  })
})
