import { Editor } from '@tiptap/core'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings, type AiSettings } from '@shared/aiSettings'
import type { Input } from '@shared/ipc/contract'
import type { UnderlineView } from '@shared/memory/underlines'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import {
  findingViewFixture,
  installFakeMain,
  type FakeMain
} from '@renderer/features/memory/memoryFixture'
import { resetMemoryStore, useMemoryStore } from '@renderer/features/memory/memoryStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { CONTRADICTION_CLASS, resetContradictionCardStore } from './contradictionMarks'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { buildExtensions } from './extensions'
import { resetNameCheck } from './nameCheck'
import { useContradictionMarks } from './useContradictionMarks'

/**
 * The feeder of the editor's contradiction underlines (F-16.28, plan P4 §5.2, P4 slice 5 review):
 * the scene's underlines read from main on their own (`memory:underlines`) while drawn, set again
 * on a store update, the paragraphs edited since kept bare while the document is unsaved, none
 * (and nothing watched) while the Contradiction check is off or contradictions show in the panel
 * only, and what was drawn reported once per finding (`memory:underlinesShown`, which the
 * precision log needs), again after a failed report.
 */

const FIRST = 'Mara walked in.'
const BROWN = "Mara's eyes were brown."

let main: FakeMain
let editor: Editor
let answer: UnderlineView[]
let shownFails: boolean

const underline = (findingId: string, para: number, quote: string): UnderlineView => ({
  findingId,
  side: 'b',
  para,
  quote,
  finding: findingViewFixture(findingId)
})
const BROWN_MARK = underline('f-1', 1, "Mara's eyes were brown")
const WALKED_MARK = underline('f-2', 0, 'Mara walked in')

const marks = (): string[] =>
  Array.from(editor.view.dom.querySelectorAll<HTMLElement>(`.${CONTRADICTION_CLASS}`)).map(
    (each) => each.textContent ?? ''
  )
const flush = (): Promise<void> =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
const findingsMoved = async (): Promise<void> => {
  act(() => main.emit('memory:findingsChanged', { open: 1, unclear: 0, waiting: 0 }))
  await flush()
}
const settings = (patch: (base: AiSettings) => AiSettings): void => {
  act(() => useAiSettingsStore.setState({ settings: patch(defaultAiSettings()) }))
}

beforeEach(() => {
  resetNameCheck()
  resetMemoryStore()
  resetAiSettingsStore()
  resetDocumentStore()
  resetContradictionCardStore()
  answer = [BROWN_MARK]
  shownFails = false
  main = installFakeMain({
    'memory:underlines': (input) =>
      Object.fromEntries(
        (input as Input<'memory:underlines'>).nodeIds.map((nodeId) => [nodeId, answer])
      ),
    'memory:underlinesShown': () => {
      if (shownFails) throw new Error('main is busy')
      return null
    },
    'memory:cardLines': () => ({})
  })
  useMemoryStore.getState().subscribe()
  settings((base) => ({ ...base, dial: 1 }))
  editor = new Editor({
    extensions: buildExtensions({
      sceneBreak: '~~~',
      onSave: () => {},
      inlineTagNodeId: 'sc-2',
      inertTags: true
    }),
    content: {
      type: 'doc',
      content: [FIRST, BROWN].map((text) => ({
        type: 'paragraph',
        content: [{ type: 'text', text }]
      }))
    }
  })
})

afterEach(() => {
  editor.destroy()
  resetMemoryStore()
  resetAiSettingsStore()
  resetDocumentStore()
  resetContradictionCardStore()
  setIpcClient(null)
})

describe('useContradictionMarks (F-16.28)', () => {
  it('draws the scene’s underlines as main answers them, and again on a store update', async () => {
    const { unmount } = renderHook(() => useContradictionMarks(editor, 'sc-2', true, true))
    await flush()
    expect(main.sent('memory:underlines')).toEqual([{ nodeIds: ['sc-2'] }])
    // Never the scene's whole memory.
    expect(main.sent('memory:scene')).toEqual([])
    expect(marks()).toEqual(["Mara's eyes were brown"])
    answer = []
    await findingsMoved()
    expect(marks()).toEqual([])
    answer = [WALKED_MARK, BROWN_MARK]
    await findingsMoved()
    expect(marks()).toEqual(['Mara walked in', "Mara's eyes were brown"])
    unmount()
  })

  it('keeps the paragraphs edited since bare while the document has unsaved edits', async () => {
    const { unmount } = renderHook(() => useContradictionMarks(editor, 'sc-2', true, true))
    await flush()
    expect(marks()).toEqual(["Mara's eyes were brown"])
    // She types in the brown paragraph: its underline goes; the document is not saved yet.
    act(() => {
      editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Truly.')
    })
    useDocumentStore.setState({
      docs: { 'sc-2': { content: editor.getJSON(), dirty: true } }
    })
    expect(marks()).toEqual([])
    // A refresh meanwhile draws the other paragraph and keeps the edited one bare.
    answer = [WALKED_MARK, BROWN_MARK]
    await findingsMoved()
    expect(marks()).toEqual(['Mara walked in'])
    // Saved (and read again by main): the next refresh draws it again.
    useDocumentStore.setState({ docs: { 'sc-2': { content: editor.getJSON(), dirty: false } } })
    answer = [BROWN_MARK]
    await findingsMoved()
    expect(marks()).toEqual(["Mara's eyes were brown"])
    unmount()
  })

  it('draws and watches nothing while the check is off or contradictions show in the panel only', async () => {
    const { unmount } = renderHook(() => useContradictionMarks(editor, 'sc-2', true, true))
    await flush()
    expect(marks()).toHaveLength(1)
    settings((base) => ({ ...base, features: { ...base.features, judge: false } }))
    await flush()
    expect(marks()).toEqual([])
    expect(useMemoryStore.getState().underlines['sc-2']).toBeUndefined()
    main.calls.length = 0
    await findingsMoved()
    expect(main.sent('memory:underlines')).toEqual([])
    settings((base) => ({ ...base, reading: { ...base.reading, underlines: 'panel' } }))
    await flush()
    expect(marks()).toEqual([])
    expect(main.sent('memory:underlines')).toEqual([])
    // Back in the text: read and drawn again.
    settings((base) => base)
    await flush()
    expect(marks()).toEqual(["Mara's eyes were brown"])
    unmount()
  })

  it('reports what it drew once per finding, and again after a report that failed', async () => {
    shownFails = true
    const { unmount } = renderHook(() => useContradictionMarks(editor, 'sc-2', true, true))
    await flush()
    expect(main.sent('memory:underlinesShown')).toEqual([{ findingIds: ['f-1'] }])
    // Drawn again after the failure: reported again.
    shownFails = false
    answer = []
    await findingsMoved()
    answer = [BROWN_MARK]
    await findingsMoved()
    expect(main.sent('memory:underlinesShown')).toHaveLength(2)
    // Drawn again after a report that went through: not reported again.
    answer = []
    await findingsMoved()
    answer = [BROWN_MARK]
    await findingsMoved()
    expect(main.sent('memory:underlinesShown')).toHaveLength(2)
    unmount()
  })

  it('does nothing in a v1 project', async () => {
    const spy = vi.spyOn(editor.commands, 'setContradictionMarks')
    const { unmount } = renderHook(() => useContradictionMarks(editor, 'sc-2', true, false))
    await flush()
    expect(main.sent('memory:underlines')).toEqual([])
    expect(spy).not.toHaveBeenCalled()
    unmount()
  })
})
