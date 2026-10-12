import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useProjectStore } from '@renderer/features/project/projectStore'
import { resetResearchStore, useResearchStore } from '@renderer/features/research/researchStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { DropOverlay } from './DropOverlay'
import { resetLibraryStore, useLibraryStore } from './libraryStore'

/** A drag event with the given payload types and files (jsdom has no DataTransfer). */
function drag(type: string, types: string[], files: File[] = []): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: { types, files, dropEffect: 'none' }
  })
  return event
}

let calls: [Channel, unknown][]

beforeEach(() => {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'library:addData') {
        return { files: [], changed: [], unchanged: 1, skipped: [] } as Output<C>
      }
      if (channel === 'research:addData') {
        const added: Output<'research:addData'> = {
          nodes: [
            {
              id: 'rs-1',
              parentId: 'research',
              sectionType: null,
              kind: 'document',
              hierarchyLevel: null,
              title: 'people',
              position: 2,
              wordCount: 1,
              matterType: null,
              preset: null,
              created: 'c',
              modified: 'm'
            }
          ],
          docs: [
            {
              nodeId: 'rs-1',
              origin: 'upload',
              contextFileId: 'cf-1',
              fileName: 'people.md',
              fileType: 'md',
              converted: false,
              notCanon: false
            }
          ],
          skipped: []
        }
        return added as Output<C>
      }
      if (channel === 'layout:set') return input as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetLibraryStore()
  resetResearchStore()
  resetLayoutStore()
  resetAiSettingsStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})
afterEach(() => {
  resetResearchStore()
  resetLayoutStore()
  useTreeStore.getState().clear()
  useProjectStore.setState({ current: null })
  setIpcClient(null)
})

describe('DropOverlay (F-9.8)', () => {
  it('shows while files are dragged over the window and hands a drop to the Library', async () => {
    render(<DropOverlay />)
    expect(screen.queryByTestId('library-drop-overlay')).toBeNull()

    act(() => {
      window.dispatchEvent(drag('dragenter', ['Files']))
    })
    expect(screen.getByTestId('library-drop-overlay')).toHaveTextContent(
      'Drop to add to the Library'
    )

    const file = new File(['Mara.'], 'people.md')
    const drop = drag('drop', ['Files'], [file])
    act(() => {
      window.dispatchEvent(drop)
    })
    expect(drop.defaultPrevented).toBe(true)
    expect(screen.queryByTestId('library-drop-overlay')).toBeNull()
    await vi.waitFor(() => expect(calls.map(([channel]) => channel)).toEqual(['library:addData']))
    const sent = calls[0]?.[1] as Input<'library:addData'>
    expect(sent.files.map((f) => f.name)).toEqual(['people.md'])
    expect(useLibraryStore.getState().flow).toBeNull()
  })

  it('in story memory v2, hands a drop to Research and opens the new page (F-16.8)', async () => {
    useProjectStore.setState({
      current: {
        id: 'p-2',
        name: 'Memory',
        format: 'novel',
        path: '/books/Memory.mythscribe',
        created: 'c',
        modified: 'm',
        lastOpened: 'l',
        schemaVersion: 33,
        storyMemory: 'v2'
      }
    })
    useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
    render(<DropOverlay />)
    act(() => {
      window.dispatchEvent(drag('dragenter', ['Files']))
    })
    expect(screen.getByTestId('library-drop-overlay')).toHaveTextContent('Drop to add to Research')
    act(() => {
      window.dispatchEvent(drag('drop', ['Files'], [new File(['Mara.'], 'people.md')]))
    })
    await vi.waitFor(() => expect(useTreeStore.getState().selectedId).toBe('rs-1'))
    expect(calls.map(([channel]) => channel)).not.toContain('library:addData')
    const sent = calls.find(([channel]) => channel === 'research:addData')?.[1] as
      Input<'research:addData'> | undefined
    expect(sent?.files.map((f) => f.name)).toEqual(['people.md'])
    expect(useResearchStore.getState().docs['rs-1']?.origin).toBe('upload')
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('research')
  })

  it('leaves a drag without files alone (moving text in the editor)', () => {
    render(<DropOverlay />)
    const enter = drag('dragenter', ['text/plain'])
    act(() => {
      window.dispatchEvent(enter)
    })
    expect(enter.defaultPrevented).toBe(false)
    expect(screen.queryByTestId('library-drop-overlay')).toBeNull()
  })
})
