import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import type { EditChange } from '@shared/editPass'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { setIpcClient } from '@renderer/lib/ipc'
import { resetEditPassStore, useEditPassStore } from './editPassStore'
import { resetEditPassViewStore } from './editPassViewStore'
import { EditReviewStrip } from './EditReviewStrip'

const change = (over: Partial<EditChange>): EditChange => ({
  id: 'c1',
  passId: 'p1',
  nodeId: 'sc-1',
  kind: 'change',
  position: 0,
  original: 'rang very very slowly',
  replacement: 'rang slowly',
  rationale: 'Cut the doubled word.',
  category: null,
  flagged: false,
  violation: null,
  status: 'pending',
  proposalId: 'prop-1',
  ...over
})

let settles: Input<'editPass:settle'>[]

beforeEach(() => {
  settles = []
  resetEditPassStore()
  resetEditPassViewStore()
  setIpcClient({
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'editPass:settle') {
        const asked = input as Input<'editPass:settle'>
        settles.push(asked)
        return asked.ids.map((id) => change({ id, status: asked.status })) as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  })
})

describe('EditReviewStrip (F-14.15, one change at a time)', () => {
  it('shows one change with its diff and reason; S keeps it for later, R rejects the next', async () => {
    const changes = [
      change({}),
      change({ id: 'c2', original: 'over the water', replacement: 'over the sea', rationale: '' })
    ]
    useEditPassStore.setState({
      review: {
        changes,
        titles: { 'sc-1': 'Scene 1' },
        skipped: [],
        currentId: 'c1',
        nodeId: 'sc-1'
      }
    })
    render(<EditReviewStrip />)
    const deck = screen.getByRole('region', { name: 'Review tracked changes' })
    expect(within(deck).getByTestId('review-position')).toHaveTextContent('Change 1 of 2')
    expect(within(deck).getByTestId('edit-review-diff')).toHaveTextContent('rang very very slowly')
    expect(within(deck).getByText('Cut the doubled word.')).toBeInTheDocument()
    expect(within(deck).getByTestId('review-skip')).toHaveTextContent('Later')
    fireEvent.keyDown(deck, { key: 's' })
    expect(useEditPassStore.getState().review?.skipped).toEqual(['c1'])
    expect(useEditPassStore.getState().review?.currentId).toBe('c2')
    fireEvent.keyDown(deck, { key: 'r' })
    await waitFor(() => expect(settles).toEqual([{ ids: ['c2'], status: 'rejected' }]))
    await waitFor(() =>
      expect(useEditPassStore.getState().review?.changes[1]?.status).toBe('rejected')
    )
    // Only the skipped one is left: the end says so and offers it again.
    expect(within(deck).getByTestId('review-done')).toHaveTextContent('0 accepted · 1 skipped')
    fireEvent.click(within(deck).getByTestId('review-review-skipped'))
    expect(useEditPassStore.getState().review?.currentId).toBe('c1')
    fireEvent.click(within(deck).getByTestId('edit-review-close'))
    expect(useEditPassStore.getState().review).toBeNull()
  })
})
