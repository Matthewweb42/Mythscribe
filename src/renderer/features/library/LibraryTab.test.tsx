import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { contextFileFixture } from './libraryFixture'
import { LibraryTab } from './LibraryTab'
import { resetLibraryStore, useLibraryStore } from './libraryStore'

let calls: [Channel, unknown][]

beforeEach(() => {
  calls = []
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'library:open') return null as Output<C>
      if (channel === 'library:add') return null as Output<C>
      if (channel === 'library:estimate') {
        return {
          files: 1,
          chunks: 1,
          tokensIn: 1,
          tokensOut: 1,
          costUsd: 0,
          priced: true,
          model: 'gpt-5.4'
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetLibraryStore()
  resetAiSettingsStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
})

describe('LibraryTab (F-9.8)', () => {
  it('says how to add files while the library is empty', async () => {
    render(<LibraryTab />)
    expect(screen.getByText(/No files yet/)).toHaveTextContent('drop them anywhere on the window')
    await userEvent.click(screen.getByTestId('library-add'))
    expect(calls).toEqual([['library:add', {}]])
  })

  it('lists each file with its type, date, and state, and opens, updates, and sorts one', async () => {
    useLibraryStore.setState({
      files: [
        contextFileFixture(),
        contextFileFixture({ id: 'f2', name: 'map.png', type: 'image', state: 'reference' }),
        contextFileFixture({ id: 'f3', name: 'world.pdf', type: 'pdf', state: 'processed' })
      ],
      loaded: true
    })
    render(<LibraryTab />)
    const rows = within(screen.getByRole('list', { name: 'Library files' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Markdown · Oct 7, 2026 · Not sorted yet'),
      expect.stringContaining('Image · Oct 7, 2026 · Reference image'),
      expect.stringContaining('PDF · Oct 7, 2026 · Sorted')
    ])
    expect(screen.queryByRole('button', { name: 'Sort map.png' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Open people.md' }))
    await userEvent.click(screen.getByRole('button', { name: 'Update people.md' }))
    expect(calls).toEqual([
      ['library:open', { id: 'f1' }],
      ['library:add', { replaceId: 'f1' }]
    ])
    expect(screen.getByTestId('library-sort-all')).toHaveTextContent('Sort 1 file')
    await userEvent.click(screen.getByRole('button', { name: 'Sort again world.pdf' }))
    expect(calls.at(-1)).toEqual(['library:estimate', { fileIds: ['f3'] }])
  })
})
