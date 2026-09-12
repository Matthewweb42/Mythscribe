import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { EditorPane } from './EditorPane'

const doc = (text: string): TiptapNodeT => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }]
})

interface Pending {
  id: string
  resolve: (content: TiptapNodeT | null) => void
}

/**
 * `document:get` resolves only when the test releases it, so the loading state is observable;
 * `document:save` (F-3.2) records its input and resolves at once.
 */
function deferredClient(): {
  client: IpcClient
  pending: Pending[]
  saves: Input<'document:save'>[]
} {
  const pending: Pending[] = []
  const saves: Input<'document:save'>[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'document:save') {
        const save = input as Input<'document:save'>
        saves.push(save)
        return { wordCount: countWords(save.content), modified: 'm' } as Output<C>
      }
      if (channel !== 'document:get') throw new Error(`unexpected ${channel}`)
      const { id } = input as Input<'document:get'>
      return new Promise<Output<C>>((resolve) => {
        pending.push({ id, resolve: (content) => resolve({ id, content } as Output<C>) })
      })
    },
    on: () => () => {}
  }
  return { client, pending, saves }
}

let pending: Pending[]
let saves: Input<'document:save'>[]

beforeEach(() => {
  resetDocumentStore()
  resetPendingSaves()
  const deferred = deferredClient()
  pending = deferred.pending
  saves = deferred.saves
  setIpcClient(deferred.client)
})

/** The text of the first paragraph of a saved document, whatever the caret position was. */
const firstParagraphText = (saved: TiptapNodeT | undefined): string =>
  (saved?.content?.[0]?.content ?? []).map((n) => n.text ?? '').join('')

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

  it('Ctrl+S saves the typed text at once (F-3.2)', async () => {
    render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('Once upon a time'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('again')
    expect(useDocumentStore.getState().dirty).toBe(true)
    expect(saves).toHaveLength(0)

    await userEvent.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(saves[0]?.content.type).toBe('doc')
    expect(firstParagraphText(saves[0]?.content)).toContain('again')
    expect(firstParagraphText(saves[0]?.content)).toContain('Once upon a time')
    await waitFor(() => expect(useDocumentStore.getState().dirty).toBe(false))
  })

  it('switching documents saves the previous document under its own id (F-3.2)', async () => {
    const { rerender } = render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('First scene'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('edited')
    expect(saves).toHaveLength(0)

    rerender(<EditorPane id="sc-2" format="novel" />)
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(firstParagraphText(saves[0]?.content)).toContain('edited')
    expect(firstParagraphText(saves[0]?.content)).toContain('First scene')
    await release(1, doc('Second scene'))
    await waitFor(() => expect(box()).toHaveTextContent('Second scene'))
    expect(useDocumentStore.getState()).toMatchObject({ id: 'sc-2', dirty: false })
    expect(saves).toHaveLength(1)
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
