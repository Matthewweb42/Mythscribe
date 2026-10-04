import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyGoalsPatch, type GoalsPatch, type GoalsStatus } from '@shared/goals'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { GoalsDialog } from './GoalsDialog'
import { goalsStatusFixture } from './goalsFixture'
import { resetGoalsStore, useGoalsStore } from './goalsStore'

let status: GoalsStatus
let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(): void {
  invoke = vi.fn(async (channel: string, input: unknown) => {
    if (channel === 'goals:get') return status
    if (channel === 'goals:set') {
      status = { ...status, goals: applyGoalsPatch(status.goals, input as GoalsPatch) }
      return status
    }
    throw new Error(`unexpected ${channel}`)
  })
  const client: IpcClient = {
    invoke: <C extends Channel>(channel: C, input: Input<C>) =>
      invoke(channel, input) as Promise<Output<C>>,
    on: () => () => {}
  }
  setIpcClient(client)
}

const base = goalsStatusFixture()

beforeEach(() => {
  resetGoalsStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  status = goalsStatusFixture({
    goals: { ...base.goals, projectTarget: 80000, deadline: '2026-12-31', dailyTarget: 500 },
    manuscriptWords: 20000,
    today: { day: base.today.day, words: 650 },
    streak: { current: 3, best: 5 },
    daysLeft: 89,
    perDayNeeded: 675,
    session: { words: 650, activeMs: 30 * 60_000 }
  })
  install()
})
afterEach(() => {
  resetGoalsStore()
})

async function openDialog(): Promise<HTMLElement> {
  await useGoalsStore.getState().load()
  useGoalsStore.getState().show()
  render(<GoalsDialog />)
  return screen.findByRole('dialog', { name: 'Goals' })
}

describe('GoalsDialog (F-10.3)', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<GoalsDialog />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the project, today, the streak, and the session', async () => {
    const dialog = await openDialog()
    expect(within(dialog).getByTestId('goals-project-words')).toHaveTextContent(
      '20,000 / 80,000 words'
    )
    expect(within(dialog).getByText('89 days left · 675 words a day')).toBeInTheDocument()
    expect(within(dialog).getByTestId('goals-today-words')).toHaveTextContent(
      '650 / 500 words today'
    )
    expect(within(dialog).getByRole('progressbar', { name: "Today's progress" })).toHaveAttribute(
      'data-met',
      'true'
    )
    expect(within(dialog).getByTestId('goals-streak')).toHaveTextContent(
      'Streak: 3 days · best 5 days'
    )
    expect(within(dialog).getByTestId('goals-session-time')).toHaveTextContent('30 min')
    expect(within(dialog).getByTestId('goals-session-words')).toHaveTextContent('650')
    expect(within(dialog).getByTestId('goals-session-pace')).toHaveTextContent('1,300')
    expect(within(dialog).getByLabelText('Project target (words)')).toHaveValue('80000')
    expect(within(dialog).getByLabelText('Deadline')).toHaveValue('2026-12-31')
    // It asked main for a fresh status when it opened.
    expect(invoke.mock.calls.filter(([channel]) => channel === 'goals:get')).toHaveLength(2)
  })

  it('saves only what changed, an empty field clearing its target', async () => {
    const dialog = await openDialog()
    const daily = within(dialog).getByLabelText('Daily target (words)')
    await userEvent.clear(daily)
    await userEvent.type(daily, '1,000')
    await userEvent.clear(within(dialog).getByLabelText('Project target (words)'))
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect(invoke).toHaveBeenCalledWith('goals:set', { projectTarget: null, dailyTarget: 1000 })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(useGoalsStore.getState().status?.goals).toMatchObject({
      projectTarget: null,
      dailyTarget: 1000,
      deadline: '2026-12-31'
    })
  })

  it('blocks a target that is not a whole number and explains why', async () => {
    const dialog = await openDialog()
    const daily = within(dialog).getByLabelText('Daily target (words)')
    await userEvent.clear(daily)
    await userEvent.type(daily, 'many')
    expect(within(dialog).getByRole('alert')).toHaveTextContent(/whole number of words/)
    expect(within(dialog).getByRole('button', { name: 'Save' })).toBeDisabled()
  })

  it('shows no streak or bars without targets, and closes on Escape', async () => {
    status = goalsStatusFixture({ manuscriptWords: 1200 })
    const dialog = await openDialog()
    expect(within(dialog).getByTestId('goals-project-words')).toHaveTextContent(
      '1,200 words in the manuscript'
    )
    expect(within(dialog).queryByTestId('goals-streak')).not.toBeInTheDocument()
    expect(within(dialog).queryByRole('progressbar')).not.toBeInTheDocument()
    expect(within(dialog).getByTestId('goals-session-pace')).toHaveTextContent('—')
    await userEvent.keyboard('{Escape}')
    expect(useGoalsStore.getState().open).toBe(false)
  })

  it('says when the deadline has passed and when the target is reached', async () => {
    status = { ...status, daysLeft: 0, perDayNeeded: null }
    const dialog = await openDialog()
    expect(within(dialog).getByText('The deadline has passed.')).toBeInTheDocument()
    useGoalsStore.setState({ status: { ...status, manuscriptWords: 90000 } })
    expect(await within(dialog).findByText('Target reached.')).toBeInTheDocument()
  })
})
