import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Dismissed } from '@shared/memory/dismissed'
import type { CheckEstimate, CheckReport } from '@shared/memory/views'
import { resetActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { buildIndex, useTreeStore } from '@renderer/features/manuscript/treeStore'
import { resetPendingSaves } from '@renderer/features/project/pendingSaves'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { resetDismissedStore } from '@renderer/features/thisScene/dismissedStore'
import { setIpcClient } from '@renderer/lib/ipc'
import {
  checkEstimateFixture,
  checkReportFixture,
  findingViewFixture,
  installFakeMain,
  memoryStatusFixture,
  type FakeMain
} from '../memoryFixture'
import { resetMemoryStore, useMemoryStore } from '../memoryStore'
import { CheckBookDialog, CheckTheBook } from './CheckBook'

/**
 * F-16.30 (plan P4 §4): *Check the book* from the Book tab: "Last checked … · n found", the dialog
 * with the price first (about and at most, or free), what it checks and does not, *Check* /
 * *Cancel*, its progress, then the report: found, unclear, checked, not checked (travel times),
 * hidden as flashbacks with *Not a flashback?*, and the secrets nobody learns, scoped.
 */

let main: FakeMain
let estimate: CheckEstimate
let report: CheckReport | null

const flashbackRow: Dismissed = {
  id: 'd-fb',
  kind: 'notRight',
  key: 'card|sc-3|flashback|yes',
  recordId: null,
  nodeId: 'sc-3',
  label: '1.3: flashback: not right',
  quote: null,
  created: '2026-10-14T10:00:00.000Z'
}

beforeEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetPendingSaves()
  // A jump one test starts must not land in the next one's editor.
  resetActiveEditorStore()
  useTreeStore.setState({ ...buildIndex(treeFixture), loaded: true })
  useDialogStore.setState({ modals: [], toasts: [] })
  estimate = checkEstimateFixture()
  report = null
  main = installFakeMain({
    'memory:checkEstimate': () => estimate,
    'memory:checkBook': () => ({ ok: true, estimate }),
    'memory:checkReport': () => report,
    'memory:cardNotRight': () => flashbackRow
  })
  useMemoryStore.getState().subscribe()
})
afterEach(() => {
  resetMemoryStore()
  resetDismissedStore()
  resetActiveEditorStore()
  useTreeStore.getState().clear()
  setIpcClient(null)
})

describe('Check the book (F-16.30)', () => {
  it('shows when the book was last checked, and opens the dialog price first', async () => {
    render(
      <>
        <CheckTheBook />
        <CheckBookDialog />
      </>
    )
    await waitFor(() => expect(main.sent('memory:checkReport')).toHaveLength(1))
    expect(screen.getByTestId('check-last')).toHaveTextContent('Not checked yet')
    fireEvent.click(screen.getByRole('button', { name: 'Check the book…' }))
    const dialog = await screen.findByTestId('check-dialog')
    expect(await within(dialog).findByTestId('check-price')).toHaveTextContent(
      'About 0.04¢, at most 0.06¢'
    )
    expect(dialog).toHaveTextContent('It does not check travel times and distances')
    // Nothing was sent to run it yet.
    expect(main.sent('memory:checkBook')).toEqual([])
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('check-dialog')).toBeNull()
  })

  it('says free when nothing is left to judge, runs, shows its progress, then the report', async () => {
    estimate = checkEstimateFixture({ free: true, confirms: { about: 0, most: 0 } })
    useMemoryStore.getState().setCheckOpen('start')
    render(<CheckBookDialog />)
    const dialog = await screen.findByTestId('check-dialog')
    // Never checked before: no "since your last check".
    expect(await within(dialog).findByTestId('check-price')).toHaveTextContent(
      'Nothing new to judge: free'
    )
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }))
    await waitFor(() => expect(main.sent('memory:checkBook')).toEqual([{ nodeId: null }]))
    expect(await within(dialog).findByTestId('check-progress')).toHaveTextContent('Checking…')
    act(() =>
      main.emit(
        'memory:statusChanged',
        memoryStatusFixture({
          check: {
            startedAt: 'a',
            finishedAt: null,
            judged: 0,
            toJudge: 2,
            confirmed: 0,
            toConfirm: 0,
            stopped: false,
            reason: null
          }
        })
      )
    )
    expect(within(dialog).getByTestId('check-progress')).toHaveTextContent('Judging 0 of 2 pairs…')
    report = checkReportFixture()
    act(() =>
      main.emit(
        'memory:statusChanged',
        memoryStatusFixture({
          check: {
            startedAt: 'a',
            finishedAt: 'b',
            judged: 2,
            toJudge: 2,
            confirmed: 0,
            toConfirm: 0,
            stopped: false,
            reason: null
          }
        })
      )
    )
    const shown = await within(dialog).findByTestId('check-report')
    expect(shown).toHaveTextContent('Found (1)')
    expect(shown).toHaveTextContent('Mara Vell’s eyes: grey (1.1) · brown (1.2)')
    expect(within(shown).getByTestId('check-checked')).toHaveTextContent(
      'Checked: 2 pairs over 2 scenes and your notes; 1 confirmed by a stronger AI read'
    )
    expect(within(shown).getByTestId('check-not-checked')).toHaveTextContent(
      'travel times and distances'
    )
  })

  it('lists the unclear ones, those hidden as flashbacks with Not a flashback?, and secrets scoped', async () => {
    report = checkReportFixture({
      unclear: [findingViewFixture('f-u', { state: 'unclear' })],
      hidden: [
        {
          findingId: 'f-h',
          nodeId: 'sc-3',
          ref: '1.3',
          label: 'Hobb dies in 1.1 and is here in 1.3'
        }
      ],
      secretsNobodyLearns: [
        {
          secretId: 's-map',
          label: 'the sold map',
          readersSince: { nodeId: 'sc-1', ref: '1.1' },
          checkedUpTo: { nodeId: 'sc-2', ref: '1.2' }
        }
      ]
    })
    useMemoryStore.getState().setCheckOpen('report')
    render(<CheckBookDialog />)
    const shown = await screen.findByTestId('check-report')
    expect(within(shown).getByTestId('unclear-findings')).toHaveTextContent('Unclear (1)')
    expect(within(shown).getByTestId('nobody-learns')).toHaveTextContent(
      '“the sold map”: readers know it from 1.1; no scene shows anyone learning it (checked up to 1.2)'
    )
    const hidden = within(shown).getByTestId('check-hidden')
    expect(hidden).toHaveTextContent(
      'Hobb dies in 1.1 and is here in 1.3 (1.3 looks like a flashback)'
    )
    fireEvent.click(within(hidden).getByRole('button', { name: 'Not a flashback?' }))
    await waitFor(() =>
      expect(main.sent('memory:cardNotRight')).toEqual([
        { nodeId: 'sc-3', field: 'flashback', value: 'yes' }
      ])
    )
    await waitFor(() => expect(main.sent('memory:checkReport').length).toBeGreaterThan(1))
  })

  it('says why when the check it started ended before it began (a hold met since Check)', async () => {
    useMemoryStore.getState().setCheckOpen('start')
    render(<CheckBookDialog />)
    const dialog = await screen.findByTestId('check-dialog')
    await within(dialog).findByTestId('check-price')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check' }))
    expect(await within(dialog).findByTestId('check-progress')).toHaveTextContent('Checking…')
    act(() =>
      main.emit(
        'memory:statusChanged',
        memoryStatusFixture({
          check: {
            startedAt: 'z',
            finishedAt: 'z',
            judged: 0,
            toJudge: 0,
            confirmed: 0,
            toConfirm: 0,
            stopped: true,
            reason: 'The contradiction check is off.'
          }
        })
      )
    )
    expect(await within(dialog).findByTestId('check-ended')).toHaveTextContent(
      'The check did not run: The contradiction check is off.'
    )
    expect(within(dialog).queryByTestId('check-progress')).toBeNull()
  })

  it('closes before Go there opens the scene behind it', async () => {
    report = checkReportFixture()
    useMemoryStore.getState().setCheckOpen('report')
    render(<CheckBookDialog />)
    const shown = await screen.findByTestId('check-report')
    fireEvent.click(within(shown).getByRole('button', { name: 'Go there: 1.2' }))
    expect(useMemoryStore.getState().checkOpen).toBeNull()
    expect(screen.queryByTestId('check-dialog')).toBeNull()
    expect(useTreeStore.getState().selectedId).toBe('sc-2')
  })
})
