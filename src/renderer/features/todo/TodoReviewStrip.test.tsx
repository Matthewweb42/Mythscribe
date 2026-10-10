import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Entity, Input, Output } from '@shared/ipc/contract'
import { resetCategoryStore } from '@renderer/features/entities/categoryStore'
import { resetEntityStore } from '@renderer/features/entities/entityStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { todoItem } from './todoFixture'
import { TodoReviewStrip } from './TodoReviewStrip'
import { resetTodoStore, useTodoStore } from './todoStore'
import { NO_SHEET_SYNC } from '@shared/sheetSync'

let calls: [Channel, unknown][]

beforeEach(() => {
  resetTodoStore()
  // A category load left in flight by another file must not land here (it answered `categories` undefined).
  resetCategoryStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'todo:settle') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  // No scene, so a card does not open the editor in this test.
  useTodoStore.setState({
    items: [
      todoItem('a', { nodeId: null, subject: 'Hollowing' }),
      todoItem('b', {
        nodeId: null,
        subject: 'Mara',
        kind: 'gap',
        rule: 'noGoal',
        suggestions: ['She wants the ferry back', 'She wants out of the city'],
        suggested: true,
        target: { kind: 'field', entityId: 'e-mara', field: 'goals' },
        targetLabel: 'Mara › Goals / motivations'
      })
    ]
  })
  useTodoStore.getState().startReview()
})
afterEach(() => {
  resetTodoStore()
  resetEntityStore()
  resetCategoryStore()
})

const deck = (): HTMLElement => screen.getByRole('region', { name: 'Go through the To do list' })
const press = (key: string): void => {
  fireEvent.keyDown(deck(), { key })
}

describe('TodoReviewStrip (F-9.16)', () => {
  it('goes through the items: S keeps one for later, A marks one done', async () => {
    render(<TodoReviewStrip />)
    expect(screen.getByTestId('review-card')).toHaveAttribute('data-item-id', 'a')
    expect(screen.getByTestId('review-position')).toHaveTextContent('Undefined 1 of 1')
    press('s')
    expect(screen.getByTestId('review-card')).toHaveAttribute('data-item-id', 'b')
    expect(useTodoStore.getState().review?.skipped).toEqual(['a'])
    expect(useTodoStore.getState().items.map((item) => item.id)).toEqual(['a', 'b'])
    press('a')
    // Nothing waits any more: the one kept for later is behind the Skipped filter.
    expect(await screen.findByTestId('review-done')).toHaveTextContent('1 accepted · 1 skipped')
    expect(calls).toEqual([['todo:settle', { id: 'b', status: 'done' }]])
    expect(useTodoStore.getState().items.map((item) => item.id)).toEqual(['a'])
  })

  it('R dismisses the item for good', async () => {
    render(<TodoReviewStrip />)
    press('r')
    expect(screen.getByTestId('review-card')).toHaveAttribute('data-item-id', 'b')
    expect(calls).toEqual([['todo:settle', { id: 'a', status: 'dismissed' }]])
    await userEvent.click(screen.getByTestId('review-prev'))
    expect(await screen.findByText('Dismissed: it will not come back.')).toBeInTheDocument()
  })

  it('labels suggestions, and picking one only fills the editable line', async () => {
    useTodoStore.getState().reviewAt('b')
    render(<TodoReviewStrip />)
    const list = screen.getByRole('list', { name: 'Suggestions' })
    expect(within(list).getAllByText('Suggestion')).toHaveLength(2)
    await userEvent.click(
      within(list).getByRole('button', { name: 'Use: She wants the ferry back' })
    )
    const line = screen.getByTestId('todo-line')
    expect(line).toHaveValue('She wants the ferry back')
    expect(screen.getByText('Add to Mara › Goals / motivations')).toBeInTheDocument()
    // Nothing was written: picking is not adding.
    expect(calls).toEqual([])
    // Typing in the line never decides the card.
    await userEvent.type(line, ' again')
    expect(line).toHaveValue('She wants the ferry back again')
    expect(calls).toEqual([])
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByTestId('todo-composer')).toBeNull()
    expect(calls).toEqual([])
  })

  it('E opens the line, and Stop ends going through', async () => {
    render(<TodoReviewStrip />)
    press('e')
    expect(screen.getByTestId('todo-line')).toHaveValue('')
    await userEvent.click(screen.getByTestId('todo-review-close'))
    expect(useTodoStore.getState().review).toBeNull()
  })

  it('makes a new record in the category the author picks, the guess first', async () => {
    setIpcClient({
      async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
        calls.push([channel, input])
        if (channel === 'todo:settle') return null as Output<C>
        if (channel === 'entity:create') {
          const created = input as Input<'entity:create'>
          const entity: Entity = {
            id: 'e-new',
            kind: created.kind,
            name: created.name,
            template: 'structured',
            fields: {},
            body: null,
            image: null,
            tagId: null,
            aliases: [],
            origin: 'author',
            status: 'canon',
            extraFields: [],
            sync: NO_SHEET_SYNC,
            created: '2026-10-09',
            modified: '2026-10-09'
          }
          return entity as Output<C>
        }
        throw new Error(`unexpected ${channel}`)
      },
      on: () => () => {}
    })
    useTodoStore.setState({
      items: [
        todoItem('c', {
          nodeId: null,
          subject: 'Saltmarch',
          rule: 'unknownName',
          target: { kind: 'newRecord', category: 'character', name: 'Saltmarch' },
          targetLabel: 'New character: Saltmarch'
        })
      ]
    })
    useTodoStore.getState().startReview()
    render(<TodoReviewStrip />)
    press('e')
    const picker = screen.getByTestId('todo-category')
    expect(picker).toHaveValue('character')
    expect(within(picker).queryByRole('option', { name: 'Threads' })).toBeNull()
    await userEvent.selectOptions(picker, 'setting')
    expect(screen.getByText(/^New place: Saltmarch/u)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('todo-add'))
    await waitFor(() => expect(calls).toContainEqual(['todo:settle', { id: 'c', status: 'done' }]))
    expect(calls[0]).toEqual([
      'entity:create',
      { kind: 'setting', name: 'Saltmarch', template: 'structured' }
    ])
  })
})
