import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  computedAgeFixture,
  installFakeMain,
  timelineFixture,
  timelineRowFixture,
  type FakeMain
} from '../memoryFixture'
import { resetMemoryStore, useMemoryStore } from '../memoryStore'
import { TimelineView } from './TimelineView'

/**
 * F-16.23 (plan P2b §5.2, decision 5): the Book's Timeline: a row per readable scene with its year
 * (typed, carried, stated here, flashback, not known since a hint), the elapsed hint, the typed
 * time and the ages of who is Here; *Ages of* one character; a row opening its scene.
 */

const MARA = recordFixture('r-mara', 'character', ['Mara Vell'])
const ORRIN = recordFixture('r-orrin', 'character', ['Orrin'])
const QUAY = recordFixture('r-quay', 'setting', ['North Quay'])
const HINT = { text: 'Three winters later', nodeId: 'sc-3', ref: '1.3', breaks: true }
const WEEK = { text: 'A week later', nodeId: 'sc-2', ref: '1.2', breaks: false }

let main: FakeMain

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  useTreeStore.getState().clear()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  main = installFakeMain({
    'record:list': () => [MARA, ORRIN, QUAY],
    'memory:timeline': (input) => {
      const { recordId } = input as Input<'memory:timeline'>
      return timelineFixture({
        recordId,
        rows: [
          timelineRowFixture('sc-1', {
            time: 'December, evening',
            ages: [{ recordId: 'r-mara', age: computedAgeFixture(19) }]
          }),
          timelineRowFixture('sc-2', {
            ref: '1.2',
            title: 'The quay',
            year: { kind: 'carried', value: 1811, from: { nodeId: 'sc-1', ref: '1.1' } },
            elapsed: WEEK,
            ages: [{ recordId: 'r-mara', age: computedAgeFixture(19) }]
          }),
          timelineRowFixture('sc-3', {
            ref: '1.3',
            title: 'The heir',
            year: { kind: 'unknown', hint: HINT },
            elapsed: HINT,
            ages: [
              {
                recordId: 'r-mara',
                age: {
                  kind: 'stated',
                  value: '19',
                  claimId: 'c',
                  nodeId: 'sc-2',
                  ref: '1.2',
                  since: [HINT]
                }
              }
            ]
          }),
          timelineRowFixture('sc-4', {
            ref: '1.4',
            title: 'Winter',
            year: { kind: 'quoted', value: 1798, from: { nodeId: 'sc-4', ref: '1.4' } },
            flashback: true
          })
        ]
      })
    }
  })
  await act(async () => await useRecordStore.getState().load())
  useMemoryStore.getState().subscribe()
})
afterEach(() => {
  resetMemoryStore()
  resetRecordStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('TimelineView (F-16.23)', () => {
  it('gives each scene its year, hint, time and the ages of who is Here', async () => {
    render(<TimelineView />)
    const rows = await screen.findAllByTestId('timeline-row')
    expect(main.sent('memory:timeline')).toEqual([{ recordId: null }])
    expect(rows.map((row) => within(row).getByTestId('timeline-year').textContent)).toEqual([
      '1811',
      '1811 · from 1.1',
      'year not known since “Three winters later” (1.3)',
      'flashback · 1798'
    ])
    const [one, two, three] = rows
    expect(within(one!).getByTestId('timeline-time')).toHaveTextContent('December, evening')
    expect(within(one!).getByTestId('timeline-age')).toHaveTextContent(
      'Mara Vell about 19 · year from 1.1'
    )
    // A hint that crosses no year is shown; the scene's own breaking hint is in its year already.
    expect(within(two!).getByTestId('timeline-hint')).toHaveTextContent('“A week later” (1.2)')
    expect(within(three!).queryByTestId('timeline-hint')).toBeNull()
    expect(within(three!).getByTestId('timeline-age')).toHaveTextContent(
      'Mara Vell 19, stated in 1.2 · since then: “Three winters later” (1.3)'
    )
  })

  it('shows one character’s ages with Ages of, and opens a row’s scene', async () => {
    render(<TimelineView />)
    await screen.findAllByTestId('timeline-row')
    const pick = screen.getByRole('combobox', { name: 'Ages of' })
    expect(
      within(pick)
        .getAllByRole('option')
        .map((option) => option.textContent)
    ).toEqual(['who is Here', 'Mara Vell', 'Orrin'])
    fireEvent.change(pick, { target: { value: 'r-orrin' } })
    await waitFor(() =>
      expect(main.sent('memory:timeline')).toEqual([{ recordId: null }, { recordId: 'r-orrin' }])
    )
    fireEvent.click(within(screen.getByRole('listitem', { name: '1.2 The quay' })).getByRole('button'))
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
  })

  it('reads again when typed details or a reading move anything', async () => {
    render(<TimelineView />)
    await screen.findAllByTestId('timeline-row')
    act(() => main.emit('memory:changed', { nodeIds: ['sc-3'], recordIds: [] }))
    await waitFor(() => expect(main.sent('memory:timeline')).toHaveLength(2))
  })
})
