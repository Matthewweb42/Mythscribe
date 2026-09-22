import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ImportDialog } from './ImportDialog'
import { draftFixture } from './draftFixture'
import { resetImportStore, useImportStore } from './importStore'

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(overrides: Partial<Record<string, unknown>> = {}): void {
  invoke = vi.fn(async (channel: string, _input: unknown) => {
    if (channel in overrides) {
      const value = overrides[channel]
      if (value instanceof Error) throw value
      return value
    }
    if (channel === 'tree:list') return treeFixture
    if (channel === 'import:open') return draftFixture()
    if (channel === 'import:commit') return { nodes: [], words: 0 }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

/** Renders the dialog over a draft main has already answered with. */
async function open(): Promise<void> {
  await useImportStore.getState().open()
  render(<ImportDialog />)
}

/** The row for a node, by the id the draft gave it. */
const row = (id: string): HTMLElement => {
  const found = screen
    .getAllByTestId('import-node')
    .find((element) => element.dataset.importId === id)
  if (!found) throw new Error(`no row for ${id}`)
  return found
}

const rowTitles = (): string[] =>
  screen.getAllByTestId('import-node').map((element) => {
    const input = within(element).queryByTestId('import-rename')
    return input instanceof HTMLInputElement ? input.value : (element.textContent ?? '')
  })

beforeEach(() => {
  install()
  resetImportStore()
  useTreeStore.getState().clear()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('ImportDialog (F-12.2)', () => {
  it('shows nothing until a draft is under review', () => {
    render(<ImportDialog />)
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument()
  })

  it('shows the draft: the question, the summary, and every part, chapter, and scene', async () => {
    await open()
    const dialog = screen.getByRole('dialog', { name: 'Import “novel.docx”' })
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    expect(dialog).toHaveFocus()
    expect(screen.getByTestId('import-question')).toHaveTextContent('Does this look right?')
    expect(screen.getByTestId('import-summary')).toHaveTextContent(
      '2 parts · 2 chapters · 3 scenes · 22 words · 1 matter document'
    )
    expect(screen.getAllByTestId('import-node').map((element) => element.dataset.importId)).toEqual(
      ['p1', 'p1c1', 'p1c1s1', 'p1c1s2', 'p1c2', 'p1c2s1', 'p2', 'p2c1', 'p2c1s1']
    )
    // A scene shows its opening line and its words.
    expect(row('p1c1s1')).toHaveTextContent('The storm broke at dusk.')
    expect(row('p1c1s1')).toHaveTextContent('7')
  })

  it('renames a node inline on Enter, and leaves it alone on Escape', async () => {
    await open()
    await userEvent.click(within(row('p2c1')).getByRole('button', { name: 'Chapter Two' }))
    await userEvent.keyboard('The Return{Enter}')
    expect(useImportStore.getState().draft?.parts[1]?.chapters[0]?.title).toBe('The Return')
    expect(rowTitles()[7]).toContain('The Return')

    await userEvent.click(within(row('p1')).getByRole('button', { name: 'Part One' }))
    await userEvent.keyboard('Book One{Escape}')
    expect(useImportStore.getState().draft?.parts[0]?.title).toBe('Part One')
    expect(screen.queryByTestId('import-rename')).not.toBeInTheDocument()
  })

  it('excludes a chapter and the summary follows', async () => {
    await open()
    const exclude = within(row('p1c1')).getByTestId('import-exclude')
    expect(exclude).toHaveAccessibleName('Exclude chapter Chapter One')
    await userEvent.click(exclude)
    expect(useImportStore.getState().draft?.parts[0]?.chapters[0]?.excluded).toBe(true)
    expect(screen.getByTestId('import-summary')).toHaveTextContent('1 part · 1 chapter · 1 scene')
    expect(row('p1c1')).toHaveAttribute('data-excluded', 'true')
    // The scenes under it read as left out too.
    expect(row('p1c1s1')).toHaveAttribute('data-excluded', 'true')
  })

  it('sends a chapter to the front matter through its placement select', async () => {
    await open()
    const select = within(row('p1c2')).getByTestId('import-placement')
    expect(select).toHaveAccessibleName('Placement for Acknowledgements')
    expect(select).toHaveValue('end')
    await userEvent.selectOptions(select, 'Manuscript')
    expect(useImportStore.getState().draft?.parts[0]?.chapters[1]?.placement).toBe('manuscript')
    expect(screen.getByTestId('import-summary')).toHaveTextContent('3 chapters · 4 scenes')
  })

  it('reorders, nests, and merges through the row buttons', async () => {
    await open()
    await userEvent.click(within(row('p2')).getByRole('button', { name: 'Move Part Two up' }))
    expect(useImportStore.getState().draft?.parts.map((p) => p.id)).toEqual(['p2', 'p1'])
    await userEvent.click(
      within(row('p2c1')).getByRole('button', { name: 'Move Chapter Two to the next part' })
    )
    expect(useImportStore.getState().draft?.parts[1]?.chapters.map((c) => c.id)).toEqual([
      'p2c1',
      'p1c1',
      'p1c2'
    ])
    await userEvent.click(
      within(row('p1c1s2')).getByRole('button', { name: 'Merge Scene 2 with the scene before it' })
    )
    const chapter = useImportStore.getState().draft?.parts[1]?.chapters.find((c) => c.id === 'p1c1')
    expect(chapter?.scenes).toHaveLength(1)
    expect(chapter?.scenes[0]?.paragraphs).toHaveLength(3)
    // The first sibling cannot move up.
    expect(within(row('p2')).getByRole('button', { name: 'Move Part Two up' })).toBeDisabled()
  })

  it('splits a scene at a paragraph the author picks', async () => {
    await open()
    expect(screen.queryByTestId('import-split')).not.toBeInTheDocument()
    await userEvent.click(within(row('p2c1s1')).getByRole('button', { name: 'Split Scene 1' }))
    const splits = screen.getAllByTestId('import-split')
    expect(splits).toHaveLength(2)
    expect(splits[0]).toHaveAccessibleName('Split before paragraph 2')
    await userEvent.click(splits[1]!)
    const scenes = useImportStore.getState().draft?.parts[1]?.chapters[0]?.scenes ?? []
    expect(scenes.map((s) => s.title)).toEqual(['Scene 1', 'Scene 1 (split)'])
    expect(scenes.map((s) => s.paragraphs.length)).toEqual([2, 1])
    expect(screen.getByTestId('import-summary')).toHaveTextContent('4 scenes')
  })

  it('imports the edited draft and closes; a draft with nothing left disables Import', async () => {
    install({ 'import:commit': { nodes: [], words: 21 } })
    await open()
    await userEvent.click(within(row('p2c1')).getByRole('button', { name: 'Chapter Two' }))
    await userEvent.keyboard('The Return{Enter}')
    await userEvent.click(screen.getByTestId('import-commit'))
    await waitFor(() => expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument())
    const [channel, input] = invoke.mock.calls[1] ?? []
    expect(channel).toBe('import:commit')
    expect(input).toMatchObject({
      draft: { parts: [{ id: 'p1' }, { chapters: [{ title: 'The Return' }] }] }
    })
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'Imported 0 scenes (21 words)'
    ])
  })

  it('disables Import when every node is left out', async () => {
    await open()
    await userEvent.click(within(row('p1')).getByTestId('import-exclude'))
    await userEvent.click(within(row('p2')).getByTestId('import-exclude'))
    expect(screen.getByTestId('import-summary')).toHaveTextContent('0 scenes')
    expect(screen.getByTestId('import-commit')).toBeDisabled()
  })

  it('cancels on the button and on Escape, writing nothing', async () => {
    await open()
    await userEvent.keyboard('{Escape}')
    expect(useImportStore.getState().draft).toBeNull()
    expect(screen.queryByTestId('import-dialog')).not.toBeInTheDocument()

    cleanup()
    await open()
    await userEvent.click(screen.getByTestId('import-cancel'))
    expect(useImportStore.getState().draft).toBeNull()
    expect(invoke).not.toHaveBeenCalledWith('import:commit', expect.anything())
  })
})
