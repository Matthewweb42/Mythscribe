import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { todoCounts, type TodoItem } from '@shared/todo'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { TodoTab } from './TodoTab'
import { todoItem } from './todoFixture'
import { resetTodoStore } from './todoStore'

let calls: [Channel, unknown][]
let items: TodoItem[]

beforeEach(async () => {
  resetTodoStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  items = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'tree:list') return treeFixture as Output<C>
      if (channel === 'todo:list') return { items, counts: todoCounts(items) } as Output<C>
      if (channel === 'todo:settle') {
        const { id } = input as Input<'todo:settle'>
        if (id === 'gone') {
          throw new IpcRequestError({ code: 'NOT_FOUND', message: 'That To do item is gone' })
        }
        items = items.filter((each) => each.id !== id)
        return null as Output<C>
      }
      if (channel === 'todo:reopen') return null as Output<C>
      throw new Error(`unexpected ${channel}`)
    },
    on: () => () => {}
  }
  setIpcClient(client)
  await useTreeStore.getState().load()
})
afterEach(() => {
  resetTodoStore()
  useTreeStore.getState().clear()
})

describe('TodoTab (F-9.16)', () => {
  it('says there is nothing to figure out', async () => {
    render(<TodoTab />)
    expect(await screen.findByText('Nothing to figure out right now.')).toBeInTheDocument()
  })

  it('groups the items by kind with counts, and filters by kind', async () => {
    items = [
      todoItem('Hollowing'),
      todoItem('Mara · Age', { kind: 'contradiction', rule: 'factConflict' }),
      todoItem('Tash', { rule: 'unknownName', nodeId: 'sc-2' })
    ]
    render(<TodoTab />)
    const undefinedGroup = await screen.findByRole('region', { name: 'Undefined' })
    expect(within(undefinedGroup).getByText('Undefined (2)')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Contradictions' })).toBeInTheDocument()
    const row = within(undefinedGroup).getByRole('listitem', { name: 'Hollowing' })
    expect(row).toHaveTextContent('Mara reached the Hollowing at dusk.')
    expect(within(row).getByRole('button', { name: 'Go to passage in Scene 1' })).toBeVisible()

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Show kind' }),
      'contradiction'
    )
    expect(screen.queryByRole('region', { name: 'Undefined' })).toBeNull()
    expect(screen.getByRole('listitem', { name: 'Mara · Age' })).toBeInTheDocument()
  })

  it('dismisses an item and offers Undo', async () => {
    items = [todoItem('Hollowing')]
    render(<TodoTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Dismiss: Hollowing' }))
    expect(calls).toContainEqual(['todo:settle', { id: 'Hollowing', status: 'dismissed' }])
    expect(screen.getByText('Nothing to figure out right now.')).toBeInTheDocument()
    const undo = screen.getByTestId('todo-undo')
    expect(undo).toHaveTextContent('Dismissed: Hollowing')
    await userEvent.click(within(undo).getByRole('button', { name: 'Undo' }))
    expect(calls).toContainEqual(['todo:reopen', { id: 'Hollowing' }])
    expect(screen.queryByTestId('todo-undo')).toBeNull()
  })

  it('offers the fix of a contradiction, and no Undo once it is dismissed there', async () => {
    items = [todoItem('c:f1', { kind: 'contradiction', rule: 'continuity', subject: 'Mara' })]
    render(<TodoTab />)
    expect(await screen.findByRole('button', { name: 'Open the fix' })).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Done: Mara' }))
    expect(screen.getByTestId('todo-undo')).toHaveTextContent('Done: Mara')
    expect(
      within(screen.getByTestId('todo-undo')).queryByRole('button', { name: 'Undo' })
    ).toBeNull()
  })

  it('toasts a settle main refuses', async () => {
    items = [todoItem('gone')]
    render(<TodoTab />)
    await userEvent.click(await screen.findByRole('button', { name: 'Done: gone' }))
    expect(useDialogStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'That To do item is gone'
    ])
  })
})
