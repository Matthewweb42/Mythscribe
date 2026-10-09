import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output } from '@shared/ipc/contract'
import { todoCounts, type TodoCheck, type TodoItem } from '@shared/todo'
import { resetAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { treeFixture } from '@renderer/features/manuscript/treeFixture'
import { useTreeStore } from '@renderer/features/manuscript/treeStore'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { TodoTab } from './TodoTab'
import { todoCheck, todoItem } from './todoFixture'
import { resetTodoStore, useTodoStore } from './todoStore'

let calls: [Channel, unknown][]
let items: TodoItem[]
let check: TodoCheck
let checkResult: Output<'todo:check'>
let suggestResult: Output<'todo:suggest'>

beforeEach(async () => {
  resetTodoStore()
  resetAiActivityStore()
  useDialogStore.setState({ modals: [], toasts: [] })
  calls = []
  items = []
  check = todoCheck()
  checkResult = { ok: true, requested: true, added: 2, resolved: 0, costUsd: 0.001, requestId: 'x' }
  suggestResult = {
    ok: true,
    suggestions: ['A sinkhole that swallows sound', 'An old quarry'],
    requested: true,
    costUsd: 0.0002,
    requestId: 'x'
  }
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      calls.push([channel, input])
      if (channel === 'tree:list') return treeFixture as Output<C>
      if (channel === 'todo:list') return { items, counts: todoCounts(items), check } as Output<C>
      if (channel === 'todo:check') return checkResult as Output<C>
      if (channel === 'todo:suggest') return suggestResult as Output<C>
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
  resetAiActivityStore()
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

  it('with AI off, says where to turn the check on and offers no button', async () => {
    render(<TodoTab />)
    expect(await screen.findByTestId('todo-ai-hint')).toHaveTextContent(
      'turn on Use AI and “To do list: gaps and suggestions” in Settings › AI'
    )
    expect(screen.queryByTestId('todo-check-book')).toBeNull()
  })

  it('checks the whole book only on a click, with the estimate in the title', async () => {
    check = todoCheck({
      allowed: true,
      estimateUsd: 0.0012,
      lastAt: '2026-10-09T10:00:00.000Z',
      lastCostUsd: 0.001
    })
    render(<TodoTab />)
    const button = await screen.findByTestId('todo-check-book')
    expect(button).toHaveAttribute('title', expect.stringContaining('about $0.0012'))
    expect(screen.getByText(/^Last checked .* · \$0\.0010$/u)).toBeInTheDocument()
    expect(calls.some(([channel]) => channel === 'todo:check')).toBe(false)

    await userEvent.click(button)
    expect(calls.filter(([channel]) => channel === 'todo:check')).toHaveLength(1)
    expect(useDialogStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'To do: 2 new items.'
    ])
  })

  it('toasts a failed check with its next step', async () => {
    check = todoCheck({ allowed: true, estimateUsd: 0.001 })
    checkResult = {
      ok: false,
      code: 'NO_KEY',
      message: 'No API key.',
      nextStep: 'Add one in Settings › AI.',
      requestId: 'x'
    }
    render(<TodoTab />)
    await userEvent.click(await screen.findByTestId('todo-check-book'))
    expect(useDialogStore.getState().toasts.map((toast) => toast.message)).toEqual([
      'No API key. Add one in Settings › AI.'
    ])
  })
})

describe('the To do store’s suggestions (F-9.16)', () => {
  it('asks once for the card on show and the next card, and never with AI off', async () => {
    items = [todoItem('a', { nodeId: null }), todoItem('b', { nodeId: null }), todoItem('c')]
    await useTodoStore.getState().load()
    useTodoStore.getState().startReview('a')
    await Promise.resolve()
    expect(calls.filter(([channel]) => channel === 'todo:suggest')).toEqual([])

    check = todoCheck({ allowed: true })
    await useTodoStore.getState().load()
    useTodoStore.getState().startReview('a')
    await vi.waitFor(() =>
      expect(useTodoStore.getState().items.find((item) => item.id === 'b')?.suggested).toBe(true)
    )
    const asked = calls
      .filter(([channel]) => channel === 'todo:suggest')
      .map(([, input]) => (input as Input<'todo:suggest'>).id)
    expect(asked).toEqual(['a', 'b'])
    expect(useTodoStore.getState().items.find((item) => item.id === 'a')).toMatchObject({
      suggestions: ['A sinkhole that swallows sound', 'An old quarry'],
      suggested: true
    })

    useTodoStore.getState().reviewAt('b')
    await Promise.resolve()
    expect(calls.filter(([channel]) => channel === 'todo:suggest')).toHaveLength(3)
    expect(calls.filter(([channel]) => channel === 'todo:suggest').at(-1)?.[1]).toMatchObject({
      id: 'c'
    })
  })

  it('keeps a failure on the card and does not ask again', async () => {
    check = todoCheck({ allowed: true })
    suggestResult = {
      ok: false,
      code: 'RATE_LIMIT',
      message: 'Too many requests.',
      nextStep: 'Wait a minute.',
      requestId: 'x'
    }
    items = [todoItem('a', { nodeId: null })]
    await useTodoStore.getState().load()
    await useTodoStore.getState().suggest('a')
    await useTodoStore.getState().suggest('a')
    expect(calls.filter(([channel]) => channel === 'todo:suggest')).toHaveLength(1)
    expect(useTodoStore.getState().suggestErrors).toEqual({
      a: 'Too many requests. Wait a minute.'
    })
  })
})
