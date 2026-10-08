import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetNotesStore } from '@renderer/features/editor/notesStore'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import { useBookDetailsStore } from './bookDetailsStore'
import { callsTo, installFakeCompileMain, type FakeCompileMain } from './compileTestIpc'
import { CompileWindow } from './CompileWindow'
import { resetCompileWindowStore, useCompileWindowStore } from './compileWindowStore'

let fake: FakeCompileMain

function reset(): void {
  resetCompileWindowStore()
  useBookDetailsStore.getState().clear()
  resetDocumentStore()
  resetSceneMetaStore()
  resetNotesStore()
  resetEntityStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
}

beforeEach(() => {
  reset()
  fake = installFakeCompileMain()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: 'sc-1' })
})
afterEach(() => {
  reset()
  setIpcClient(null)
})

async function open(): Promise<{ user: ReturnType<typeof userEvent.setup>; onClose: () => void }> {
  const user = userEvent.setup()
  const onClose = vi.fn()
  render(<CompileWindow onClose={onClose} />)
  await waitFor(() => expect(useCompileWindowStore.getState().ready).toBe(true))
  return { user, onClose }
}

const formats = () => screen.getByRole('navigation', { name: 'Formats' })

describe('CompileWindow (F-12.4)', () => {
  it('lists the formats, opens on the project’s, and keeps a built-in read-only', async () => {
    const { user } = await open()
    const builtIn = within(formats()).getByRole('region', { name: 'Built-in' })
    expect(
      within(builtIn)
        .getAllByRole('button')
        .map((b) => b.textContent)
    ).toEqual([
      'Standard Manuscript',
      'Paperback 6 × 9',
      'Paperback 5 × 8',
      'Ebook',
      'Editor copy',
      'Outline',
      'Plain text'
    ])
    expect(within(builtIn).getByRole('button', { name: 'Standard Manuscript' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(screen.getByText(/None yet: duplicate a format/)).toBeInTheDocument()
    expect(screen.getByRole('combobox', { name: 'Compile for' })).toHaveValue('docx')
    expect(screen.getByText(/Built-in formats are read-only/)).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: 'Page setup' }))
    expect(screen.getByRole('spinbutton', { name: 'Gutter' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull()
    await user.click(screen.getByRole('tab', { name: 'Section layouts' }))
    // The level picker still reads each level of a built-in.
    await user.click(screen.getByText('Part'))
    expect(screen.getByRole('combobox', { name: 'Case' })).toHaveValue('upper')
    expect(screen.getByRole('combobox', { name: 'Case' })).toBeDisabled()
  })

  it('duplicates a built-in into My formats, edits it, and saves it', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('button', { name: 'Duplicate' }))
    const mine = within(formats()).getByRole('region', { name: 'My formats' })
    await waitFor(() =>
      expect(
        within(mine).getByRole('button', { name: 'Standard Manuscript copy' })
      ).toHaveAttribute('aria-pressed', 'true')
    )
    await user.click(screen.getByRole('tab', { name: 'Page setup' }))
    const gutter = screen.getByRole('spinbutton', { name: 'Gutter' })
    expect(gutter).toBeEnabled()
    await user.clear(gutter)
    await user.type(gutter, '0.25')
    expect(screen.getByTestId('compile-format-name')).toHaveTextContent(
      'Standard Manuscript copy (edited)'
    )
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(fake.library[0]?.pageSetup.gutter).toBe(0.25))
    expect(screen.getByTestId('compile-format-name')).toHaveTextContent(
      /^Standard Manuscript copy$/
    )
  })

  it('asks before leaving unsaved changes for another format', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('button', { name: 'Duplicate' }))
    await user.click(screen.getByRole('tab', { name: 'Typography' }))
    await user.click(await screen.findByRole('checkbox', { name: 'Justify' }))
    await user.click(within(formats()).getByRole('button', { name: 'Ebook' }))
    const confirm = useDialogStore.getState().modals[0]
    expect(confirm?.kind).toBe('confirm')
    if (confirm?.kind === 'confirm') useDialogStore.getState().resolveConfirm(confirm.id, false)
    await waitFor(() => expect(useCompileWindowStore.getState().formatId).toMatch(/^user:/))
  })

  it('ticks Include in compile per document and picks the scope', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('checkbox', { name: 'Include Chapter 4' }))
    expect(screen.getByRole('checkbox', { name: 'Include Scene 4' })).toBeDisabled()
    await waitFor(() => expect(fake.state.excluded).toEqual(['ch-4']))
    await user.click(screen.getByRole('radio', { name: 'Selected chapters' }))
    await user.click(
      within(screen.getByRole('group', { name: 'Chapters' })).getByRole('checkbox', {
        name: 'Chapter 2'
      })
    )
    await waitFor(() => expect(fake.state.scope).toEqual({ kind: 'chapters', ids: ['ch-2'] }))
    await user.click(screen.getByRole('radio', { name: 'Current document (Scene 1)' }))
    await user.click(screen.getByRole('button', { name: 'Compile' }))
    await waitFor(() =>
      expect(callsTo(fake, 'compile:run')[0]).toMatchObject({
        scope: { kind: 'document', id: 'sc-1' },
        output: 'docx'
      })
    )
  })

  it('compiles into the chosen output, shows progress, and closes on success', async () => {
    const { user, onClose } = await open()
    fake.holdRun = true
    await user.selectOptions(screen.getByRole('combobox', { name: 'Compile for' }), 'pdf')
    await user.click(screen.getByRole('button', { name: 'Compile' }))
    await waitFor(() => expect(screen.getByTestId('compile-progress')).toBeInTheDocument())
    expect(screen.getByText('Collecting…')).toBeInTheDocument()
    fake.finishRun?.()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(callsTo(fake, 'compile:run')[0]).toMatchObject({ output: 'pdf' })
    expect(useDialogStore.getState().toasts[0]?.message).toBe('Compiled to /books/Book.docx')
  })

  it('opens the Book details page over the window', async () => {
    const { user } = await open()
    await user.click(screen.getByRole('button', { name: 'Book details…' }))
    expect(await screen.findByRole('dialog', { name: 'Book details' })).toBeInTheDocument()
    expect(screen.getByRole('dialog', { name: 'Compile' })).toBeInTheDocument()
  })
})
