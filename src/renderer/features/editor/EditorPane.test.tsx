import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { EditorPane } from './EditorPane'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

interface Pending {
  id: string
  resolve: (content: TiptapNodeT | null) => void
}

/** `document:get` resolves only when the test releases it, so the loading state is observable. */
function deferredClient(): { client: IpcClient; pending: Pending[] } {
  const pending: Pending[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'document:get') throw new Error(`unexpected ${channel}`)
      const { id } = input as Input<'document:get'>
      return new Promise<Output<C>>((resolve) => {
        pending.push({ id, resolve: (content) => resolve({ id, content } as Output<C>) })
      })
    },
    on: () => () => {}
  }
  return { client, pending }
}

let pending: Pending[]

beforeEach(() => {
  useDocumentStore.getState().clear()
  const deferred = deferredClient()
  pending = deferred.pending
  setIpcClient(deferred.client)
})

const box = (): HTMLElement => screen.getByRole('textbox', { name: 'Document' })
const button = (name: string): HTMLElement => screen.getByRole('button', { name })

const release = async (index: number, content: TiptapNodeT | null): Promise<void> => {
  await act(async () => {
    pending[index]?.resolve(content)
  })
}

describe('EditorPane', () => {
  it('is read-only with a disabled toolbar until the document loads', async () => {
    render(<EditorPane id="sc-1" format="novel" />)
    expect(box()).toHaveAttribute('contenteditable', 'false')
    expect(button('Bold')).toBeDisabled()
    expect(pending.map((p) => p.id)).toEqual(['sc-1'])

    await release(0, doc('Once upon a time'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(box()).toHaveTextContent('Once upon a time')
    expect(button('Bold')).toBeEnabled()
  })

  it('loading never lands on the undo stack and does not mark the document dirty', async () => {
    render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('Once upon a time'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))

    expect(button('Undo')).toBeDisabled()
    expect(useDocumentStore.getState().dirty).toBe(false)

    await userEvent.click(box())
    await userEvent.keyboard('!')
    await waitFor(() => expect(button('Undo')).toBeEnabled())
    expect(useDocumentStore.getState().dirty).toBe(true)

    // Undoing the author's edit restores the loaded text and stops there: the load is not a step.
    await userEvent.click(button('Undo'))
    await waitFor(() => expect(box()).toHaveTextContent('Once upon a time'))
    expect(box()).not.toHaveTextContent('!')
    expect(button('Undo')).toBeDisabled()
  })

  it('switching documents starts a fresh history, so undo cannot reach the previous document', async () => {
    const { rerender } = render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('First scene'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard(' edited')
    await waitFor(() => expect(button('Undo')).toBeEnabled())

    rerender(<EditorPane id="sc-2" format="novel" />)
    expect(box()).toHaveAttribute('contenteditable', 'false')
    expect(box()).not.toHaveTextContent('First scene')
    await release(1, doc('Second scene'))
    await waitFor(() => expect(box()).toHaveTextContent('Second scene'))
    expect(button('Undo')).toBeDisabled()
    expect(useDocumentStore.getState()).toMatchObject({ id: 'sc-2', dirty: false })
  })

  it('loads a never-written document as an empty paragraph', async () => {
    render(<EditorPane id="sc-1" format="webnovel" />)
    await release(0, null)
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(box().querySelectorAll('p')).toHaveLength(1)
    expect(box()).toHaveTextContent('')
    expect(button('Undo')).toBeDisabled()
  })
})
