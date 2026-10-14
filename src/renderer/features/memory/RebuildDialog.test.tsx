import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RebuildEstimate } from '@shared/memory/switchover'
import type { RebuildSummary } from '@shared/memory/views'
import { resetIndexingStore } from '@renderer/features/ai/indexingStore'
import { resetDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  findingViewFixture,
  installFakeMain,
  memoryStatusFixture,
  type FakeMain
} from './memoryFixture'
import { resetMemoryStore, useMemoryStore } from './memoryStore'
import { estimateLine } from './memoryView'
import { RebuildDialog, RebuildMemory } from './RebuildMemory'

/**
 * F-16.19 (plan P2a §4): *Rebuild memory* from the Book tab: the price first, nothing sent, then
 * the rebuild with its progress and Stop, then one summary grouped by sheet with *Not right* for
 * a sheet's new lines and *Not names* for the names waiting.
 */

const ESTIMATE: RebuildEstimate = {
  scenes: 90,
  requests: 180,
  tokensIn: 490_000,
  tokensOut: 61_000,
  costUsd: 0.12,
  priced: true,
  source: 'ownKey',
  fastModel: 'deepseek-v4-flash',
  strongModel: 'deepseek-v4-pro',
  minutes: 4
}
const RUNNING = {
  startedAt: '2026-10-12T10:00:00.000Z',
  finishedAt: null,
  draftId: 'd1',
  total: 90,
  done: 3
}
const FINISHED = { ...RUNNING, done: 90, finishedAt: '2026-10-12T10:04:00.000Z' }
const SUMMARY: RebuildSummary = {
  progress: FINISHED,
  sheets: [{ recordId: 'r-mara', name: 'Mara Vell', lines: 5, claimIds: ['a', 'b'] }],
  waiting: [{ norm: 'hesk', text: 'Hesk', lines: 2 }],
  topics: [
    { recordId: 's-map', kind: 'secret', label: 'the sold map' },
    { recordId: 't-heir', kind: 'thread', label: 'the missing heir' }
  ],
  findings: [findingViewFixture('f-1')]
}

let main: FakeMain

beforeEach(() => {
  resetMemoryStore()
  resetIndexingStore()
  resetDismissedStore()
  main = installFakeMain({
    'memory:rebuildEstimate': () => ESTIMATE,
    'memory:rebuild': () => ({ ok: true, queued: 90, estimate: ESTIMATE }),
    'memory:status': () => memoryStatusFixture({ rebuild: RUNNING }),
    'memory:notices': () => [],
    'memory:cardLines': () => ({}),
    'memory:rebuildSummary': () => SUMMARY,
    'memory:rebuildAction': () => ({ changed: 2 }),
    'dismissed:list': () => ({ items: [], count: 0 }),
    'jobs:cancel': () => ({
      queued: 0,
      running: null,
      failed: 0,
      done: 0,
      paused: null
    })
  })
})
afterEach(() => {
  resetMemoryStore()
  setIpcClient(null)
})

describe('Rebuild memory (F-16.19)', () => {
  it('prices first, rebuilds on confirm with progress, then shows the grouped summary', async () => {
    render(
      <>
        <RebuildMemory />
        <RebuildDialog />
      </>
    )
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Rebuild memory…' }))
    })
    const dialog = screen.getByRole('dialog', { name: 'Rebuild memory' })
    expect(await within(dialog).findByTestId('rebuild-estimate')).toHaveTextContent(
      'About 12¢ for 90 scenes (180 requests, about 4 min) on deepseek-v4-flash'
    )
    expect(main.sent('memory:rebuild')).toEqual([])
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Rebuild' }))
    })
    expect(main.sent('memory:rebuild')).toEqual([undefined])
    expect(within(dialog).getByTestId('rebuild-progress')).toHaveTextContent(
      'Reading 3 of 90 scenes'
    )
    expect(screen.getByTestId('rebuild-state')).toHaveTextContent('Rebuilding: 3 of 90 scenes read')
    // It finishes: the summary, grouped by sheet.
    await act(async () => {
      useMemoryStore.setState({ status: memoryStatusFixture({ rebuild: FINISHED }) })
    })
    const summary = await within(dialog).findByTestId('rebuild-summary')
    expect(summary).toHaveTextContent('Read 90 of 90 scenes.')
    expect(summary).toHaveTextContent('Mara Vell: 5 new lines')
    expect(summary).toHaveTextContent('Hesk: 2 lines')
    await act(async () => {
      fireEvent.click(
        within(summary).getByRole('button', { name: 'Not right: Mara Vell’s new lines' })
      )
    })
    await act(async () => {
      fireEvent.click(within(summary).getByRole('button', { name: 'Not names' }))
    })
    // F-16.22: the secrets and threads it made, one Not right for them all.
    const topics = within(summary).getByRole('group', { name: 'New secrets and threads' })
    expect(topics).toHaveTextContent('New secrets and threads (2):')
    expect(topics).toHaveTextContent('the sold map (secret)')
    expect(topics).toHaveTextContent('the missing heir (thread)')
    await act(async () => {
      fireEvent.click(
        within(topics).getByRole('button', { name: 'Not right: the new secrets and threads' })
      )
    })
    // F-16.29: the possible contradictions its sweep opened, one Not a problem for them all.
    const findings = within(summary).getByRole('group', { name: 'Possible contradictions' })
    expect(findings).toHaveTextContent('Possible contradictions (1):')
    expect(findings).toHaveTextContent('Mara Vell’s eyes: grey (1.1) · brown (1.2)')
    await act(async () => {
      fireEvent.click(
        within(findings).getByRole('button', {
          name: 'Not a problem: the possible contradictions'
        })
      )
    })
    expect(main.sent('memory:rebuildAction')).toEqual([
      { action: 'notRightAll', recordId: 'r-mara' },
      { action: 'notNames' },
      { action: 'notTopics' },
      { action: 'notProblems' }
    ])
  })

  it('stops a running rebuild with the queue’s Stop', async () => {
    useMemoryStore.setState({ status: memoryStatusFixture({ rebuild: RUNNING }) })
    act(() => useMemoryStore.getState().setRebuildOpen('summary'))
    render(<RebuildDialog />)
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
    })
    expect(main.sent('jobs:cancel')).toEqual([undefined])
  })

  it('says an unpriced model makes the price a lower bound', () => {
    expect(estimateLine({ ...ESTIMATE, priced: false, scenes: 1, minutes: 1 })).toBe(
      'About 12¢ (at least: a model’s price is unknown) for 1 scene (180 requests, about a minute) on deepseek-v4-flash'
    )
  })
})
