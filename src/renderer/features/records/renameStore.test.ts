import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { RenameApplyResult, RenameUndoResult } from '@shared/memory/rename'
import type { StoryRecord } from '@shared/memory/records'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { resetRenameStore, useRenameStore } from './renameStore'

/**
 * F-16.13 in the renderer: main rewrites the stored scenes; the scene open in the editor is
 * rewritten through its editor in one transaction (the caret and Ctrl+Z hold), and the one Undo
 * restores it there too, only while it still reads as the rename left it.
 */

const RECORD: StoryRecord = {
  id: 'r-hesk',
  categoryId: 'character',
  kind: 'character',
  name: 'Haskel',
  image: null,
  origin: 'author',
  aliases: [],
  created: '2026-10-12T10:00:00.000Z',
  modified: '2026-10-12T10:00:00.000Z',
  pinned: null,
  ideas: null
}

const doc = (...paragraphs: string[]): TiptapNodeT => ({
  type: 'doc',
  content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
})

let editor: Editor
let calls: [Channel, unknown][]
let stored: Record<string, TiptapNodeT>
let undoAnswer: RenameUndoResult

const APPLIED: RenameApplyResult = {
  record: RECORD,
  match: { query: 'Hesk', replacement: 'Haskel', matchCase: true, wholeWord: true },
  written: [{ id: 'sc-2', wordCount: 4, count: 1 }],
  drafts: 2,
  openId: 'sc-1'
}

function install(): void {
  calls = []
  stored = {}
  undoAnswer = {
    record: { ...RECORD, name: 'Hesk' },
    restored: [{ id: 'sc-2', wordCount: 4 }],
    skipped: [],
    drafts: { restored: 1, skipped: 0 },
    nameRestored: true
  }
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      switch (channel) {
        case 'rename:preview':
          return {
            from: 'Hesk',
            to: 'Haskel',
            scenes: [
              { nodeId: 'sc-1', title: 'One', count: 2 },
              { nodeId: 'sc-2', title: 'Two', count: 1 }
            ],
            total: 3,
            otherDrafts: { matches: 2, scenes: 1 }
          } as Output<C>
        case 'rename:apply':
          return APPLIED as Output<C>
        case 'rename:undo':
          return undoAnswer as Output<C>
        case 'document:get': {
          const { id } = input as Input<'document:get'>
          return { id, content: stored[id] ?? null } as Output<C>
        }
        case 'document:save': {
          const { id, content } = input as Input<'document:save'>
          stored[id] = content
          return { wordCount: 3, modified: 'now' } as Output<C>
        }
        default:
          throw new Error(`unexpected ${channel}`)
      }
    },
    on: () => () => {}
  })
}

const text = (): string => editor.getText({ blockSeparator: '\n' })
const toasts = (): string[] => useDialogStore.getState().toasts.map((each) => each.message)

beforeEach(() => {
  resetRenameStore()
  resetActiveEditorStore()
  resetDocumentStore()
  resetGoalsStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: doc('Hesk came in.', "Hesk's coat dripped; Heskel waited.")
  })
  editor.commands.setTextSelection(5)
  useActiveEditorStore.getState().set('sc-1', editor)
})
afterEach(() => {
  editor.destroy()
  resetRenameStore()
  resetActiveEditorStore()
  resetDocumentStore()
})

const previewAndApply = async (): Promise<boolean> => {
  await useRenameStore.getState().ask({ recordId: 'r-hesk', aliasId: 'a-1', to: 'Haskel' })
  return useRenameStore.getState().apply()
}

describe('Rename in book with an open editor (F-16.13)', () => {
  it('sends the open scene to main, then renames it through the editor in one undoable step', async () => {
    expect(await previewAndApply()).toBe(true)
    const apply = calls.find(([channel]) => channel === 'rename:apply')?.[1]
    expect(apply).toEqual({ recordId: 'r-hesk', aliasId: 'a-1', to: 'Haskel', openId: 'sc-1' })
    expect(text()).toBe("Haskel came in.\nHaskel's coat dripped; Heskel waited.")
    // The caret stays in the word it was in.
    expect(editor.state.selection.head).toBeGreaterThan(1)
    expect(toasts()).toContain(
      'Renamed “Hesk” to “Haskel”: 3 matches in 2 scenes (+2 in other drafts).'
    )
    expect(useRenameStore.getState().undoable).toEqual({
      recordId: 'r-hesk',
      from: 'Hesk',
      to: 'Haskel'
    })
    // One history step: Ctrl+Z takes the whole rename of the scene back.
    editor.commands.undo()
    expect(text()).toBe("Hesk came in.\nHesk's coat dripped; Heskel waited.")
  })

  it('Undo restores the open scene through its editor and main the rest', async () => {
    await previewAndApply()
    await useRenameStore.getState().undo()
    expect(calls.some(([channel]) => channel === 'rename:undo')).toBe(true)
    expect(text()).toBe("Hesk came in.\nHesk's coat dripped; Heskel waited.")
    expect(toasts()).toContain('Put back 2 scenes.')
    expect(useRenameStore.getState().undoable).toBeNull()
  })

  it('leaves the open scene alone when it was edited after the rename, and says so', async () => {
    await previewAndApply()
    editor.commands.insertContentAt(1, 'Then ')
    undoAnswer = { ...undoAnswer, skipped: [{ id: 'sc-3', title: 'Three' }] }
    await useRenameStore.getState().undo()
    expect(text()).toBe("Then Haskel came in.\nHaskel's coat dripped; Heskel waited.")
    const warning = toasts().find((each) => each.startsWith('Put back 1 scene.'))
    expect(warning).toContain('Left as they are (changed since): Three, ')
  })

  it('restores the open scene from its stored text when its editor has closed meanwhile', async () => {
    await previewAndApply()
    const after = editor.getJSON()
    stored['sc-1'] = after
    useActiveEditorStore.getState().release(editor)
    await useRenameStore.getState().undo()
    const saved = calls.filter(([channel]) => channel === 'document:save')
    expect(saved).toHaveLength(1)
    const restored = stored['sc-1']?.content?.map((block) => block.content?.[0]?.text)
    expect(restored).toEqual(['Hesk came in.', "Hesk's coat dripped; Heskel waited."])
  })

  it('does nothing without a preview to apply', async () => {
    expect(await useRenameStore.getState().apply()).toBe(false)
    expect(calls).toEqual([])
  })
})
