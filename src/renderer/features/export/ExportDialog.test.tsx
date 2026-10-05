import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultExportFormatting, type ExportProgress } from '@shared/bookExport'
import { defaultEditorSettings } from '@shared/editorSettings'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import {
  resetEditorSettingsStore,
  useEditorSettingsStore
} from '@renderer/features/editor/settingsStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ExportDialog } from './ExportDialog'
import { resetExportStore, useExportStore } from './exportStore'

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>
/** The listener `export:progress` was subscribed with, so a test can push a step. */
let pushProgress: ((progress: ExportProgress) => void) | null = null
/** Settles the pending `export:run`. */
let finishRun: ((answer: unknown) => void) | null = null
let failRun: ((err: Error) => void) | null = null

function install(): void {
  pushProgress = null
  finishRun = null
  failRun = null
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'export:run')
      return new Promise((resolve, reject) => {
        finishRun = resolve
        failRun = reject
      })
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: <E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void) => {
      if (event !== 'export:progress') return () => {}
      pushProgress = (progress) => listener(progress as EventPayload<E>)
      return () => {
        pushProgress = null
      }
    }
  }
  setIpcClient(client)
}

const runInput = (): { options: unknown; requestId: string } => {
  const call = invoke.mock.calls.find(([channel]) => channel === 'export:run')
  if (!call) throw new Error('export:run was not called')
  return call[1] as { options: unknown; requestId: string }
}

const exportButton = (): HTMLElement => screen.getByRole('button', { name: 'Export' })

function setup(selectedId: string | null = 'sc-1'): ReturnType<typeof userEvent.setup> {
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId })
  return userEvent.setup()
}

function reset(): void {
  resetExportStore()
  resetDocumentStore()
  resetSceneMetaStore()
  resetEditorSettingsStore()
  resetEntityStore()
  useTreeStore.getState().clear()
}

beforeEach(() => {
  reset()
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})
afterEach(() => {
  reset()
  setIpcClient(null)
})

describe('ExportDialog (F-12.1)', () => {
  it('sends the chosen format, scope, and formatting to export:run, then closes and toasts the path', async () => {
    const user = setup()
    useEditorSettingsStore.setState({
      settings: { ...defaultEditorSettings('novel'), sceneBreak: '~' }
    })
    const onClose = vi.fn()
    render(<ExportDialog format="novel" onClose={onClose} />)
    await user.click(screen.getByRole('radio', { name: 'Markdown' }))
    expect(screen.getByLabelText('Font')).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'End matter' }))
    await user.click(exportButton())

    await waitFor(() => expect(finishRun).not.toBeNull())
    const { options, requestId } = runInput()
    expect(options).toEqual({
      format: 'md',
      scope: { kind: 'manuscript' },
      includeFront: true,
      includeEnd: false,
      formatting: defaultExportFormatting('~')
    })
    expect(requestId).not.toBe('')
    expect(exportButton()).toBeDisabled()

    act(() => finishRun?.({ path: '/books/Novel.md', format: 'md', words: 12 }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
      'Exported to /books/Novel.md'
    ])
    expect(useExportStore.getState().status).toBe('idle')
  })

  it('enables Export for selected chapters only once one is ticked, and sends those ids', async () => {
    const user = setup()
    render(<ExportDialog format="novel" onClose={() => {}} />)
    await user.click(screen.getByRole('radio', { name: 'Selected chapters' }))
    const list = screen.getByRole('group', { name: 'Chapters' })
    expect(within(list).getByText('Arc 2')).toBeInTheDocument()
    expect(exportButton()).toBeDisabled()
    await user.click(within(list).getByRole('checkbox', { name: 'Chapter 4' }))
    expect(exportButton()).toBeEnabled()
    await user.click(exportButton())
    await waitFor(() => expect(finishRun).not.toBeNull())
    expect(runInput().options).toMatchObject({ scope: { kind: 'chapters', ids: ['ch-4'] } })
    act(() => finishRun?.(null))
  })

  it('exports the open document alone, without front or end matter, and is disabled with none open', async () => {
    const user = setup()
    const { unmount } = render(<ExportDialog format="novel" onClose={() => {}} />)
    await user.click(screen.getByRole('radio', { name: 'Current document (Scene 1)' }))
    expect(screen.getByRole('checkbox', { name: 'Front matter' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'Front matter' })).not.toBeChecked()
    unmount()

    useTreeStore.setState({ selectedId: 'ch-1' })
    render(<ExportDialog format="novel" onClose={() => {}} />)
    expect(screen.getByRole('radio', { name: 'Current document' })).toBeDisabled()
    expect(screen.getByText('Open a document to export it alone.')).toBeInTheDocument()
    expect(exportButton()).toBeDisabled()
  })

  it('shows main’s progress per stage while the export runs', async () => {
    const user = setup()
    render(<ExportDialog format="novel" onClose={() => {}} />)
    await user.click(exportButton())
    await waitFor(() => expect(finishRun).not.toBeNull())
    expect(screen.getByRole('progressbar')).toBeInTheDocument()
    expect(screen.getByText('Collecting…')).toBeInTheDocument()
    const { requestId } = runInput()

    act(() => pushProgress?.({ requestId: 'someone-else', stage: 'write', done: 0, total: 1 }))
    expect(screen.getByText('Collecting…')).toBeInTheDocument()
    act(() => pushProgress?.({ requestId, stage: 'render', done: 2, total: 5 }))
    expect(screen.getByText('Rendering 2 of 5…')).toBeInTheDocument()
    expect(screen.getByTestId('export-progress')).toHaveAttribute('value', '2')
    act(() => pushProgress?.({ requestId, stage: 'write', done: 0, total: 1 }))
    expect(screen.getByText('Writing file…')).toBeInTheDocument()

    act(() => finishRun?.(null))
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull())
    expect(useDialogStore.getState().toasts).toEqual([])
    expect(pushProgress).toBeNull()
  })

  it('shows a failure as an alert and stays open', async () => {
    const user = setup()
    const onClose = vi.fn()
    render(<ExportDialog format="novel" onClose={onClose} />)
    await user.click(exportButton())
    await waitFor(() => expect(failRun).not.toBeNull())
    act(() => failRun?.(new Error('Nothing to export.')))
    expect(await screen.findByRole('alert')).toHaveTextContent('Nothing to export.')
    expect(onClose).not.toHaveBeenCalled()
    expect(exportButton()).toBeEnabled()
  })
})
