import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { defaultSnapshotName, type SnapshotComparison, type SnapshotInfo } from '@shared/snapshots'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { resetGoalsStore } from '@renderer/features/goals/goalsStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SnapshotsDialog } from './SnapshotsDialog'
import { resetSnapshotStore } from './snapshotStore'

const snapshot = (id: string, name: string, over: Partial<SnapshotInfo> = {}): SnapshotInfo => ({
  id,
  name,
  note: '',
  kind: 'manual',
  scope: 'project',
  nodeId: null,
  nodeTitle: null,
  draftName: null,
  docCount: 7,
  wordCount: 4800,
  created: '2026-10-05T10:00:00.000Z',
  ...over
})

const LIST: SnapshotInfo[] = [
  snapshot('s3', 'Before restoring "Old"', { kind: 'auto', docCount: 1, wordCount: 3 }),
  snapshot('s2', 'Act one done', {
    kind: 'milestone',
    scope: 'document',
    nodeId: 'sc-1',
    nodeTitle: 'Scene 1',
    docCount: 1,
    wordCount: 1,
    note: 'Before the rewrite.'
  }),
  snapshot('s1', 'Old')
]

const COMPARISON: SnapshotComparison = {
  snapshotId: 's1',
  againstId: null,
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
  unchanged: 6
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(answers: Partial<Record<string, unknown>> = {}): void {
  invoke = vi.fn(async (channel: string) => {
    if (channel in answers) return answers[channel]
    if (channel === 'snapshots:list') return LIST
    if (channel === 'snapshots:compare') return COMPARISON
    if (channel === 'snapshots:restore')
      return { snapshots: LIST, changed: [{ id: 'sc-1', wordCount: 3 }] }
    if (
      channel === 'snapshots:take' ||
      channel === 'snapshots:update' ||
      channel === 'snapshots:delete'
    )
      return LIST
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

/** Answers the open confirm with `value` and returns its options. */
async function answerConfirm(value: boolean): Promise<Record<string, unknown>> {
  await waitFor(() => expect(useDialogStore.getState().modals).toHaveLength(1))
  const modal = useDialogStore.getState().modals[0]!
  if (modal.kind === 'confirm') useDialogStore.getState().resolveConfirm(modal.id, value)
  return { ...modal.options }
}

const rowOf = async (name: string): Promise<HTMLElement> => {
  const list = await screen.findByRole('list', { name: 'Snapshots' })
  const row = within(list)
    .getAllByRole('listitem')
    .find((li) => within(li).queryByText(name) !== null)
  if (!row) throw new Error(`no row ${name}`)
  return row
}

beforeEach(() => {
  resetSnapshotStore()
  resetDocumentStore()
  resetEntityStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true, selectedId: 'sc-1' })
  useDialogStore.setState({ modals: [], toasts: [] })
  install()
})
afterEach(() => {
  resetSnapshotStore()
  resetDocumentStore()
  resetEntityStore()
  resetGoalsStore()
  resetPendingSaves()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('SnapshotsDialog (F-8.6)', () => {
  it('lists the snapshots newest first with their kind, scope, words, and note', async () => {
    render(<SnapshotsDialog onClose={() => {}} />)
    const list = await screen.findByRole('list', { name: 'Snapshots' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('Before restoring "Old"Auto')
    expect(rows[0]).toHaveTextContent('Whole project · 1 document')
    expect(rows[1]).toHaveTextContent('Act one doneMilestoneScene 1')
    expect(rows[1]).toHaveTextContent('1 word')
    expect(rows[1]).toHaveTextContent('Before the rewrite.')
    expect(rows[2]).toHaveTextContent('Whole project · 7 documents')
    expect(rows[2]).toHaveTextContent('4,800 words')
    expect(invoke).toHaveBeenCalledWith('snapshots:list', undefined)
  })

  it('filters to the open document’s snapshots and to milestones', async () => {
    useTreeStore.setState({ selectedId: 'sc-2' })
    render(<SnapshotsDialog onClose={() => {}} />)
    await screen.findByRole('list', { name: 'Snapshots' })
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'milestones')
    expect(
      within(screen.getByRole('list', { name: 'Snapshots' })).getAllByRole('listitem')
    ).toHaveLength(1)
    await userEvent.selectOptions(screen.getByLabelText('Show'), 'document')
    expect(screen.getByText('No snapshots match.')).toBeInTheDocument()
  })

  it('takes a snapshot of the open document, prefilled with the default name', async () => {
    render(<SnapshotsDialog onClose={() => {}} />)
    await screen.findByRole('list', { name: 'Snapshots' })
    const form = screen.getByRole('form', { name: 'Take snapshot' })
    const name = within(form).getByLabelText('Name')
    expect((name as HTMLInputElement).value).toMatch(/^Snapshot \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
    expect(within(form).getByRole('radio', { name: 'This document (Scene 1)' })).toBeChecked()
    await userEvent.clear(name)
    await userEvent.type(name, 'Before edits')
    await userEvent.type(within(form).getByLabelText('Note'), 'Clean copy')
    await userEvent.click(within(form).getByRole('checkbox', { name: 'Milestone' }))
    await userEvent.click(within(form).getByRole('button', { name: 'Take snapshot' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('snapshots:take', {
        scope: 'document',
        nodeId: 'sc-1',
        name: 'Before edits',
        note: 'Clean copy',
        milestone: true
      })
    )
    await waitFor(() => expect(within(form).getByLabelText('Note')).toHaveValue(''))
  })

  it('takes a whole-project snapshot when no document is open', async () => {
    useTreeStore.setState({ selectedId: null })
    render(<SnapshotsDialog onClose={() => {}} />)
    await screen.findByRole('list', { name: 'Snapshots' })
    const form = screen.getByRole('form', { name: 'Take snapshot' })
    expect(within(form).getByRole('radio', { name: 'This document' })).toBeDisabled()
    expect(within(form).getByRole('radio', { name: 'Whole project' })).toBeChecked()
    await userEvent.click(within(form).getByRole('button', { name: 'Take snapshot' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith(
        'snapshots:take',
        expect.objectContaining({ scope: 'project', milestone: false })
      )
    )
    expect(defaultSnapshotName(new Date(2026, 9, 5, 9, 4))).toBe('Snapshot 2026-10-05 09:04')
  })

  it('restores and deletes only after a danger confirm', async () => {
    render(<SnapshotsDialog onClose={() => {}} />)
    const old = await rowOf('Old')
    await userEvent.click(within(old).getByRole('button', { name: 'Restore Old…' }))
    expect(await answerConfirm(false)).toMatchObject({ title: 'Restore "Old"?', danger: true })
    expect(invoke).not.toHaveBeenCalledWith('snapshots:restore', expect.anything())
    await userEvent.click(within(old).getByRole('button', { name: 'Restore Old…' }))
    await answerConfirm(true)
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('snapshots:restore', { id: 's1' }))
    expect(useTreeStore.getState().byId['sc-1']?.wordCount).toBe(3)

    await userEvent.click(within(await rowOf('Old')).getByRole('button', { name: 'Delete Old…' }))
    expect(await answerConfirm(true)).toMatchObject({ title: 'Delete "Old"?', danger: true })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('snapshots:delete', { id: 's1' }))
  })

  it('edits the name, note, and milestone flag inline, sending only what changed', async () => {
    render(<SnapshotsDialog onClose={() => {}} />)
    const auto = await rowOf('Before restoring "Old"')
    await userEvent.click(
      within(auto).getByRole('button', { name: 'Edit Before restoring "Old"…' })
    )
    const form = within(auto).getByRole('form', { name: 'Edit Before restoring "Old"' })
    await userEvent.type(within(form).getByLabelText('Note'), 'Keep')
    await userEvent.click(within(form).getByRole('button', { name: 'Save' }))
    // An automatic snapshot left unflagged stays automatic: no `milestone` is sent.
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('snapshots:update', { id: 's3', note: 'Keep' })
    )

    const milestone = await rowOf('Act one done')
    await userEvent.click(within(milestone).getByRole('button', { name: 'Edit Act one done…' }))
    const edit = within(milestone).getByRole('form', { name: 'Edit Act one done' })
    await userEvent.click(within(edit).getByRole('checkbox', { name: 'Milestone' }))
    await userEvent.click(within(edit).getByRole('button', { name: 'Save' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('snapshots:update', { id: 's2', milestone: false })
    )
  })

  it('compares with the current text and restores a document, then all after a confirm', async () => {
    render(<SnapshotsDialog onClose={() => {}} />)
    await userEvent.click(
      within(await rowOf('Old')).getByRole('button', { name: 'Compare Old with current' })
    )
    expect(screen.getByRole('heading', { name: 'Compare snapshots' })).toBeInTheDocument()
    const scene = await screen.findByRole('region', { name: 'Scene 1' })
    expect(invoke).toHaveBeenCalledWith('snapshots:compare', { id: 's1' })
    expect(within(scene).getByText('came').tagName).toBe('DEL')
    expect(within(scene).getByText('broke').tagName).toBe('INS')
    expect(screen.getByTestId('snapshot-compare-summary')).toHaveTextContent(
      '1 document differs, 6 read the same.'
    )
    expect(screen.getByLabelText('Against')).toHaveValue('')

    await userEvent.click(within(scene).getByRole('button', { name: 'Restore this document' }))
    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('snapshots:restore', { id: 's1', nodeIds: ['sc-1'] })
    )
    await waitFor(() =>
      expect(invoke.mock.calls.filter(([c]) => c === 'snapshots:compare')).toHaveLength(2)
    )

    await userEvent.click(await screen.findByRole('button', { name: 'Restore all…' }))
    expect(await answerConfirm(true)).toMatchObject({ confirmLabel: 'Restore all', danger: true })
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('snapshots:restore', { id: 's1' }))

    await userEvent.click(screen.getByRole('button', { name: 'Back to snapshots' }))
    expect(screen.getByRole('list', { name: 'Snapshots' })).toBeInTheDocument()
  })

  it('compares two snapshots without offering a restore', async () => {
    render(<SnapshotsDialog onClose={() => {}} />)
    await userEvent.click(
      within(await rowOf('Old')).getByRole('button', { name: 'Compare Old with current' })
    )
    await screen.findByRole('region', { name: 'Scene 1' })
    await userEvent.selectOptions(screen.getByLabelText('Against'), 's2')
    await waitFor(() =>
      expect(invoke).toHaveBeenLastCalledWith('snapshots:compare', { id: 's1', againstId: 's2' })
    )
    await screen.findByRole('region', { name: 'Scene 1' })
    expect(screen.queryByRole('button', { name: /Restore/ })).toBeNull()
  })

  it('shows the cause when the comparison fails', async () => {
    invoke.mockImplementation(async (channel: string) => {
      if (channel === 'snapshots:list') return LIST
      throw new Error('disk gone')
    })
    render(<SnapshotsDialog onClose={() => {}} />)
    await userEvent.click(
      within(await rowOf('Old')).getByRole('button', { name: 'Compare Old with current' })
    )
    expect(await screen.findByRole('alert')).toHaveTextContent('disk gone')
  })
})
