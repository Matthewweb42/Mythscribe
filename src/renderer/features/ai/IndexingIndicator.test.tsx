import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IDLE_INDEX_QUEUE, type IndexQueueStatus } from '@shared/jobs'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { IndexingIndicator } from './IndexingIndicator'
import { resetIndexingStore, useIndexingStore } from './indexingStore'

let calls: Channel[]

const status = (over: Partial<IndexQueueStatus> = {}): IndexQueueStatus => ({
  ...IDLE_INDEX_QUEUE,
  ...over
})

/** Puts main's last word on the queue into the store, as `jobs:changed` would. */
function show(over: Partial<IndexQueueStatus>): void {
  useIndexingStore.setState({ status: status(over) })
}

const indicator = (): HTMLElement | null => screen.queryByTestId('indexing')

beforeEach(() => {
  calls = []
  resetIndexingStore()
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      calls.push(channel)
      return IDLE_INDEX_QUEUE as Output<C>
    },
    on: () => () => {}
  }
  setIpcClient(client)
})

afterEach(() => {
  resetIndexingStore()
  setIpcClient(null)
})

describe('IndexingIndicator (F-5.13)', () => {
  it('renders nothing while the manuscript is indexed', () => {
    render(<IndexingIndicator />)
    expect(indicator()).toBeNull()
  })

  it('counts the job in flight against everything still to do', () => {
    show({ queued: 9, running: { kind: 'summary', nodeId: 'sc-1' }, done: 2 })
    render(<IndexingIndicator />)
    const status = screen.getByRole('status', { name: 'Indexing' })
    expect(status).toHaveTextContent('Indexing 3 of 12 scenes')
    expect(status.querySelector('.animate-spin')).not.toBeNull()
    expect(screen.getByTestId('indexing-cancel')).toHaveAccessibleName('Cancel indexing')
    expect(screen.queryByTestId('indexing-resume')).toBeNull()
  })

  it('shows a queue that has not started yet', () => {
    show({ queued: 1 })
    render(<IndexingIndicator />)
    expect(indicator()).toHaveTextContent('Indexing 0 of 1 scenes')
  })

  it('says why it paused, and offers the next step and Retry', async () => {
    show({
      queued: 4,
      paused: { code: 'NO_KEY', message: 'No API key is saved.', nextStep: 'Add a key above.' }
    })
    render(<IndexingIndicator />)
    expect(indicator()).toHaveTextContent('Indexing paused · No API key is saved.')
    expect(indicator()).toHaveAttribute('title', 'Add a key above.')
    expect(indicator()?.querySelector('.animate-spin')).toBeNull()

    await userEvent.click(screen.getByTestId('indexing-resume'))
    expect(calls).toEqual(['jobs:resume'])
  })

  it('reports the scenes that gave up, and retries them', async () => {
    show({ failed: 2, done: 3 })
    render(<IndexingIndicator />)
    expect(indicator()).toHaveTextContent('2 scenes could not be summarised')
    await userEvent.click(screen.getByTestId('indexing-resume'))
    expect(calls).toEqual(['jobs:resume'])
  })

  it('counts a single failure in the singular, and keeps counting while work is left', () => {
    show({ failed: 1 })
    const view = render(<IndexingIndicator />)
    expect(indicator()).toHaveTextContent('1 scene could not be summarised')

    // A failure while the queue still works shows the progress, not the giving up.
    show({ failed: 1, queued: 1, running: { kind: 'summary', nodeId: 'sc-2' }, done: 1 })
    view.rerender(<IndexingIndicator />)
    expect(indicator()).toHaveTextContent('Indexing 2 of 4 scenes')
    expect(screen.queryByTestId('indexing-resume')).toBeNull()
  })

  it('cancels the whole queue', async () => {
    show({ queued: 2, running: { kind: 'summary', nodeId: 'sc-1' } })
    render(<IndexingIndicator />)
    await userEvent.click(screen.getByTestId('indexing-cancel'))
    expect(calls).toEqual(['jobs:cancel'])
  })
})
