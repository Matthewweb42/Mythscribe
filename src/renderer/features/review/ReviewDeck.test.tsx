import { useState } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { ReviewDeck } from './ReviewDeck'
import {
  deckCounts,
  deckOrder,
  groupStats,
  nextOpen,
  type ReviewDecision,
  type ReviewDeckGroup,
  type ReviewDeckItem
} from './reviewDeckModel'

const GROUPS: ReviewDeckGroup[] = [
  { id: 'merges', label: 'Merges', noun: 'Merge' },
  { id: 'notNames', label: 'Not names', noun: 'Not a name' },
  { id: 'sheets', label: 'Sheets', noun: 'Sheet' }
]

const ITEMS: ReviewDeckItem[] = [
  { id: 's1', group: 'sheets', decision: 'pending' },
  { id: 'm1', group: 'merges', decision: 'pending' },
  { id: 'n1', group: 'notNames', decision: 'pending' },
  { id: 'm2', group: 'merges', decision: 'pending' },
  { id: 'n2', group: 'notNames', decision: 'pending' }
]

interface HarnessProps {
  items?: ReviewDeckItem[]
  onApply?: (accepted: string[]) => void
  onEdit?: (id: string) => void
  applyOnFinish?: boolean
  reject?: boolean
  compact?: boolean
  onCurrent?: (id: string | null) => void
}

/** A screen's store in miniature: holds the decisions the deck reports. */
function Harness(props: HarnessProps): React.JSX.Element {
  const [items, setItems] = useState(props.items ?? ITEMS)
  const decide = (ids: string[], decision: ReviewDecision): void =>
    setItems((list) => list.map((item) => (ids.includes(item.id) ? { ...item, decision } : item)))
  return (
    <ReviewDeck
      label="Changes"
      items={items}
      groups={GROUPS}
      renderCard={(id) => <p>{`Card ${id}`}</p>}
      onDecide={decide}
      onEdit={props.onEdit}
      reject={props.reject}
      compact={props.compact}
      onCurrent={props.onCurrent}
      autoFocus
      applyOnFinish={props.applyOnFinish}
      apply={{
        label: (n) => `Apply ${n} accepted`,
        onApply: () =>
          props.onApply?.(items.filter((i) => i.decision === 'accepted').map((i) => i.id))
      }}
    />
  )
}

const card = (): HTMLElement => screen.getByTestId('review-card')
const press = (key: string): void => {
  fireEvent.keyDown(screen.getByRole('region', { name: 'Changes' }), { key })
}

describe('reviewDeckModel', () => {
  it('orders by the rail, counts per group, and finds the next item still waiting', () => {
    const ordered = deckOrder(ITEMS, GROUPS)
    expect(ordered.map((i) => i.id)).toEqual(['m1', 'm2', 'n1', 'n2', 's1'])
    const decided = ordered.map((i) => (i.id === 'm2' ? { ...i, decision: 'skipped' as const } : i))
    expect(nextOpen(decided, 'm1', 'all')).toBe('n1')
    expect(nextOpen(decided, 's1', 'skipped')).toBe('m2')
    expect(groupStats(decided, GROUPS).map((g) => [g.group.id, g.reviewed, g.total])).toEqual([
      ['merges', 1, 2],
      ['notNames', 0, 2],
      ['sheets', 0, 1]
    ])
    expect(
      deckCounts([...decided, { id: 'x', group: 'sheets', decision: 'accepted', settled: true }])
    ).toEqual({ total: 6, reviewed: 2, accepted: 0, skipped: 1, open: 4 })
  })
})

describe('ReviewDeck', () => {
  it('shows one card at a time in rail order, with its place in the group and the progress', () => {
    render(<Harness />)
    expect(within(card()).getByText('Card m1')).toBeTruthy()
    expect(screen.getByTestId('review-position').textContent).toBe('Merge 1 of 2')
    const rail = screen.getByRole('navigation', { name: 'Groups' })
    expect(
      within(rail)
        .getAllByTestId('review-group')
        .map((b) => b.textContent)
    ).toEqual(['Merges0/2', 'Not names0/2', 'Sheets0/1'])
    expect(screen.getAllByRole('progressbar')[0]?.getAttribute('aria-valuetext')).toBe(
      '0 of 5 reviewed'
    )
  })

  it('decides with the keys and moves on: A accepts, S skips, arrows step, E edits', () => {
    const onEdit = vi.fn()
    render(<Harness onEdit={onEdit} />)
    press('a')
    expect(within(card()).getByText('Card m2')).toBeTruthy()
    press('s')
    expect(within(card()).getByText('Card n1')).toBeTruthy()
    press('ArrowLeft')
    expect(within(card()).getByText('Card m2')).toBeTruthy()
    expect(screen.getByTestId('review-decision').textContent).toBe('Skipped')
    press('e')
    expect(onEdit).toHaveBeenCalledWith('m2')
    press('ArrowRight')
    expect(within(card()).getByText('Card n1')).toBeTruthy()
    expect(screen.getByTestId('review-apply').textContent).toBe('Apply 1 accepted')
  })

  it('ignores the keys while the author types in a field of the card', () => {
    render(
      <ReviewDeck
        label="Changes"
        items={ITEMS}
        groups={GROUPS}
        renderCard={() => <input aria-label="Name" />}
        onDecide={() => {
          throw new Error('decided while typing')
        }}
      />
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Name' }), { key: 'a' })
    expect(within(card()).getByRole('textbox', { name: 'Name' })).toBeTruthy()
  })

  it('accepts a whole group, jumps by the rail, and keeps skipped items reviewable', async () => {
    render(<Harness />)
    const rail = screen.getByRole('navigation', { name: 'Groups' })
    await userEvent.click(within(rail).getByTestId('review-accept-group'))
    // The merges are accepted; the deck moved to the next group.
    expect(screen.getByTestId('review-position').textContent).toBe('Not a name 1 of 2')
    expect(within(rail).getAllByTestId('review-group')[0]?.textContent).toBe('Merges2/2')
    await userEvent.click(within(rail).getByRole('button', { name: /Sheets/ }))
    expect(within(card()).getByText('Card s1')).toBeTruthy()
    press('s')
    // n1 is next; skip it too, then the Skipped filter steps through only the skipped ones.
    expect(within(card()).getByText('Card n1')).toBeTruthy()
    press('s')
    expect(within(card()).getByText('Card n2')).toBeTruthy()
    await userEvent.click(within(rail).getByTestId('review-skipped-filter'))
    expect(within(card()).getByText('Card n1')).toBeTruthy()
    press('a')
    expect(within(card()).getByText('Card s1')).toBeTruthy()
    press('a')
    // No skipped left: back to everything, on the one still waiting.
    expect(within(card()).getByText('Card n2')).toBeTruthy()
    expect(screen.getByTestId('review-apply').textContent).toBe('Apply 4 accepted')
  })

  it('applies the accepted ones with the button, and by itself at the end when nothing was skipped', async () => {
    const onApply = vi.fn()
    const { unmount } = render(<Harness onApply={onApply} />)
    press('a')
    press('s')
    await userEvent.click(screen.getByTestId('review-apply'))
    expect(onApply).toHaveBeenLastCalledWith(['m1'])
    unmount()
    const finish = vi.fn()
    render(<Harness onApply={finish} applyOnFinish />)
    for (let i = 0; i < 4; i++) press('a')
    expect(finish).not.toHaveBeenCalled()
    press('a')
    expect(finish).toHaveBeenCalledTimes(1)
    expect(screen.getByTestId('review-done').textContent).toContain('All 5 reviewed.')
  })

  it('stops at the end with the skipped ones still to see, and offers Reject where it applies', async () => {
    const onApply = vi.fn()
    const seen: (string | null)[] = []
    render(<Harness onApply={onApply} applyOnFinish reject onCurrent={(id) => seen.push(id)} />)
    press('r')
    press('s')
    press('a')
    press('a')
    press('a')
    expect(onApply).not.toHaveBeenCalled()
    expect(screen.getByTestId('review-done').textContent).toContain('3 accepted · 1 skipped')
    await userEvent.click(screen.getByTestId('review-review-skipped'))
    expect(within(card()).getByText('Card m2')).toBeTruthy()
    expect(seen.slice(0, 3)).toEqual(['m1', 'm2', 'n1'])
  })

  it('shows the groups as a dropdown when compact', async () => {
    render(<Harness compact />)
    expect(screen.getByTestId('review-rail').className).toContain('hidden')
    await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Group' }), 'sheets')
    expect(within(card()).getByText('Card s1')).toBeTruthy()
  })
})
