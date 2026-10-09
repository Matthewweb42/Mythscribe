import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ChangesTab } from './ChangesTab'
import { resetChangesStore, useChangesStore } from './changesStore'

const entry = (id: string, runId: string, over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  id,
  runId,
  createdAt: '2026-10-08T10:00:00.000Z',
  nodeId: 'sc-1',
  quote: null,
  kind: 'fact',
  entityId: 'e-mara',
  label: id,
  status: 'applied',
  ...over
})

let calls: [Channel, unknown][]

beforeEach(async () => {
  resetChangesStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'tree:list') return treeFixture as Output<C>
      if (channel === 'changes:undo') {
        const { id } = input as Input<'changes:undo'>
        if (id === 'refused') {
          throw new IpcRequestError({ code: 'VALIDATION', message: 'It is yours now.' })
        }
        return {
          entries: [entry(id, 'r1', { status: 'undone', label: 'Kael · Personality: Watchful' })],
          removedEntityIds: [],
          removedTagIds: [],
          entityIds: [],
          nodeIds: []
        } as Output<C>
      }
      if (channel === 'changes:undoRun') {
        return {
          entries: [],
          removedEntityIds: [],
          removedTagIds: [],
          entityIds: [],
          nodeIds: []
        } as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  await useTreeStore.getState().load()
})
afterEach(() => {
  resetChangesStore()
  useTreeStore.getState().clear()
})

describe('ChangesTab (F-9.13)', () => {
  it('says nothing has changed yet', () => {
    render(<ChangesTab />)
    expect(screen.getByText('Nothing yet.')).toBeInTheDocument()
  })

  it('groups the log by reading, with the scene, the passage, and Undo', async () => {
    useChangesStore.setState({
      entries: [
        entry('c1', 'r1', {
          label: 'Kael · Personality: Watchful',
          quote: 'his watchful eyes'
        }),
        entry('c2', 'r1', { kind: 'record', label: 'Kael' }),
        entry('c3', 'r0', { kind: 'tagLink', label: '#stormbound', nodeId: 'sc-2' })
      ]
    })
    render(<ChangesTab />)
    const runs = screen.getAllByRole('listitem', { name: /^Reading of / })
    expect(runs.map((run) => run.getAttribute('aria-label'))).toEqual([
      'Reading of Scene 1',
      'Reading of Scene 2'
    ])
    const fact = within(runs[0]!).getByRole('listitem', {
      name: 'Fact: Kael · Personality: Watchful'
    })
    expect(fact).toHaveTextContent('his watchful eyes')
    expect(within(fact).getByRole('button', { name: 'Go to passage in Scene 1' })).toBeVisible()
    // A reading of one change has no "Undo this run": its own Undo is the same thing.
    expect(within(runs[1]!).queryByRole('button', { name: 'Undo this run' })).toBeNull()

    await userEvent.click(within(fact).getByRole('button', { name: 'Undo' }))
    expect(calls.at(-1)).toEqual(['changes:undo', { id: 'c1' }])
    expect(within(fact).getByText('Undone')).toBeInTheDocument()
    expect(within(fact).queryByRole('button', { name: 'Undo' })).toBeNull()

    await userEvent.click(within(runs[0]!).getByRole('button', { name: 'Undo this run' }))
    expect(calls.at(-1)).toEqual(['changes:undoRun', { runId: 'r1' }])
  })

  it('toasts an undo main refuses', async () => {
    useChangesStore.setState({
      entries: [entry('refused', 'r1', { kind: 'record', label: 'Kael' })]
    })
    render(<ChangesTab />)
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(useDialogStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'It is yours now.'
    ])
  })
})
