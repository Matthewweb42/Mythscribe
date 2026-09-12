import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Editor } from '@tiptap/core'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { TiptapNodeT } from '@shared/tiptap'
import { countWords } from '@shared/wordCount'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { DocumentEditor } from './DocumentEditor'
import { resetDocumentStore, useDocumentStore } from './documentStore'
import { EditorPane } from './EditorPane'
import { resetEditorSettingsStore, useEditorSettingsStore } from './settingsStore'

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
  resetEditorSettingsStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
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
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(false)

    await userEvent.click(box())
    await userEvent.keyboard('!')
    await waitFor(() => expect(button('Undo')).toBeEnabled())
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(true)

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
    expect(Object.keys(useDocumentStore.getState().docs)).toEqual(['sc-2'])
    expect(useDocumentStore.getState().docs['sc-2']?.dirty).toBe(false)
  })

  it('Ctrl+S saves the typed text at once (F-3.2)', async () => {
    render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('Once upon a time'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('again')
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(true)
    expect(saves).toHaveLength(0)

    await userEvent.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(saves[0]?.content.type).toBe('doc')
    expect(firstParagraphText(saves[0]?.content)).toContain('again')
    expect(firstParagraphText(saves[0]?.content)).toContain('Once upon a time')
    await waitFor(() => expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(false))
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
    expect(Object.keys(useDocumentStore.getState().docs)).toEqual(['sc-2'])
    expect(useDocumentStore.getState().docs['sc-2']?.dirty).toBe(false)
    expect(saves).toHaveLength(1)
  })

  it('unmounting saves the pending edit and forgets the document (F-3.8)', async () => {
    const { unmount } = render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('First scene'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('edited')
    unmount()
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(firstParagraphText(saves[0]?.content)).toContain('edited')
    expect(useDocumentStore.getState().docs).toEqual({})
  })

  it('shows a live word count and the session delta under the document (F-3.3)', async () => {
    useTreeStore.setState({ wordCountRollup: { 'sc-1': 4 }, sessionBaseline: { 'sc-1': 4 } })
    render(<EditorPane id="sc-1" format="novel" />)
    // While loading, the tree's saved count stands in.
    expect(screen.getByTestId('status-words')).toHaveTextContent('4 words')
    expect(screen.getByTestId('status-delta')).toHaveTextContent('+0 this session')
    await release(0, doc('Once upon a time'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(screen.getByTestId('status-words')).toHaveTextContent('4 words')
    await userEvent.click(box())
    await userEvent.keyboard(' far away ') // padded, so the count is the same wherever the caret landed
    // Counted from the editor at once, before any save.
    expect(saves).toHaveLength(0)
    expect(screen.getByTestId('status-words')).toHaveTextContent('6 words')
    expect(screen.getByTestId('status-delta')).toHaveTextContent('+2 this session')
  })

  it('lays the text out in the book-like column sized by the format default (F-3.4)', async () => {
    render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('Once'))
    const column = box().parentElement
    expect(column).toHaveClass('max-w-(--ms-editor-max-width)', 'mx-auto', 'w-full', 'px-6')
    const pane = screen.getByRole('toolbar', { name: 'Formatting' }).parentElement
    expect(pane?.style.getPropertyValue('--ms-editor-max-width')).toBe('700px')
  })

  it('applies the formatting settings as custom properties and offers the Formatting popover (F-3.6)', async () => {
    useEditorSettingsStore.setState({
      settings: { ...defaultEditorSettings('novel'), fontSize: 20, lineHeight: 1.4, maxWidth: 800 }
    })
    render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('Once'))
    const pane = screen.getByRole('toolbar', { name: 'Formatting' }).parentElement
    expect(pane?.style.getPropertyValue('--ms-editor-max-width')).toBe('800px')
    expect(pane?.style.getPropertyValue('--ms-editor-font-size')).toBe('20px')
    expect(pane?.style.getPropertyValue('--ms-editor-line-height')).toBe('1.4')
    expect(pane?.style.getPropertyValue('--ms-editor-paragraph-indent')).toBe('1.5em')
    expect(button('Formatting settings')).toHaveAttribute('aria-expanded', 'false')
    // A change lands live, without a remount of the editor.
    const before = box()
    act(() => useEditorSettingsStore.getState().update({ fontSize: 22 }))
    expect(pane?.style.getPropertyValue('--ms-editor-font-size')).toBe('22px')
    expect(box()).toBe(before)
  })

  it('keeps unsaved typing when a scene-break change rebuilds the editor (F-3.6)', async () => {
    render(<EditorPane id="sc-1" format="novel" />)
    await release(0, doc('Once upon a time'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    await userEvent.click(box())
    await userEvent.keyboard('typed ')
    expect(box()).toHaveTextContent('typed')
    expect(saves).toHaveLength(0)

    act(() =>
      useEditorSettingsStore.setState({
        settings: { ...defaultEditorSettings('novel'), sceneBreak: '###' }
      })
    )
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(box()).toHaveTextContent('typed')
    expect(box()).toHaveTextContent('Once upon a time')
    expect(useDocumentStore.getState().docs['sc-1']?.dirty).toBe(true)

    await userEvent.click(button('Scene break'))
    await waitFor(() =>
      expect(box().querySelector('[data-scene-break]')).toHaveTextContent('###')
    )
    // The rebuilt editor keeps reporting edits under the same id.
    await userEvent.click(box())
    await userEvent.keyboard('more ')
    expect(JSON.stringify(useDocumentStore.getState().docs['sc-1']?.content)).toContain('more')
    await userEvent.keyboard('{Control>}s{/Control}')
    await waitFor(() => expect(saves).toHaveLength(1))
    expect(saves[0]?.id).toBe('sc-1')
    expect(saves[0]?.content.content?.map((n) => n.type)).toContain('sceneBreak')
    expect(JSON.stringify(saves[0]?.content)).toContain('typed')
    expect(JSON.stringify(saves[0]?.content)).toContain('more')
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

describe('DocumentEditor as a stacked region (F-3.8)', () => {
  it('renders no toolbar and no scroll box of its own with toolbar={false}', async () => {
    render(<DocumentEditor id="sc-1" format="novel" toolbar={false} />)
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
    await release(0, doc('Region text'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(box()).toHaveTextContent('Region text')
    expect(box()).toHaveClass('ms-editor-region')
    expect(screen.queryByRole('toolbar')).not.toBeInTheDocument()
  })

  it('reports its editor through onFocus when clicked', async () => {
    const onFocus = vi.fn<(editor: Editor) => void>()
    render(<DocumentEditor id="sc-1" format="novel" toolbar={false} onFocus={onFocus} />)
    await release(0, doc('Region text'))
    await waitFor(() => expect(box()).toHaveAttribute('contenteditable', 'true'))
    expect(onFocus).not.toHaveBeenCalled()
    await userEvent.click(box())
    await waitFor(() => expect(onFocus).toHaveBeenCalled())
    const editor = onFocus.mock.calls[0]?.[0]
    expect(editor?.getText()).toBe('Region text')
    expect(editor?.view.dom).toBe(box())
  })
})
