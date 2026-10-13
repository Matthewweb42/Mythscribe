import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Input } from '@shared/ipc/contract'
import type { KnowsGrid as KnowsGridView } from '@shared/memory/views'
import { recordFixture } from '@renderer/features/records/recordFixture'
import { resetRecordStore, useRecordStore } from '@renderer/features/records/recordStore'
import { resetLayoutStore, useLayoutStore } from '@renderer/features/shell/layoutStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  installFakeMain,
  knowsCellFixture,
  knowsGridFixture,
  secretViewFixture,
  type FakeMain
} from '../memoryFixture'
import { resetMemoryStore, useMemoryStore } from '../memoryStore'
import { KnowsGrid } from './KnowsGrid'

/**
 * F-16.22 (plan P2b §4.2, P2b-D20): the Book's who-knows-what grid: a cell per knower and secret
 * ("overheard 1.1", "learns later (1.3)", the author's "knew before the book (you)"), an empty
 * cell's scoped title and *Knew before the book*, the author's mark's *Remove*, the rows readers
 * learn later, as of the scene asked for, and a row's label opening its sheet.
 */

const MARA = recordFixture('r-mara', 'character', ['Mara Vell'])
const TOMAS = recordFixture('r-tomas', 'character', ['Tomas'])
const ORRIN = recordFixture('r-orrin', 'character', ['Orrin'])
const QUAY = recordFixture('r-quay', 'setting', ['North Quay'])
const MAP = recordFixture('s-map', 'secret', ['the sold map'])

let main: FakeMain
let grid: KnowsGridView

const GRID = (): KnowsGridView =>
  knowsGridFixture({
    asOf: 'sc-2',
    asOfRef: '1.2',
    checkedUpTo: { nodeId: 'sc-2', ref: '1.2' },
    columns: ['r-tomas', 'r-mara', 'r-orrin', 'r-quay'],
    rows: [
      secretViewFixture('s-map', 'the sold map', {
        cells: [
          knowsCellFixture('r-tomas', { how: 'knewBefore', claimId: 'k-tomas' }),
          knowsCellFixture('r-orrin', { later: true, ref: '1.3', claimId: 'k-orrin' })
        ]
      })
    ],
    later: 1
  })

beforeEach(async () => {
  resetMemoryStore()
  resetRecordStore()
  resetLayoutStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  grid = GRID()
  main = installFakeMain({
    'record:list': () => [MARA, TOMAS, ORRIN, QUAY, MAP],
    'memory:knows': (input) => ({ ...grid, asOf: (input as Input<'memory:knows'>).asOf }),
    'memory:knewBefore': () => ({ changed: true }),
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

describe('KnowsGrid (F-16.22)', () => {
  it('reads as of the scene, a cell per knower, and the rows readers learn later', async () => {
    render(<KnowsGrid asOf="sc-2" />)
    const table = await screen.findByRole('table')
    expect(main.sent('memory:knows')).toEqual([{ asOf: 'sc-2' }])
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent)
    ).toEqual(['Secret', 'Tomas', 'Mara Vell', 'Orrin', 'North Quay'])
    expect(
      within(table).getByRole('button', { name: 'Tomas, the sold map: knew before 1.1' })
    ).toHaveTextContent('knew before 1.1')
    const later = within(table).getByRole('button', {
      name: 'Orrin, the sold map: learns later (1.3)'
    })
    expect(later).toHaveAttribute('data-later', 'true')
    // An empty cell is a dash; its title is the scoped line, never a fact.
    const empty = within(table).getByRole('button', {
      name: 'Mara Vell, the sold map: No scene shows Mara Vell learning this (checked up to 1.2)'
    })
    expect(empty).toHaveTextContent('—')
    expect(empty).toHaveAttribute(
      'title',
      'No scene shows Mara Vell learning this (checked up to 1.2)'
    )
    expect(screen.getByTestId('knows-later')).toHaveTextContent('1 more later in the book')
  })

  it('marks Knew before the book on an empty cell, and offers it only to a character or group', async () => {
    render(<KnowsGrid asOf="sc-2" />)
    const table = await screen.findByRole('table')
    fireEvent.click(within(table).getByRole('button', { name: /^Mara Vell, the sold map/ }))
    const detail = screen.getByTestId('knows-cell-detail')
    expect(detail).toHaveTextContent('No scene shows Mara Vell learning this (checked up to 1.2)')
    fireEvent.click(within(detail).getByRole('button', { name: 'Knew before the book' }))
    await waitFor(() =>
      expect(main.sent('memory:knewBefore')).toEqual([
        { secretId: 's-map', recordId: 'r-mara', knew: true }
      ])
    )
    // Main's push reads the grid again: the cell now holds her mark.
    grid = knowsGridFixture({
      ...GRID(),
      rows: [
        secretViewFixture('s-map', 'the sold map', {
          cells: [
            knowsCellFixture('r-mara', { source: 'author', claimId: null, how: 'knewBefore' })
          ]
        })
      ]
    })
    act(() => main.emit('memory:changed', { nodeIds: [], recordIds: ['s-map', 'r-mara'] }))
    const mark = await screen.findByRole('button', {
      name: 'Mara Vell, the sold map: knew before the book (you)'
    })
    fireEvent.click(mark)
    fireEvent.click(
      within(screen.getByTestId('knows-cell-detail')).getByRole('button', { name: 'Remove' })
    )
    await waitFor(() =>
      expect(main.sent('memory:knewBefore')).toContainEqual({
        secretId: 's-map',
        recordId: 'r-mara',
        knew: false
      })
    )
    // A place is no knower: its empty cell says the scoped line and offers nothing.
    fireEvent.click(screen.getByRole('button', { name: /^North Quay, the sold map/ }))
    expect(
      within(screen.getByTestId('knows-cell-detail')).queryByRole('button', {
        name: 'Knew before the book'
      })
    ).toBeNull()
  })

  it('opens a line’s ⓘ and Not right, and a row’s label opens the secret’s sheet', async () => {
    render(<KnowsGrid asOf="sc-2" />)
    const table = await screen.findByRole('table')
    fireEvent.click(within(table).getByRole('button', { name: /^Tomas, the sold map/ }))
    const detail = screen.getByTestId('knows-cell-detail')
    expect(within(detail).getByTestId('claim-line')).toHaveTextContent('Tomas: knew before (1.1)')
    expect(within(detail).getByRole('button', { name: 'Not right' })).toBeInTheDocument()
    fireEvent.click(within(table).getByRole('button', { name: 'the sold map' }))
    expect(useRecordStore.getState().selectedId).toBe('s-map')
    expect(useLayoutStore.getState().layout.sidebar.tab).toBe('secret')
  })

  it('says when no secret is known yet as of the scene', async () => {
    grid = knowsGridFixture({ asOf: 'sc-1' })
    render(<KnowsGrid asOf="sc-1" />)
    expect(await screen.findByText('No secret readers know yet at this scene.')).toBeInTheDocument()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
