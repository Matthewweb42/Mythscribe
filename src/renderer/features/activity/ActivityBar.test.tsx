import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { resetFocusStore, useFocusStore } from '@renderer/features/focus/focusStore'
import { resetOrganiseStore, useOrganiseStore } from '@renderer/features/organise/organiseStore'
import { resetSideWorkPlace, useSideWorkPlaceStore } from '@renderer/features/sideWork/sideWork'
import { setIpcClient } from '@renderer/lib/ipc'
import type { ActivityNote } from './activityJobs'
import { ActivityBar } from './ActivityBar'
import { ActivityDrops } from './ActivityDrops'
import { resetActivityStore, useActivityStore } from './activityStore'

beforeEach(() => {
  setIpcClient({
    async invoke<C extends Channel>(channel: C, _input: Input<C>): Promise<Output<C>> {
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
  resetActivityStore()
  resetOrganiseStore()
  resetFocusStore()
  resetSideWorkPlace()
})
afterEach(() => {
  resetActivityStore()
  resetOrganiseStore()
  resetSideWorkPlace()
})

const note = (over: Partial<ActivityNote> = {}): ActivityNote => ({
  id: 'n1',
  kind: 'organise',
  status: 'done',
  title: 'Organise is ready to review',
  detail: '2 changes',
  ref: null,
  canOpen: true,
  canRetry: false,
  parked: false,
  ...over
})

describe('ActivityBar (F-7.12)', () => {
  it('shows nothing while nothing runs', () => {
    const { container } = render(<ActivityBar placement="header" />)
    expect(container).toBeEmptyDOMElement()
  })

  it('draws one combined bar for several jobs, and the hover lists each with its percentage', () => {
    const now = Date.now()
    useActivityStore.setState({
      jobs: [
        {
          key: 'e',
          kind: 'editPass',
          name: 'Edit pass · Proofread',
          steps: { done: 1, total: 2 },
          ref: 'p'
        },
        { key: 'o', kind: 'organise', name: 'Organise', steps: null, ref: null }
      ],
      timing: {
        e: { startedAt: now, stepAt: now, done: 1 },
        o: { startedAt: now, stepAt: now, done: 0 }
      }
    })
    render(<ActivityBar placement="header" />)
    const bar = screen.getByTestId('activity-bar')
    expect(bar).toHaveAttribute('data-placement', 'header')
    expect(bar).toHaveAttribute('data-state', 'running')
    // 50 % and 0 % average to 25 %.
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '25')
    fireEvent.mouseEnter(bar)
    const tip = screen.getByRole('tooltip')
    expect(within(tip).getByText('Edit pass · Proofread')).toBeInTheDocument()
    expect(within(tip).getByText('50 %')).toBeInTheDocument()
    expect(within(tip).getByText('Organise')).toBeInTheDocument()
  })

  it('fills to the end as the last job finishes, and sits at the window top in focus mode', () => {
    useActivityStore.setState({ finishing: [{ key: 'o', name: 'Organise' }] })
    render(<ActivityBar placement="window" />)
    const bar = screen.getByTestId('activity-bar')
    expect(bar).toHaveAttribute('data-state', 'done')
    expect(bar).toHaveAttribute('data-placement', 'window')
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '100')
  })
})

describe('ActivityDrops (F-7.12)', () => {
  it('drops a finished job with Open and ×; Open shows Organise in the big review dialog', async () => {
    useOrganiseStore.setState({ open: true, phase: 'ready' })
    useActivityStore.setState({ notes: [note()] })
    render(<ActivityDrops />)
    const drop = screen.getByTestId('activity-drop')
    expect(drop).toHaveTextContent('Organise is ready to review')
    expect(within(drop).queryByRole('button', { name: 'Retry' })).toBeNull()
    await userEvent.click(within(drop).getByRole('button', { name: 'Open' }))
    expect(useSideWorkPlaceStore.getState().place).toBe('dialog')
    expect(useOrganiseStore.getState().shown).toBe(true)
    expect(screen.queryByTestId('activity-drop')).toBeNull()
  })

  it('shows a failure in the danger colour with its reason and Retry; × dismisses it', async () => {
    useActivityStore.setState({
      notes: [
        note({ status: 'failed', title: 'Organise failed', detail: 'No key.', canRetry: true })
      ]
    })
    render(<ActivityDrops />)
    const drop = screen.getByTestId('activity-drop')
    expect(drop).toHaveAttribute('data-status', 'failed')
    expect(within(drop).getByText('Organise failed')).toHaveClass('text-danger')
    expect(drop).toHaveTextContent('No key.')
    expect(within(drop).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    await userEvent.click(within(drop).getByRole('button', { name: 'Dismiss notification' }))
    expect(useActivityStore.getState().notes).toEqual([])
  })

  it('leaves out a notification parked in focus mode, and sits at the window top there', () => {
    useActivityStore.setState({
      notes: [
        note({ id: 'a', parked: true }),
        note({ id: 'b', title: 'Edit pass finished', kind: 'editPass' })
      ]
    })
    act(() => useFocusStore.setState({ active: true }))
    render(<ActivityDrops />)
    expect(screen.getAllByTestId('activity-drop').map((drop) => drop.textContent)).toEqual([
      expect.stringContaining('Edit pass finished')
    ])
    expect(screen.getByTestId('activity-drops')).toHaveClass('top-3')
  })
})
