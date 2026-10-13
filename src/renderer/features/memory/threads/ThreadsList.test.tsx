import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetLayoutStore } from '@renderer/features/shell/layoutStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  installFakeMain,
  threadsMemoryFixture,
  threadStepFixture,
  threadViewFixture,
  type FakeMain
} from '../memoryFixture'
import { resetMemoryStore, useMemoryStore } from '../memoryStore'
import { ThreadsList } from './ThreadsList'

/**
 * F-16.23 (plan P2b §5.2, P2b-D22): the Book's Threads as of a scene: each thread's status and
 * steps (muted, with why, when it moves no status), the AI mark and ⓘ with *Not a thread*, the
 * scoped line for a thread with no step, *New thread*, and a reading anywhere reading them again.
 */

const HEIR = recordFixture('t-heir', 'thread', ['the missing heir'], { origin: 'ai' })
const ASHBY = recordFixture('t-ashby', 'thread', ['Ashby’s return'])

let main: FakeMain

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  resetLayoutStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  main = installFakeMain({
    'record:list': () => [ASHBY, HEIR],
    'memory:threads': (input) =>
      threadsMemoryFixture({
        asOf: (input as Input<'memory:threads'>).asOf,
        asOfRef: '1.2',
        checkedUpTo: { nodeId: 'sc-2', ref: '1.2' },
        threads: [
          threadViewFixture('t-heir', 'the missing heir', {
            last: { nodeId: 'sc-2', ref: '1.2' },
            steps: [
              threadStepFixture('st-open'),
              threadStepFixture('st-rumour', {
                step: 'advances',
                value: 'the heir is seen in town',
                nodeId: 'sc-2',
                ref: '1.2',
                voice: 'rumour',
                counted: false
              })
            ],
            later: 1
          }),
          threadViewFixture('t-ashby', 'Ashby’s return', {
            origin: 'author',
            status: 'notYet',
            opened: null,
            last: null,
            steps: [],
            defining: null
          })
        ]
      }),
    'memory:topicNotRight': () => ({ dismissed: [] }),
    'layout:set': (input) => input
  })
  await act(async () => await useRecordStore.getState().load())
  useMemoryStore.getState().subscribe()
})
afterEach(() => {
  resetMemoryStore()
  resetRecordStore()
  resetLayoutStore()
  setIpcClient(null)
})

describe('ThreadsList (F-16.23)', () => {
  it('reads the threads as of the scene: status, steps, muted ones with why', async () => {
    render(<ThreadsList asOf="sc-2" />)
    const heir = await screen.findByRole('group', { name: 'Thread: the missing heir' })
    expect(main.sent('memory:threads')).toEqual([{ asOf: 'sc-2' }])
    expect(within(heir).getByTestId('thread-head')).toHaveTextContent(
      'the missing heir · open since 1.1 · last 1.2'
    )
    expect(within(heir).getByTitle('Found by the AI in your book')).toHaveTextContent('AI')
    const [opens, rumour] = within(heir).getAllByTestId('claim-line')
    expect(opens).toHaveTextContent('opens 1.1: swears to find the heir')
    expect(rumour).toHaveTextContent('advances 1.2: the heir is seen in town')
    expect(rumour).toHaveTextContent('rumoured')
    expect(rumour?.firstChild).toHaveClass('text-fg-muted')
    // The author's thread with no step: scoped, never a fact.
    const ashby = screen.getByRole('group', { name: 'Thread: Ashby’s return' })
    expect(within(ashby).getByTestId('thread-head')).toHaveTextContent(
      'Ashby’s return · not yet in the book'
    )
    expect(within(ashby).getByTestId('thread-no-steps')).toHaveTextContent(
      'No scene shows this thread yet (checked up to 1.2)'
    )
    expect(within(ashby).queryByTitle('Found by the AI in your book')).toBeNull()
  })

  it('opens ⓘ with Not a thread on an AI-made one, a thread’s sheet, and New thread', async () => {
    render(<ThreadsList asOf={null} />)
    const heir = await screen.findByRole('group', { name: 'Thread: the missing heir' })
    fireEvent.click(
      within(heir).getByRole('button', { name: 'Where this comes from: the missing heir' })
    )
    fireEvent.click(within(heir).getByRole('button', { name: 'Not a thread' }))
    await waitFor(() =>
      expect(main.sent('memory:topicNotRight')).toEqual([{ recordId: 't-heir' }])
    )
    fireEvent.click(within(heir).getByRole('button', { name: 'the missing heir' }))
    expect(useRecordStore.getState().selectedId).toBe('t-heir')
    fireEvent.click(screen.getByRole('button', { name: 'New thread' }))
    expect(useRecordStore.getState().creating).toBe('thread')
  })

  it('reads them again when a reading moves anything', async () => {
    render(<ThreadsList asOf={null} />)
    await screen.findByRole('group', { name: 'Thread: the missing heir' })
    act(() => main.emit('memory:changed', { nodeIds: ['sc-9'], recordIds: [] }))
    await waitFor(() => expect(main.sent('memory:threads')).toHaveLength(2))
  })
})
