import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore } from './documentStore'
import { NotesEditor } from './NotesEditor'
import { AUTOSAVE_DELAY_MS, resetNotesStore, useNotesStore } from './notesStore'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

interface PendingGet {
  id: string
  resolve: (notes: TiptapNodeT | null) => void
}

/** `notes:get` resolves only when the test releases it; `notes:save` records its input and resolves at once. */
function deferredClient(): { client: IpcClient; gets: PendingGet[]; saves: Input<'notes:save'>[] } {
  const gets: PendingGet[] = []
  const saves: Input<'notes:save'>[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'notes:save') {
        saves.push(input as Input<'notes:save'>)
        return { modified: 'm' } as Output<C>
      }
      if (channel !== 'notes:get') throw new Error(`unexpected ${channel}`)
      const { id } = input as Input<'notes:get'>
      return new Promise<Output<C>>((resolve) => {
        gets.push({ id, resolve: (notes) => resolve({ id, notes } as Output<C>) })
      })
    },
    on: () => () => {}
  }
  return { client, gets, saves }
}

let gets: PendingGet[]
let saves: Input<'notes:save'>[]

async function release(index: number, notes: TiptapNodeT | null): Promise<void> {
  const get = gets[index]
  if (!get) throw new Error(`no pending notes:get #${index}`)
  await act(async () => {
    get.resolve(notes)
  })
}

const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Notes' })
const text = (saved: Input<'notes:save'> | undefined): string =>
  JSON.stringify(saved?.notes ?? null)

beforeEach(() => {
  resetNotesStore()
  resetDocumentStore()
  resetLayoutStore()
  resetPendingSaves()
  useDialogStore.setState({ modals: [], toasts: [] })
  const deferred = deferredClient()
  gets = deferred.gets
  saves = deferred.saves
  setIpcClient(deferred.client)
})
afterEach(() => {
  resetNotesStore()
  resetDocumentStore()
  resetLayoutStore()
  resetPendingSaves()
})

describe('NotesEditor (F-3.7)', () => {
  it('is read-only until the notes load, then shows them without a toolbar', async () => {
    render(<NotesEditor id="sc-1" />)
    expect(gets.map((g) => g.id)).toEqual(['sc-1'])
    expect(box()).toHaveAttribute('contenteditable', 'false')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    await release(0, doc('Ends on the cliff'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(box()).toHaveTextContent('Ends on the cliff')
    expect(box()).toHaveClass('ms-editor', 'ms-notes')
    expect(useNotesStore.getState().docs['sc-1']?.dirty).toBe(false)
  })

  it('loads never-written notes as an empty, editable paragraph', async () => {
    render(<NotesEditor id="ch-1" />)
    await release(0, null)
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(box().querySelectorAll('p')).toHaveLength(1)
    expect(box()).toHaveTextContent('')
  })

  it('autosaves typed notes after the debounce, and Ctrl+S saves at once', async () => {
    render(<NotesEditor id="sc-1" />)
    await release(0, doc('Beat: '))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('arrival')
    expect(useNotesStore.getState().docs['sc-1']?.dirty).toBe(true)
    expect(saves).toHaveLength(0)
    await waitFor(() => expect(saves).toHaveLength(1), { timeout: AUTOSAVE_DELAY_MS + 500 })
    expect(saves[0]?.id).toBe('sc-1')
    expect(text(saves[0])).toContain('arrival')
    await waitFor(() => expect(useNotesStore.getState().docs['sc-1']?.dirty).toBe(false))

    await userEvent.keyboard(' at dusk')
    await userEvent.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(saves).toHaveLength(2))
    expect(text(saves[1])).toContain('arrival at dusk')
  })

  it('unmounting saves the pending edit under its id and forgets the notes', async () => {
    const { unmount } = render(<NotesEditor id="sc-1" />)
    await release(0, doc('First'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard(' edited')
    unmount()
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(text(saves[0])).toContain('edited')
    expect(useNotesStore.getState().docs).toEqual({})
  })

  it('switching ids saves the previous notes and loads the next under its own id', async () => {
    const { rerender } = render(<NotesEditor id="sc-1" />)
    await release(0, doc('Scene note'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('!')
    rerender(<NotesEditor id="ch-1" />)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(gets.map((g) => g.id)).toEqual(['sc-1', 'ch-1'])
    await release(1, doc('Chapter note'))
    await waitFor(() => expect(box()).toHaveTextContent('Chapter note'))
    expect(Object.keys(useNotesStore.getState().docs)).toEqual(['ch-1'])
  })

  it('surfaces a failed load as a toast and stays read-only', async () => {
    setIpcClient({
      invoke: async () => {
        throw new Error('Stored notes are not valid JSON')
      },
      on: () => () => {}
    })
    render(<NotesEditor id="sc-1" />)
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
        'Stored notes are not valid JSON'
      ])
    )
    expect(box()).toHaveAttribute('contenteditable', 'false')
  })
})
