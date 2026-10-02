import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SpellcheckMenu } from './SpellcheckMenu'
import { resetDictionaryStore, useDictionaryStore } from './dictionaryStore'
import { resetNameMenuStore, useNameMenuStore } from './nameCheck'

type MenuListener = (payload: EventPayload<'spellcheck:menu'>) => void

let listeners: Set<MenuListener>
let adds: string[]
let replaces: string[]
/** The words `dictionary:notName` was asked to remember (F-3.14). */
let dismissed: string[]
/** When set, `spellcheck:replace` is refused with this message. */
let failReplace: string | null

/** A main that records the two calls the menu makes and lets the test push the menu event. */
function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'dictionary:add') {
        const { word } = input as Input<'dictionary:add'>
        adds.push(word)
        return { words: [...adds], notNames: [] } as Output<C>
      }
      if (channel === 'dictionary:notName') {
        dismissed.push((input as Input<'dictionary:notName'>).word)
        return {
          words: [...adds],
          notNames: dismissed.map((word) => word.toLocaleLowerCase())
        } as Output<C>
      }
      if (channel === 'spellcheck:replace') {
        if (failReplace !== null) throw new Error(failReplace)
        replaces.push((input as Input<'spellcheck:replace'>).word)
        return null as Output<C>
      }
      throw new Error(`unexpected ${channel}`)
    },
    on<E extends EventName>(event: E, listener: (payload: EventPayload<E>) => void): () => void {
      if (event !== 'spellcheck:menu') return () => {}
      const mine = listener as MenuListener
      listeners.add(mine)
      return () => listeners.delete(mine)
    }
  }
}

/** Main's side of a right-click on an underlined word: the event to every subscribed window. */
function pushMenu(word: string, suggestions: string[]): void {
  act(() => {
    for (const listener of listeners) listener({ word, suggestions })
  })
}

/** The app with one editable; a right-click in it is what the menu remembers. */
function open(): HTMLTextAreaElement {
  render(
    <>
      <textarea aria-label="Scene" defaultValue="She would recieve Zorvath." />
      <SpellcheckMenu />
    </>
  )
  return screen.getByRole<HTMLTextAreaElement>('textbox', { name: 'Scene' })
}

/** What the browser does on a right-click in the editable: focus it, then `contextmenu`. */
function rightClick(target: HTMLElement, x: number, y: number): void {
  target.focus()
  fireEvent.contextMenu(target, { clientX: x, clientY: y })
}

const items = (): string[] => screen.getAllByRole('menuitem').map((item) => item.textContent ?? '')

beforeEach(() => {
  resetDictionaryStore()
  resetNameMenuStore()
  dismissed = []
  useDialogStore.setState({ modals: [], toasts: [] })
  listeners = new Set()
  adds = []
  replaces = []
  failReplace = null
  setIpcClient(client())
})

afterEach(() => {
  resetNameMenuStore()
})

describe('SpellcheckMenu (F-3.11)', () => {
  it('shows nothing until main reports a misspelled word', () => {
    const scene = open()
    rightClick(scene, 40, 60)
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })

  it('opens where the right-click landed, with the suggestions and the dictionary item', () => {
    const scene = open()
    rightClick(scene, 40, 60)
    pushMenu('recieve', ['receive', 'relieve'])
    expect(items()).toEqual(['receive', 'relieve', 'Add to project dictionary'])
    expect(screen.getByRole('menu')).toHaveStyle({ left: '40px', top: '60px' })
  })

  it('replaces the word with the chosen suggestion, with the focus back in the editable', async () => {
    const scene = open()
    rightClick(scene, 40, 60)
    pushMenu('recieve', ['receive', 'relieve'])
    // The open menu holds the focus, which is why choosing has to give it back.
    expect(scene).not.toHaveFocus()
    await userEvent.click(screen.getByRole('menuitem', { name: 'relieve' }))
    expect(replaces).toEqual(['relieve'])
    expect(adds).toEqual([])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(scene).toHaveFocus()
  })

  it('adds the word to the project dictionary', async () => {
    const scene = open()
    rightClick(scene, 40, 60)
    pushMenu('Zorvath', [])
    expect(items()).toEqual(['No suggestions', 'Add to project dictionary'])
    expect(screen.getByRole('menuitem', { name: 'No suggestions' })).toBeDisabled()
    await userEvent.click(screen.getByRole('menuitem', { name: 'Add to project dictionary' }))
    await waitFor(() => expect(useDictionaryStore.getState().words).toEqual(['Zorvath']))
    expect(adds).toEqual(['Zorvath'])
    expect(replaces).toEqual([])
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(scene).toHaveFocus()
  })

  it('gives the focus back when the menu is closed without a choice', async () => {
    const scene = open()
    rightClick(scene, 40, 60)
    pushMenu('recieve', ['receive'])
    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(scene).toHaveFocus()
    expect(replaces).toEqual([])
  })

  it('toasts a refused replacement', async () => {
    const scene = open()
    rightClick(scene, 40, 60)
    pushMenu('recieve', ['receive'])
    failReplace = 'The window is gone'
    await userEvent.click(screen.getByRole('menuitem', { name: 'receive' }))
    await waitFor(() =>
      expect(useDialogStore.getState().toasts.map((t) => t.message)).toEqual(['The window is gone'])
    )
  })

  it('stops listening when it unmounts', () => {
    const { unmount } = render(<SpellcheckMenu />)
    expect(listeners.size).toBe(1)
    unmount()
    expect(listeners.size).toBe(0)
  })
})

describe('SpellcheckMenu near-name menu (F-3.14)', () => {
  /** What the editor's name check does on a right-click on an underlined near miss. */
  function openNameMenu(replace: () => void = () => {}): void {
    act(() => {
      useNameMenuStore.getState().open({ x: 12, y: 34, word: 'Marra', spelling: 'Mara', replace })
    })
  }

  it('offers the known spelling, then Not a name, where the right-click landed', () => {
    open()
    openNameMenu()
    expect(items()).toEqual(['Mara', 'Not a name'])
    expect(screen.getByRole('menu')).toHaveStyle({ left: '12px', top: '34px' })
  })

  it('puts the known spelling in and closes', async () => {
    const scene = open()
    rightClick(scene, 12, 34)
    const replace = vi.fn()
    openNameMenu(replace)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Mara' }))
    expect(replace).toHaveBeenCalledTimes(1)
    expect(dismissed).toEqual([])
    expect(replaces).toEqual([])
    expect(useNameMenuStore.getState().menu).toBeNull()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(scene).toHaveFocus()
  })

  it('remembers the word as not a name for the project', async () => {
    const scene = open()
    rightClick(scene, 12, 34)
    const replace = vi.fn()
    openNameMenu(replace)
    await userEvent.click(screen.getByRole('menuitem', { name: 'Not a name' }))
    await waitFor(() => expect(useDictionaryStore.getState().notNames).toEqual(['marra']))
    expect(dismissed).toEqual(['Marra'])
    expect(replace).not.toHaveBeenCalled()
    expect(useNameMenuStore.getState().menu).toBeNull()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(scene).toHaveFocus()
  })

  it('clears the store when it is closed without a choice', async () => {
    const scene = open()
    rightClick(scene, 12, 34)
    openNameMenu()
    await userEvent.keyboard('{Escape}')
    expect(useNameMenuStore.getState().menu).toBeNull()
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
    expect(scene).toHaveFocus()
  })

  it('shows one menu at a time: each closes the other', () => {
    const scene = open()
    rightClick(scene, 40, 60)
    pushMenu('recieve', ['receive'])
    openNameMenu()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(items()).toEqual(['Mara', 'Not a name'])
    pushMenu('recieve', ['receive'])
    expect(useNameMenuStore.getState().menu).toBeNull()
    expect(screen.getAllByRole('menu')).toHaveLength(1)
    expect(items()).toEqual(['receive', 'Add to project dictionary'])
    openNameMenu()
    act(() => useNameMenuStore.getState().close())
    // The spelling menu was closed by the near-name one, not hidden behind it.
    expect(screen.queryByRole('menu')).not.toBeInTheDocument()
  })
})
