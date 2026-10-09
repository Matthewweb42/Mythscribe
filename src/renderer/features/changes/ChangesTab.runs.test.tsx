import { render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ChangeEntry } from '@shared/changes'
import type { Channel, Output } from '@shared/ipc/contract'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { ChangesTab } from './ChangesTab'
import { resetChangesStore, useChangesStore } from './changesStore'

/**
 * F-9.15: a chat turn or an Organise plan is recorded one change per `changes:record` call, over
 * time, so a reading of a scene can be logged between two changes of one run. The log still
 * shows each run once ("logged as one run each, headed by their source").
 */

const entry = (id: string, runId: string, over: Partial<ChangeEntry> = {}): ChangeEntry => ({
  id,
  runId,
  createdAt: '2026-10-09T10:00:00.000Z',
  nodeId: null,
  quote: null,
  kind: 'sheetEdit',
  entityId: 'e-mara',
  label: id,
  status: 'applied',
  source: 'chat',
  undoable: true,
  ...over
})

beforeEach(() => {
  resetChangesStore()
  useTreeStore.getState().clear()
  const client: IpcClient = {
    invoke<C extends Channel>(channel: C): Promise<Output<C>> {
      return Promise.reject(new Error(`unexpected ${channel}`))
    },
    on: () => () => {}
  }
  setIpcClient(client)
})
afterEach(() => {
  resetChangesStore()
  useTreeStore.getState().clear()
})

describe('ChangesTab runs recorded over time (F-9.15)', () => {
  it('shows a chat turn once when a reading was logged between two of its changes', () => {
    useChangesStore.setState({
      entries: [
        entry('c2', 'chat:m-1', { createdAt: '2026-10-09T10:00:03.000Z', label: 'Mara · Age' }),
        entry('r1', 'reading-run', {
          createdAt: '2026-10-09T10:00:02.000Z',
          kind: 'fact',
          nodeId: 'sc-1',
          source: 'reading',
          label: 'Kael · Personality: Watchful'
        }),
        entry('c1', 'chat:m-1', { createdAt: '2026-10-09T10:00:01.000Z', label: 'Mara · Goal' })
      ]
    })
    render(<ChangesTab />)
    const chatRuns = screen.getAllByRole('listitem', { name: 'Chat' })
    expect(chatRuns).toHaveLength(1)
    expect(
      within(chatRuns[0]!)
        .getAllByRole('listitem')
        .map((row) => row.textContent)
    ).toEqual([expect.stringContaining('Mara · Age'), expect.stringContaining('Mara · Goal')])
  })
})
