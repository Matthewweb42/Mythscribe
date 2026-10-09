import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import type { ThreadView } from '@shared/threads'
import { resetEntityStore, useEntityStore } from '@renderer/features/entities/entityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ThreadsTab } from './ThreadsTab'
import { resetThreadStore } from './threadStore'

const event = (
  factId: string,
  name: 'opened' | 'resolved',
  nodeId: string,
  note = ''
): ThreadView['events'][number] => ({
  factId,
  event: name,
  note,
  nodeId,
  quote: null,
  origin: 'ai',
  status: 'canon'
})

const THREADS: ThreadView[] = [
  {
    entityId: 't-debt',
    name: 'The Debt',
    origin: 'ai',
    status: 'open',
    question: 'Will Mara pay?',
    setup: event('f1', 'opened', 'sc-1', 'Will Mara pay?'),
    payoff: null,
    events: [event('f1', 'opened', 'sc-1', 'Will Mara pay?')]
  },
  {
    entityId: 't-bell',
    name: 'The Bell',
    origin: 'author',
    status: 'resolved',
    question: '',
    setup: event('f2', 'opened', 'sc-1'),
    payoff: event('f3', 'resolved', 'sc-2'),
    events: [event('f2', 'opened', 'sc-1'), event('f3', 'resolved', 'sc-2')]
  }
]

let calls: [Channel, unknown][]

beforeEach(async () => {
  resetThreadStore()
  resetEntityStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'tree:list') return treeFixture as Output<C>
      if (channel === 'thread:list') return THREADS as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  await useTreeStore.getState().load()
})
afterEach(() => {
  resetThreadStore()
  resetEntityStore()
  useTreeStore.getState().clear()
})

describe('ThreadsTab (F-9.14)', () => {
  it('lists open threads first, then resolved, with the question, setup, and payoff', async () => {
    render(<ThreadsTab />)
    const open = await screen.findByRole('region', { name: 'Open threads' })
    const debt = within(open).getByRole('listitem', { name: 'The Debt' })
    expect(within(debt).getByTestId('thread-question')).toHaveTextContent('Will Mara pay?')
    expect(within(debt).getByLabelText('Added by AI')).toBeInTheDocument()
    expect(screen.getByTestId('threads-counts')).toHaveTextContent('1 open · 1 resolved')
    const resolved = screen.getByRole('region', { name: 'Resolved threads' })
    const bell = within(resolved).getByRole('listitem', { name: 'The Bell' })
    expect(bell).toHaveTextContent(/Set up in/)
    expect(bell).toHaveTextContent(/Resolved in/)
  })

  it('opens a thread’s sheet from its name and jumps to its setup scene', async () => {
    render(<ThreadsTab />)
    const debt = await screen.findByRole('listitem', { name: 'The Debt' })
    await userEvent.click(within(debt).getByRole('button', { name: 'The Debt' }))
    expect(useEntityStore.getState().selectedId).toBe('t-debt')
    const scene = within(debt).getAllByRole('button').at(-1)
    if (!scene) throw new Error('no setup jump')
    await userEvent.click(scene)
    expect(useTreeStore.getState().selectedId).toBe('sc-1')
  })

  it('says so when there are no threads yet', async () => {
    setIpcClient({
      invoke: async <C extends Channel>(channel: C): Promise<Output<C>> => {
        if (channel === 'thread:list') return [] as Output<C>
        throw new Error(`unexpected ${channel}`)
      },
      on: () => () => {}
    })
    render(<ThreadsTab />)
    expect(await screen.findByText(/No threads yet/)).toBeInTheDocument()
  })
})
