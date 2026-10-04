import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { sceneLengthStats, type StatsDashboard } from '@shared/statsDashboard'
import { resetDocumentStore } from '@renderer/features/editor/documentStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { StatsDialog } from './StatsDialog'

const hours = (words: Record<number, number> = {}): StatsDashboard['hours'] =>
  Array.from({ length: 24 }, (_, hour) => ({ hour, words: words[hour] ?? 0, activeMs: 0 }))

const full: StatsDashboard = {
  today: '2026-10-04',
  days: [
    { day: '2026-10-01', words: -12, activeMs: 0 },
    { day: '2026-10-03', words: 300, activeMs: 600_000 },
    { day: '2026-10-04', words: 1234, activeMs: 1_200_000 }
  ],
  hours: hours({ 9: 300, 21: 1234 }),
  scenes: sceneLengthStats([
    { id: 's1', title: 'Arrival', words: 1234 },
    { id: 's2', title: 'Storm', words: 300 }
  ]),
  pov: [
    { pov: 'Mara', scenes: 1, words: 1234 },
    { pov: null, scenes: 1, words: 300 }
  ],
  characters: [{ tagId: 't1', name: 'Mara Voss', scenes: 2, mentions: 7, povScenes: 1 }],
  settings: [
    { tagId: 't2', name: 'harbor', scenes: 1, mentions: 2 },
    { tagId: null, name: 'The Old Mill', scenes: 1, mentions: 0 }
  ],
  truncated: { characters: true, settings: false }
}

const empty: StatsDashboard = {
  today: '2026-10-04',
  days: [],
  hours: hours(),
  scenes: sceneLengthStats([]),
  pov: [],
  characters: [],
  settings: [],
  truncated: { characters: false, settings: false }
}

let invoke: ReturnType<typeof vi.fn<(channel: string, input: unknown) => Promise<unknown>>>

function install(answer: StatsDashboard | Error): void {
  invoke = vi.fn(async (channel: string) => {
    if (channel === 'stats:dashboard') {
      if (answer instanceof Error) throw answer
      return answer
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

beforeEach(() => {
  resetDocumentStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  install(full)
})
afterEach(() => {
  resetDocumentStore()
})

describe('StatsDialog (F-10.5)', () => {
  it('renders every section from main', async () => {
    render(<StatsDialog onClose={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Statistics' })
    expect(within(dialog).getByText('Loading…')).toBeInTheDocument()
    const heatmap = await within(dialog).findByTestId('stats-heatmap')
    expect(invoke).toHaveBeenCalledWith('stats:dashboard', undefined)

    const cells = within(heatmap).getAllByTestId('heat-cell')
    // 52 full weeks and today's week up to Sunday.
    expect(cells).toHaveLength(52 * 7 + 7)
    const today = cells.find((c) => c.dataset.day === '2026-10-04')
    expect(today).toHaveAttribute('data-level', '4')
    expect(today).toHaveAttribute('title', 'Sun 4 Oct 2026: 1,234 words')
    const cut = cells.find((c) => c.dataset.day === '2026-10-01')
    expect(cut).toHaveAttribute('data-level', '0')
    expect(cut).toHaveAttribute('title', 'Thu 1 Oct 2026: 12 words cut')
    expect(heatmap).toHaveTextContent(`${(1534).toLocaleString()} words on 2 days in the last year`)

    const daily = within(dialog).getByTestId('stats-daily')
    expect(within(daily).getAllByTestId('day-bar')).toHaveLength(30)
    expect(daily).toHaveTextContent(`${(1522).toLocaleString()} words in total`)
    expect(daily).toHaveTextContent('767 words a day on the 2 days you wrote')

    expect(within(dialog).getByTestId('stats-hours')).toHaveTextContent(
      'Most words between 21:00 and 22:00'
    )

    const lengths = within(dialog).getByTestId('stats-scene-lengths')
    expect(within(lengths).getByTestId('scene-count')).toHaveTextContent('2 scenes')
    expect(lengths).toHaveTextContent('Shortest: Storm (300 words)')
    expect(lengths).toHaveTextContent(`Longest: Arrival (${(1234).toLocaleString()} words)`)

    const pov = within(dialog).getByTestId('stats-pov')
    expect(
      within(pov)
        .getAllByTestId('stats-row')
        .map((r) => r.textContent)
    ).toEqual([expect.stringContaining('Mara'), expect.stringContaining('No POV set')])

    const characters = within(dialog).getByTestId('stats-characters')
    expect(characters).toHaveTextContent('Mara Voss')
    expect(characters).toHaveTextContent('2 scenes · 7 mentions · 1 POV')
    expect(characters).toHaveTextContent('Showing the top 1.')

    const settings = within(dialog).getByTestId('stats-settings')
    expect(within(settings).getAllByTestId('stats-row')).toHaveLength(2)
    expect(settings).toHaveTextContent('The Old Mill (location, no tag)')
  })

  it('shows an empty state in every panel', async () => {
    install(empty)
    render(<StatsDialog onClose={() => {}} />)
    const heatmap = await screen.findByTestId('stats-heatmap')
    expect(heatmap).toHaveTextContent('No writing logged yet')
    expect(screen.getByTestId('stats-daily')).toHaveTextContent('No words written')
    expect(screen.getByTestId('stats-hours')).toHaveTextContent('No writing logged yet')
    expect(screen.getByTestId('stats-scene-lengths')).toHaveTextContent('No scenes yet')
    expect(screen.getByTestId('stats-pov')).toHaveTextContent('No scenes yet')
    expect(screen.getByTestId('stats-characters')).toHaveTextContent('No character tags yet')
    expect(screen.getByTestId('stats-settings')).toHaveTextContent('No setting tags')
  })

  it('says when no scene has a POV', async () => {
    install({ ...full, pov: [{ pov: null, scenes: 2, words: 1534 }] })
    render(<StatsDialog onClose={() => {}} />)
    expect(await screen.findByTestId('stats-pov')).toHaveTextContent('No POV set on any scene')
  })

  it('toasts a failure and closes on Escape and Close', async () => {
    install(new Error('NO_PROJECT: No project is open.'))
    const onClose = vi.fn()
    render(<StatsDialog onClose={onClose} />)
    await vi.waitFor(() => expect(useDialogStore.getState().toasts).toHaveLength(1))
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close).toHaveFocus()
    await userEvent.keyboard('{Escape}')
    await userEvent.click(close)
    expect(onClose).toHaveBeenCalledTimes(2)
  })
})
