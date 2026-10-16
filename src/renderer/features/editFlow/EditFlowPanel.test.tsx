import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { defaultAiSettings } from '@shared/aiSettings'
import type { EditFlowDetail, EditFlowIssue, EditFlowRun } from '@shared/editFlow'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { resetAccountStore } from '@renderer/features/account/accountStore'
import { resetAiSettingsStore, useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { resetAiStore } from '@renderer/features/ai/aiStore'
import { resetEditPassStore } from '@renderer/features/editPass/editPassStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { EditFlowPanel } from './EditFlowPanel'
import { resetEditFlowStore, useEditFlowStore } from './editFlowStore'

/**
 * The edit flow's panel (notes redesign phase 2): the set-up prices the run before Run, and the
 * results group the issues by category, a fix with Accept and Reject, an issue without one with
 * Dismiss, a passage the author has since changed marked "text changed".
 */

function run(over: Partial<EditFlowRun> = {}): EditFlowRun {
  return {
    id: 'run-1',
    spec: { categories: ['copy', 'continuity'], depth: 'quick', scope: { kind: 'book', nodeId: null } },
    scopeTitle: 'the whole book',
    status: 'done',
    done: 2,
    total: 2,
    model: 'deepseek-v4-flash',
    tokensIn: 2_000,
    tokensOut: 300,
    costUsd: 0.0004,
    counts: { pending: 3, accepted: 0, rejected: 0, stale: 0 },
    dropped: 0,
    error: null,
    overview: null,
    noteEdits: [],
    createdAt: '2026-10-15T10:00:00.000Z',
    finishedAt: '2026-10-15T10:01:00.000Z',
    ...over
  }
}

function issue(over: Partial<EditFlowIssue> = {}): EditFlowIssue {
  return {
    id: 'i1',
    passId: 'run-1',
    nodeId: 'sc-1',
    kind: 'change',
    position: 0,
    original: 'She teh sea.',
    replacement: 'She saw the sea.',
    rationale: 'Typo.',
    category: null,
    flagged: false,
    violation: null,
    status: 'pending',
    proposalId: 'prop-1',
    flowCategory: 'copy',
    textChanged: false,
    ...over
  }
}

let calls: { channel: string; input: unknown }[]
let detail: EditFlowDetail

const client: IpcClient = {
  async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
    calls.push({ channel, input })
    switch (channel) {
      case 'editFlow:plan':
        return {
          scopeTitle: 'the whole book',
          scenes: 3,
          words: 2_500,
          requests: 2,
          tokensIn: 9_000,
          tokensOut: 600
        } as Output<C>
      case 'editFlow:start':
        return { ok: true, run: run({ status: 'running', done: 0 }) } as Output<C>
      case 'editFlow:get':
        return detail as Output<C>
      case 'editPass:settle':
        return [] as Output<C>
      default:
        throw new Error(`unexpected ${channel}`)
    }
  },
  on<E extends EventName>(_event: E, _listener: (payload: EventPayload<E>) => void): () => void {
    return () => undefined
  }
}

const sent = (channel: string): unknown[] =>
  calls.filter((call) => call.channel === channel).map((call) => call.input)

beforeEach(() => {
  calls = []
  detail = {
    run: run(),
    issues: [
      issue(),
      issue({
        id: 'i2',
        kind: 'note',
        replacement: null,
        original: 'Her eyes were brown',
        rationale: 'Grey on her page.',
        flowCategory: 'continuity'
      }),
      issue({ id: 'i3', original: 'The tide turned.', textChanged: true, nodeId: 'sc-2' })
    ],
    titles: { 'sc-1': 'Chapter 1 › Scene 1', 'sc-2': 'Chapter 2 › Scene 2' }
  }
  resetAccountStore()
  resetAiSettingsStore()
  resetAiStore()
  resetEditPassStore()
  resetEditFlowStore()
  resetPendingSaves()
  useAiSettingsStore.setState({ settings: { ...defaultAiSettings(), dial: 1 } })
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  setIpcClient(client)
})

afterEach(() => {
  resetAccountStore()
  resetAiSettingsStore()
  resetAiStore()
  resetEditPassStore()
  resetEditFlowStore()
  useTreeStore.setState({ ...buildIndex([]), loaded: false, selectedId: null })
  useDialogStore.setState({ toasts: [] })
})

describe('EditFlowPanel', () => {
  it('prices the whole book before Run, then shows the results grouped by category', async () => {
    useEditFlowStore.getState().openFlow({ categories: ['copy', 'continuity'], scope: 'book' })
    render(<EditFlowPanel />)
    expect(screen.getAllByTestId('edit-flow-category')).toHaveLength(9)
    expect(screen.getByLabelText(/^Copyediting/)).toBeChecked()
    expect(screen.getByLabelText(/^Continuity/)).toBeChecked()
    await waitFor(() =>
      expect(screen.getByTestId('edit-flow-price-line')).toHaveTextContent(/^With MythScribe: about/)
    )
    expect(screen.getByTestId('edit-flow-price')).toHaveTextContent('2,500 words · 2 requests')
    expect(sent('editFlow:plan')).toEqual([
      { categories: ['copy', 'continuity'], depth: 'quick', scope: { kind: 'book', nodeId: null } }
    ])

    await userEvent.click(screen.getByTestId('edit-flow-run'))
    await waitFor(() => expect(screen.getAllByTestId('edit-flow-group')).toHaveLength(2))
    const groups = screen.getAllByTestId('edit-flow-group')
    expect(groups.map((group) => group.getAttribute('data-category'))).toEqual(['copy', 'continuity'])
    expect(within(groups[0]!).getAllByTestId('edit-flow-issue')).toHaveLength(2)

    const [fix, changed] = within(groups[0]!).getAllByTestId('edit-flow-issue')
    expect(within(fix!).getByTestId('edit-flow-diff')).toBeInTheDocument()
    await userEvent.click(within(fix!).getByTestId('edit-flow-issue-reject'))
    await waitFor(() => expect(sent('editPass:settle')).toEqual([{ ids: ['i1'], status: 'rejected' }]))

    // A passage the author changed since: marked, and only dismissed.
    expect(within(changed!).getByTestId('edit-flow-issue-status')).toHaveTextContent('Text changed')
    expect(within(changed!).queryByTestId('edit-flow-issue-accept')).not.toBeInTheDocument()
    expect(within(changed!).getByTestId('edit-flow-issue-dismiss')).toBeInTheDocument()

    // An issue with no fix quotes its passage and is dismissed, never accepted.
    const note = within(groups[1]!).getByTestId('edit-flow-issue')
    expect(note).toHaveAttribute('data-kind', 'note')
    expect(within(note).getByTestId('edit-flow-issue-jump')).toHaveTextContent('“Her eyes were brown”')
    expect(within(note).queryByTestId('edit-flow-issue-accept')).not.toBeInTheDocument()
  })

  it('shows the developmental overview and Update notes’ edits with Undo', async () => {
    detail = {
      run: run({
        spec: { categories: ['developmental', 'updateNotes'], depth: 'deep', scope: { kind: 'book', nodeId: null } },
        overview: 'Strong opening; the middle sags.',
        noteEdits: [
          {
            edit: {
              kind: 'notebook',
              pageId: 'pg-1',
              title: 'Rook',
              created: true,
              versionId: null,
              section: null,
              before: '',
              after: 'Waits at the quay.'
            },
            undone: false
          }
        ]
      }),
      issues: [],
      titles: {}
    }
    useEditFlowStore.setState({ open: true })
    await useEditFlowStore.getState().show('run-1')
    render(<EditFlowPanel />)
    expect(screen.getByTestId('edit-flow-overview')).toHaveTextContent('Strong opening; the middle sags.')
    const edit = screen.getByTestId('edit-flow-note-edit')
    expect(edit).toHaveAttribute('data-status', 'applied')
    expect(edit).toHaveTextContent('Made the page “Rook”')
    expect(within(edit).getByTestId('edit-flow-note-undo')).toBeInTheDocument()
    expect(screen.queryByTestId('edit-flow-empty')).not.toBeInTheDocument()
  })
})
