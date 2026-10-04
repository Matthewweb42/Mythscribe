import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { WordCountReport } from '@shared/wordCount'
import {
  resetActiveEditorStore,
  useActiveEditorStore
} from '@renderer/features/editor/activeEditorStore'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { buildExtensions } from '@renderer/features/editor/extensions'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { WordCountDialog } from './WordCountDialog'

const report: WordCountReport = {
  chapter: {
    id: 'ch-1',
    title: 'Chapter 1',
    stats: { words: 600, characters: 3300, charactersNoSpaces: 2700 }
  },
  manuscript: { words: 80_000, characters: 440_000, charactersNoSpaces: 360_000 }
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>
let editor: Editor | null = null

function install(answer: WordCountReport | Error = report): void {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'stats:wordCount') {
      if (answer instanceof Error) throw answer
      return answer
    }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

function openEditor(id: string, text: string): Editor {
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: id }),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
  })
  useActiveEditorStore.getState().set(id, editor)
  return editor
}

const cells = (row: HTMLElement): string[] =>
  within(row)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '')

beforeEach(() => {
  resetTagStore()
  resetActiveEditorStore()
  resetDocumentStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: null })
  install()
})
afterEach(() => {
  editor?.destroy()
  editor = null
  resetActiveEditorStore()
  resetDocumentStore()
})

describe('WordCountDialog (F-10.4)', () => {
  it('counts the selection and document live, and the chapter and manuscript from main', async () => {
    const live = openEditor('sc-1', 'The storm broke at dusk.')
    live.commands.setTextSelection({ from: 1, to: 10 })
    render(<WordCountDialog format="webnovel" onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Word count' })
    expect(cells(within(dialog).getByTestId('word-count-selection'))).toEqual(['2', '9', '8', '1'])
    const document = within(dialog).getByTestId('word-count-document')
    expect(document).toHaveTextContent('Scene 1')
    expect(cells(document)).toEqual(['5', '24', '20', '1'])
    const chapter = await within(dialog).findByTestId('word-count-chapter')
    expect(chapter).toHaveTextContent('Chapter 1')
    expect(cells(chapter)).toEqual(['600', (3300).toLocaleString(), (2700).toLocaleString(), '3'])
    expect(cells(within(dialog).getByTestId('word-count-manuscript'))).toEqual([
      (80_000).toLocaleString(),
      (440_000).toLocaleString(),
      (360_000).toLocaleString(),
      '320'
    ])
    expect(invoke).toHaveBeenCalledWith('stats:wordCount', { nodeId: 'sc-1' })
  })

  it('leaves out the selection row when nothing is selected', async () => {
    openEditor('sc-1', 'The storm broke.')
    render(<WordCountDialog format="novel" onClose={() => {}} />)
    await screen.findByTestId('word-count-manuscript')
    expect(screen.queryByTestId('word-count-selection')).toBeNull()
    expect(screen.getByTestId('word-count-document')).toBeInTheDocument()
  })

  it('without an open document, asks for the tree selection and shows no document row', async () => {
    useTreeStore.setState({ selectedId: 'ch-1' })
    render(<WordCountDialog format="novel" onClose={() => {}} />)
    expect(await screen.findByTestId('word-count-chapter')).toHaveTextContent('Chapter')
    expect(screen.queryByTestId('word-count-document')).toBeNull()
    expect(invoke).toHaveBeenCalledWith('stats:wordCount', { nodeId: 'ch-1' })
  })

  it('toasts a failed count and closes on Escape and Close', async () => {
    install(new Error('NO_PROJECT: No project is open.'))
    const onClose = vi.fn()
    render(<WordCountDialog format="novel" onClose={onClose} />)
    await vi.waitFor(() => expect(useDialogStore.getState().toasts).toHaveLength(1))
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
