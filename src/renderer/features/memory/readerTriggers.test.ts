import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output, ProjectInfo } from '@shared/ipc/contract'
import type { StoryMemoryVersion } from '@shared/storyMemory'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetActiveEditorStore, useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { researchTreeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { registerPendingSave, resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { caretParagraph, noteSaved, startReaderTriggers, stopReaderTriggers } from './readerTriggers'

let settled: Input<'memory:settle'>[]
let order: string[]
let editor: Editor | null

function project(memory: StoryMemoryVersion): ProjectInfo {
  return {
    id: 'p-1',
    name: 'Memory',
    format: 'novel',
    path: '/books/Memory.mythscribe',
    created: 'c',
    modified: 'm',
    lastOpened: 'l',
    schemaVersion: 34,
    storyMemory: memory
  }
}

const select = (id: string | null): void => useTreeStore.setState({ selectedId: id })

/** Lets the settle's flush and invoke run. */
async function flushed(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  settled = []
  order = []
  editor = null
  resetPendingSaves()
  resetActiveEditorStore()
  stopReaderTriggers()
  useProjectStore.setState({ current: project('v2') })
  useTreeStore.setState({ ...buildIndex(researchTreeFixture), selectedId: null })
  useAiSettingsStore.setState({ settings: defaultAiSettings() })
  registerPendingSave(() => {
    order.push('flush')
    return Promise.resolve()
  })
  setIpcClient({
    invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'memory:settle') return Promise.reject(new Error(`unexpected ${channel}`))
      order.push('settle')
      settled.push(input as Input<'memory:settle'>)
      return Promise.resolve({ queued: true, reason: null } as Output<C>)
    },
    on: () => () => {}
  })
})

afterEach(() => {
  stopReaderTriggers()
  editor?.destroy()
  resetActiveEditorStore()
  resetPendingSaves()
  setIpcClient(null)
  useProjectStore.setState({ current: null })
  vi.useRealTimers()
})

describe('reader triggers (F-16.16, plan P2a §3.1)', () => {
  it('settles the scene left when another manuscript scene opens, after flushing saves', async () => {
    select('sc-1')
    startReaderTriggers()
    select('sc-2')
    await flushed()
    expect(settled).toEqual([{ nodeId: 'sc-1', reason: 'leave', caretPara: null }])
    expect(order).toEqual(['flush', 'settle'])
    select('sc-4')
    await flushed()
    expect(settled.map((each) => each.nodeId)).toEqual(['sc-1', 'sc-2'])
  })

  it('does not count Research, a folder, front matter or nothing selected as leaving', async () => {
    startReaderTriggers()
    select('sc-1')
    for (const id of ['r-note', 'ch-1', 'title-page', null]) select(id)
    await flushed()
    expect(settled).toEqual([])
    // Back to the same scene: still nothing; then another scene leaves sc-1.
    select('sc-1')
    select('sc-2')
    await flushed()
    expect(settled.map((each) => each.nodeId)).toEqual(['sc-1'])
  })

  it('restarts the idle timer on each save of the open scene and settles it with the caret paragraph', async () => {
    useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), reading: { idleMinutes: 2 } } })
    editor = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
      content: {
        type: 'doc',
        content: [
          { type: 'paragraph', content: [{ type: 'text', text: 'Mara waited.' }] },
          { type: 'paragraph', content: [{ type: 'text', text: 'The boats came' }] }
        ]
      }
    })
    useActiveEditorStore.getState().set('sc-1', editor)
    editor.commands.setTextSelection(18)
    expect(caretParagraph('sc-1')).toBe(1)
    select('sc-1')
    startReaderTriggers()
    noteSaved('sc-1')
    await vi.advanceTimersByTimeAsync(90_000)
    // Another save: the pause starts over.
    noteSaved('sc-1')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(settled).toEqual([])
    // A save of another document says nothing about the open scene's pause.
    noteSaved('sc-2')
    await vi.advanceTimersByTimeAsync(30_000)
    await flushed()
    expect(settled).toEqual([{ nodeId: 'sc-1', reason: 'idle', caretPara: 1 }])
  })

  it('does nothing in a v1 project', async () => {
    useProjectStore.setState({ current: project('v1') })
    select('sc-1')
    startReaderTriggers()
    select('sc-2')
    noteSaved('sc-2')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    await flushed()
    expect(settled).toEqual([])
  })

  it('forgets the open scene and its timer when stopped', async () => {
    select('sc-1')
    startReaderTriggers()
    noteSaved('sc-1')
    stopReaderTriggers()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    select('sc-2')
    await flushed()
    expect(settled).toEqual([])
  })
})
