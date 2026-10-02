import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'
import type { Channel, EventName, EventPayload, Input, Output } from '@shared/ipc/contract'
import { useDialogStore } from '@renderer/features/shell/dialogs/dialogStore'
import { setIpcClient, type IpcClient } from '@renderer/lib/ipc'
import { SpellcheckMenu } from './SpellcheckMenu'
import { resetDictionaryStore, useDictionaryStore } from './dictionaryStore'

type MenuListener = (payload: EventPayload<'spellcheck:menu'>) => void

let listeners: Set<MenuListener>
let adds: string[]
let replaces: string[]
/** When set, `spellcheck:replace` is refused with this message. */
let failReplace: string | null

/** A main that records the two calls the menu makes and lets the test push the menu event. */
function client(): IpcClient {
  return {
    async invoke<C extends Channel>(channel: C, input: Input<C>): Promise<Output<C>> {
      if (channel === 'dictionary:add') {
        const { word } = input as Input<'dictionary:add'>
        adds.push(word)
        return { words: [...adds] } as Output<C>
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
  useDialogStore.setState({ modals: [], toasts: [] })
  listeners = new Set()
  adds = []
  replaces = []
  failReplace = null
  setIpcClient(client())
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
