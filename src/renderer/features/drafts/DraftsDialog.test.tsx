import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DraftComparison, DraftInfo, DraftList } from '@shared/drafts'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import {
  resetShellDialogStore,
  useShellDialogStore
} from '@renderer/features/shell/shellDialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { DraftsDialog } from './DraftsDialog'
import { DraftStatus } from './DraftStatus'
import { resetDraftStore, useDraftStore } from './draftStore'

const draft = (id: string, name: string, active: boolean, wordCount: number): DraftInfo => ({
  id,
  name,
  wordCount,
  active,
  created: '2026-10-04T10:00:00.000Z',
  modified: '2026-10-04T10:00:00.000Z'
})

const TWO: DraftList = {
  drafts: [draft('d1', 'Draft 1', true, 1234), draft('d2', 'Draft 2', false, 1)],
  activeId: 'd1'
}

const COMPARISON: DraftComparison = {
  fromId: 'd2',
  toId: 'd1',
  docs: [
    {
      nodeId: 'sc-1',
      title: 'Scene 1',
      path: ['Arc 1', 'Chapter 1'],
      segments: [
        { op: 'same', text: 'The storm ' },
        { op: 'del', text: 'came' },
        { op: 'add', text: 'broke' },
        { op: 'same', text: ' at dusk.' }
      ],
      wordsAdded: 1,
      wordsRemoved: 1
    }
  ],
  unchanged: 5
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(answers: Partial<Record<string, unknown>> = {}): void {
  invoke = vi.fn(async (channel: string) => {
    if (channel in answers) return answers[channel]
    if (channel === 'drafts:list') return TWO
    if (channel === 'drafts:compare') return COMPARISON
    if (channel === 'drafts:revert') return { list: TWO, changed: [{ id: 'sc-1', wordCount: 3 }] }
    if (channel === 'drafts:duplicate' || channel === 'drafts:delete') return TWO
    if (channel === 'document:get') return { id: 'x', content: null }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

/** The open modal of the dialog service, answered with `value`; answers its options. */
async function answerModal(value: boolean | string): Promise<Record<string, unknown>> {
  await waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
  const modal = useDialogStore.getState().modals[0]!
  if (modal.kind === 'confirm') useDialogStore.getState().resolveConfirm(modal.id, value === true)
  else useDialogStore.getState().resolvePrompt(modal.id, typeof value === 'string' ? value : null)
  return { ...modal.options }
}

beforeEach(() => {
  resetDraftStore()
  resetDocumentStore()
  resetGoalsStore()
  resetPendingSaves()
  resetShellDialogStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})
afterEach(() => {
  resetDraftStore()
  resetDocumentStore()
  resetGoalsStore()
  resetShellDialogStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('DraftsDialog (F-8.5)', () => {
  it('lists the drafts with word counts, the active one marked and not deletable', async () => {
    render(<DraftsDialog onClose={() => {}} />)
    const list = await screen.findByRole('list', { name: 'Drafts' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveAttribute('aria-current', 'true')
    expect(rows[0]).toHaveTextContent('Draft 1Active1,234 words')
    expect(rows[1]).toHaveTextContent('Draft 21 word')
    expect(screen.queryByRole('button', { name: 'Switch to Draft 1' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Delete Draft 1…' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Delete Draft 2…' })).toBeEnabled()
    expect(invoke).toHaveBeenCalledWith('drafts:list', undefined)
  })

  it('switches to another draft', async () => {
    install({
      'drafts:switch': {
        list: {
          drafts: [draft('d1', 'Draft 1', false, 1234), draft('d2', 'Draft 2', true, 1)],
          activeId: 'd2'
        },
        changed: []
      }
    })
    render(<DraftsDialog onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Switch to Draft 2' }))
    expect(invoke).toHaveBeenCalledWith('drafts:switch', { id: 'd2' })
    expect(await screen.findByRole('button', { name: 'Switch to Draft 1' })).toBeEnabled()
  })

  it('duplicates under the offered "Draft N+1" name or the one typed', async () => {
    render(<DraftsDialog onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Duplicate Draft 1…' }))
    const options = await answerModal('Final')
    expect(options.initialValue).toBe('Draft 3')
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('drafts:duplicate', { id: 'd1', name: 'Final' })
    )
  })

  it('deletes an inactive draft only after a danger confirm', async () => {
    render(<DraftsDialog onClose={() => {}} />)
    await userEvent.click(await screen.findByRole('button', { name: 'Delete Draft 2…' }))
    expect(await answerModal(false)).toMatchObject({ title: 'Delete "Draft 2"?', danger: true })
    expect(invoke).not.toHaveBeenCalledWith('drafts:delete', expect.anything())
    await userEvent.click(screen.getByRole('button', { name: 'Delete Draft 2…' }))
    await answerModal(true)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('drafts:delete', { id: 'd2' }))
  })

  it('compares with the current draft and reverts a scene, then everything after a confirm', async () => {
    render(<DraftsDialog onClose={() => {}} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Compare Draft 2 with current' })
    )
    expect(screen.getByRole('heading', { name: 'Compare drafts' })).toBeInTheDocument()
    const scene = await screen.findByRole('region', { name: 'Scene 1' })
    expect(invoke).toHaveBeenCalledWith('drafts:compare', { fromId: 'd2', toId: 'd1' })
    expect(within(scene).getByText('came').tagName).toBe('DEL')
    expect(within(scene).getByText('broke').tagName).toBe('INS')
    expect(scene).toHaveTextContent('Arc 1 › Chapter 1 › Scene 1')
    expect(screen.getByTestId('draft-compare-summary')).toHaveTextContent(
      '1 scene differs, 5 read the same.'
    )
    expect(screen.getByLabelText('From')).toHaveValue('d2')
    expect(screen.getByLabelText('To')).toHaveValue('d1')

    await userEvent.click(
      within(scene).getByRole('button', { name: 'Revert this scene to "Draft 2"' })
    )
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('drafts:revert', { fromId: 'd2', nodeIds: ['sc-1'] })
    )
    expect(useTreeStore.getState().byId['sc-1']?.wordCount).toBe(3)
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'drafts:compare')).toHaveLength(2)
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Revert all to "Draft 2"…' }))
    expect(await answerModal(true)).toMatchObject({ confirmLabel: 'Revert all', danger: true })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('drafts:revert', { fromId: 'd2' }))

    await userEvent.click(screen.getByRole('button', { name: 'Back to drafts' }))
    expect(screen.getByRole('list', { name: 'Drafts' })).toBeInTheDocument()
  })

  it('asks for two different drafts and offers no revert between two inactive ones', async () => {
    install({
      'drafts:list': {
        drafts: [...TWO.drafts, draft('d3', 'Draft 3', false, 9)],
        activeId: 'd1'
      }
    })
    render(<DraftsDialog onClose={() => {}} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Compare Draft 2 with current' })
    )
    await userEvent.selectOptions(screen.getByLabelText('To'), 'd2')
    expect(screen.getByText('Pick two different drafts.')).toBeInTheDocument()
    await userEvent.selectOptions(screen.getByLabelText('To'), 'd3')
    await screen.findByRole('region', { name: 'Scene 1' })
    expect(invoke).toHaveBeenLastCalledWith('drafts:compare', { fromId: 'd2', toId: 'd3' })
    expect(screen.queryByRole('button', { name: /Revert/ })).toBeNull()
  })

  it('shows the cause when the comparison fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'drafts:list') return TWO
      throw new Error('disk gone')
    })
    render(<DraftsDialog onClose={() => {}} />)
    await userEvent.click(
      await screen.findByRole('button', { name: 'Compare Draft 2 with current' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('disk gone')
  })
})

describe('DraftStatus (F-8.5)', () => {
  it('names the active draft only once there are two, and opens the dialog', async () => {
    useDraftStore.setState({ drafts: [TWO.drafts[0]!], activeId: 'd1' })
    const { rerender } = render(<DraftStatus />)
    expect(screen.queryByTestId('status-draft')).toBeNull()
    useDraftStore.setState({ drafts: TWO.drafts, activeId: 'd1' })
    rerender(<DraftStatus />)
    expect(screen.getByTestId('status-draft')).toHaveTextContent('Draft 1')
    await userEvent.click(screen.getByTestId('status-draft'))
    expect(useShellDialogStore.getState().open).toBe('drafts')
  })
})
