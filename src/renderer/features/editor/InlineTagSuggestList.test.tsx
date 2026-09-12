import { createRef } from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, Input, Output, Tag } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { IpcRequestError, setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import type { InlineTagAttrs, SuggestItem } from './InlineTag'
import { InlineTagSuggestList, type InlineTagSuggestListHandle } from './InlineTagSuggestList'

const items: SuggestItem[] = [
  { kind: 'tag', tag: tagFixture[0]! },
  { kind: 'tag', tag: tagFixture[2]! },
  { kind: 'create', name: 'brand-new' }
]

function install(create: (input: Input<'tag:create'>) => Tag): Input<'tag:create'>[] {
  const calls: Input<'tag:create'>[] = []
  const client: IpcClient = {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel !== 'tag:create') throw new Error(`unexpected ${channel}`)
      const value = input as Input<'tag:create'>
      calls.push(value)
      return create(value) as Output<C>
    },
    on: () => () => {}
  }
  setIpcClient(client)
  return calls
}

const created: Tag = { ...tagFixture[2]!, id: 't-new', name: 'brand-new', category: 'custom' }

function mount(list: SuggestItem[] = items, loading = false) {
  const ref = createRef<InlineTagSuggestListHandle>()
  const command = vi.fn<(attrs: InlineTagAttrs) => void>()
  const view = render(
    <InlineTagSuggestList ref={ref} items={list} loading={loading} command={command} />
  )
  const key = (name: string): boolean => {
    let handled = false
    act(() => {
      handled = ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: name })) ?? false
    })
    return handled
  }
  return { ref, command, view, key }
}

const selected = (): string[] =>
  screen.getAllByRole('option', { selected: true }).map((o) => o.textContent ?? '')
const options = (): string[] => screen.getAllByRole('option').map((o) => o.textContent ?? '')

beforeEach(() => {
  resetTagStore()
  useDialogStore.setState({ modals: [], toasts: [] })
})

describe('InlineTagSuggestList (F-4.6)', () => {
  it('lists the tags with their colors and the Create row, first row active', () => {
    mount()
    expect(screen.getByRole('listbox', { name: 'Tag suggestions' })).toBeInTheDocument()
    expect(options()).toEqual(['dark-forest', 'moody', 'Create #brand-new'])
    expect(selected()).toEqual(['dark-forest'])
    const dot = screen
      .getByRole('option', { name: 'dark-forest' })
      .querySelector('span[aria-hidden]')
    expect(dot).toHaveStyle({ backgroundColor: '#ea580c' })
  })

  it('renders nothing without rows, and swallows no keys then', () => {
    const { key, command } = mount([], true)
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument()
    expect(key('Enter')).toBe(false)
    expect(key('ArrowDown')).toBe(false)
    expect(command).not.toHaveBeenCalled()
  })

  it('ArrowDown and ArrowUp move the active row and wrap; other keys fall through', () => {
    const { key } = mount()
    expect(key('ArrowDown')).toBe(true)
    expect(selected()).toEqual(['moody'])
    key('ArrowDown')
    key('ArrowDown')
    expect(selected()).toEqual(['dark-forest'])
    key('ArrowUp')
    expect(selected()).toEqual(['Create #brand-new'])
    expect(key('a')).toBe(false)
    expect(key('Escape')).toBe(false)
  })

  it('Enter and Tab insert the active tag through command', () => {
    const { key, command } = mount()
    expect(key('Enter')).toBe(true)
    expect(command).toHaveBeenCalledWith({ id: 't-forest', name: 'dark-forest' })
    key('ArrowDown')
    expect(key('Tab')).toBe(true)
    expect(command).toHaveBeenLastCalledWith({ id: 't-moody', name: 'moody' })
  })

  it('a click inserts too, keeping the editor’s focus (mousedown is prevented)', async () => {
    const { command } = mount()
    const row = screen.getByRole('option', { name: 'moody' })
    const mousedown = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    act(() => {
      row.dispatchEvent(mousedown)
    })
    expect(mousedown.defaultPrevented).toBe(true)
    await userEvent.click(row)
    expect(command).toHaveBeenCalledWith({ id: 't-moody', name: 'moody' })
  })

  it('the Create row creates a custom tag from the text, merges it, then inserts the stored row', async () => {
    const calls = install(() => created)
    const { key, command } = mount()
    key('ArrowUp')
    expect(key('Tab')).toBe(true)
    expect(calls).toEqual([{ name: 'brand-new', category: 'custom' }])
    await waitFor(() => expect(command).toHaveBeenCalledWith({ id: 't-new', name: 'brand-new' }))
    expect(useTagStore.getState().byId['t-new']).toEqual(created)
  })

  it('a failed create toasts and inserts nothing', async () => {
    install(() => {
      throw new IpcRequestError({
        code: 'ALREADY_EXISTS',
        message: 'A tag named "brand-new" exists'
      })
    })
    const { key, command } = mount()
    key('ArrowUp')
    key('Enter')
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual([
        'A tag named "brand-new" exists'
      ])
    )
    expect(command).not.toHaveBeenCalled()
  })

  it('a new list of rows returns the highlight to the first row, even when the old index still fits', () => {
    const { view, key } = mount()
    key('ArrowDown')
    expect(selected()).toEqual(['moody'])
    // Narrowed by typing: two rows, so index 1 would still be a valid (wrong) pick.
    view.rerender(
      <InlineTagSuggestList
        items={[items[0]!, items[2]!]}
        loading={false}
        command={() => undefined}
      />
    )
    expect(selected()).toEqual(['dark-forest'])
  })

  it('the pointer moving over a row highlights it; a row merely appearing under it does not', () => {
    mount()
    const [, second] = screen.getAllByRole('option')
    fireEvent.mouseEnter(second!)
    expect(selected()).toEqual(['dark-forest'])
    fireEvent.mouseMove(second!)
    expect(selected()).toEqual(['moody'])
  })
})
