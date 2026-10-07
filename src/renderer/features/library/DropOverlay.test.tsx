import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
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
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetLibraryStore()
  resetAiSettingsStore()
  useDialogStore.setState({ modals: [], toasts: [] })
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
