import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { resetActiveEditorStore, useActiveEditorStore } from './activeEditorStore'
import { buildExtensions } from './extensions'
import { locateText } from './locateText'
import {
  OPEN_SCENE_TIMEOUT_MS,
  PASSAGE_GONE_MESSAGE,
  openMention,
  openPassage
} from './openPassage'

const TEXT = 'Mara waited at the dark forest. Rose waited too.'

let editor: Editor
/** A second document's editor, to prove the wait is for the right one. */
let other: Editor

const newEditor = (): Editor =>
  new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: TEXT }] }]
    }
  })

const selectedText = (): string => {
  const { from, to } = editor.state.selection
  return editor.state.doc.textBetween(from, to)
}
const toasts = (): string[] => useDialogStore.getState().toasts.map((t) => t.message)
/** The recorded range of `needle` in the document, the way main's scan would have stored it. */
const rangeOf = (needle: string): [number, number] => {
  const found = locateText(editor.state.doc, needle)
  if (!found) throw new Error(`no ${needle}`)
  return [found.from, found.to]
}

beforeEach(() => {
  vi.useFakeTimers()
  resetTagStore()
  resetActiveEditorStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  editor = newEditor()
  other = newEditor()
})
afterEach(() => {
  editor.destroy()
  other.destroy()
  vi.useRealTimers()
  resetActiveEditorStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('openPassage (F-5.7, F-4.12)', () => {
  it('selects the node in the tree and the located passage in its editor', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await openPassage('sc-1', (doc) => locateText(doc, 'the dark forest'))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(selectedText()).toBe('the dark forest')
    expect(toasts()).toEqual([])
  })

  it('waits for the node it opened to mount its editor, and gives up after the timeout', async () => {
    const opening = openPassage('sc-1', (doc) => locateText(doc, 'Mara'))
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
    expect(selectedText()).toBe('')
    useActiveEditorStore.getState().set('sc-2', other)
    await vi.advanceTimersByTimeAsync(0)
    expect(selectedText()).toBe('')
    useActiveEditorStore.getState().set('sc-1', editor)
    await opening
    expect(selectedText()).toBe('Mara')

    const never = openPassage('sc-3', (doc) => locateText(doc, 'Mara'))
    await vi.advanceTimersByTimeAsync(OPEN_SCENE_TIMEOUT_MS)
    await never
    expect(useTreeStore.getState().selectedId).toBe('sc-3')
    expect(toasts()).toEqual([])
  })

  it('toasts when the passage is gone and leaves the selection alone', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await openPassage('sc-1', () => null)
    expect(toasts()).toEqual([PASSAGE_GONE_MESSAGE])
    expect(selectedText()).toBe('')
  })
})

describe('openMention (F-4.12)', () => {
  it('selects the recorded range when it still spells the tag’s words', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await openMention('sc-1', rangeOf('dark forest'), 'dark-forest')
    expect(selectedText()).toBe('dark forest')
    expect(toasts()).toEqual([])
  })

  it('matches the recorded range case-insensitively', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await openMention('sc-1', rangeOf('Rose'), 'rose')
    expect(selectedText()).toBe('Rose')
  })

  it('searches for the name when the recorded range moved or is out of bounds', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    const drifted = rangeOf('Mara')
    await openMention('sc-1', [drifted[0] + 6, drifted[1] + 6], 'mara')
    expect(selectedText()).toBe('Mara')
    await openMention('sc-1', [9_000, 9_004], 'rose')
    expect(selectedText()).toBe('Rose')
    // An empty range never reads as the name either, so it searches too.
    await openMention('sc-1', [0, 0], 'mara')
    expect(selectedText()).toBe('Mara')
  })

  it('toasts when neither the recorded range nor the name is in the document any more', async () => {
    useActiveEditorStore.getState().set('sc-1', editor)
    await openMention('sc-1', [2, 6], 'gone-name')
    expect(toasts()).toEqual([PASSAGE_GONE_MESSAGE])
    expect(selectedText()).toBe('')
  })
})
