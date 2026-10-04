import { Editor } from '@tiptap/core'
import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { resetActiveEditorStore, useActiveEditorStore } from './activeEditorStore'
import { buildExtensions } from './extensions'
import { FIND_NO_EDITOR, FindBar } from './FindBar'
import { FIND_MATCH_CLASS, findStateOf } from './findReplace'
import { resetFindStore, useFindStore } from './findStore'

const TEXT = 'The cat sat. The cat ran.'

const editors: Editor[] = []

function makeEditor(text: string = TEXT): Editor {
  const editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
  })
  editors.push(editor)
  return editor
}

const status = (): string => screen.getByTestId('find-status').textContent ?? ''
const highlights = (editor: Editor): number =>
  editor.view.dom.querySelectorAll(`.${FIND_MATCH_CLASS}`).length

beforeEach(() => {
  resetFindStore()
  resetActiveEditorStore()
  resetTagStore()
})
afterEach(() => {
  resetFindStore()
  for (const editor of editors.splice(0)) editor.destroy()
})

describe('FindBar (F-3.10)', () => {
  it('renders nothing while closed', () => {
    const { container } = render(<FindBar />)
    expect(container).toBeEmptyDOMElement()
  })

  it('says so and disables its buttons with no document to search', () => {
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(true))
    expect(status()).toBe(FIND_NO_EDITOR)
    expect(screen.getByRole('button', { name: 'Next match' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Replace all' })).toBeDisabled()
  })

  it('finds as the author types, steps with Enter and Shift+Enter, and focuses the field', async () => {
    const user = userEvent.setup()
    const editor = makeEditor()
    useActiveEditorStore.getState().set('sc-1', editor)
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(false))
    const input = screen.getByRole('textbox', { name: 'Find' })
    expect(input).toHaveFocus()
    await user.type(input, 'cat')
    expect(status()).toBe('1 of 2')
    expect(highlights(editor)).toBe(2)
    await user.keyboard('{Enter}')
    expect(status()).toBe('2 of 2')
    const second = findStateOf(editor.state).matches[1]
    expect(editor.state.selection.from).toBe(second?.from)
    await user.keyboard('{Shift>}{Enter}{/Shift}')
    expect(status()).toBe('1 of 2')
    await user.clear(input)
    await user.type(input, 'zebra')
    expect(status()).toBe('No results')
  })

  it('applies the toggles and reports an invalid pattern', async () => {
    const user = userEvent.setup()
    const editor = makeEditor('Cat cat concat')
    useActiveEditorStore.getState().set('sc-1', editor)
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(false))
    await user.type(screen.getByRole('textbox', { name: 'Find' }), 'cat')
    expect(status()).toBe('1 of 3')
    await user.click(screen.getByRole('button', { name: 'Match case' }))
    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute(
      'aria-pressed',
      'true'
    )
    expect(status()).toMatch(/of 2$/)
    await user.click(screen.getByRole('button', { name: 'Whole word' }))
    expect(status()).toBe('1 of 1')
    await user.click(screen.getByRole('button', { name: 'Regular expression' }))
    await user.type(screen.getByRole('textbox', { name: 'Find' }), '(')
    expect(status()).toBe('Invalid pattern')
    expect(highlights(editor)).toBe(0)
  })

  it('replaces one, then all in one undo step, and says how many', async () => {
    const user = userEvent.setup()
    const editor = makeEditor()
    useActiveEditorStore.getState().set('sc-1', editor)
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(true))
    await user.type(screen.getByRole('textbox', { name: 'Find' }), 'cat')
    await user.type(screen.getByRole('textbox', { name: 'Replace with' }), 'dog')
    await user.click(screen.getByRole('button', { name: 'Replace' }))
    expect(editor.state.doc.textContent).toBe('The dog sat. The cat ran.')
    expect(status()).toBe('1 of 1')
    await user.clear(screen.getByRole('textbox', { name: 'Find' }))
    await user.type(screen.getByRole('textbox', { name: 'Find' }), 'The')
    await user.click(screen.getByRole('button', { name: 'Replace all' }))
    expect(editor.state.doc.textContent).toBe('dog dog sat. dog cat ran.')
    expect(status()).toBe('Replaced 2')
    act(() => {
      editor.commands.undo()
    })
    expect(editor.state.doc.textContent).toBe('The dog sat. The cat ran.')
  })

  it('closes on Escape, clearing the highlights', async () => {
    const user = userEvent.setup()
    const editor = makeEditor()
    useActiveEditorStore.getState().set('sc-1', editor)
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(false))
    await user.type(screen.getByRole('textbox', { name: 'Find' }), 'cat')
    expect(highlights(editor)).toBe(2)
    await user.keyboard('{Escape}')
    expect(useFindStore.getState().open).toBe(false)
    expect(screen.queryByRole('search')).toBeNull()
    expect(highlights(editor)).toBe(0)
  })

  it('follows the active editor, clearing the one it leaves', async () => {
    const user = userEvent.setup()
    const first = makeEditor()
    const second = makeEditor('A cat, a cat, a cat.')
    useActiveEditorStore.getState().set('sc-1', first)
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(false))
    await user.type(screen.getByRole('textbox', { name: 'Find' }), 'cat')
    expect(highlights(first)).toBe(2)
    act(() => useActiveEditorStore.getState().set('sc-2', second))
    expect(highlights(first)).toBe(0)
    expect(highlights(second)).toBe(3)
    expect(status()).toBe('1 of 3')
  })

  it('shows and hides the replace row', async () => {
    const user = userEvent.setup()
    render(<FindBar />)
    act(() => useFindStore.getState().openFind(false))
    expect(screen.queryByRole('textbox', { name: 'Replace with' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Toggle replace' }))
    expect(screen.getByRole('textbox', { name: 'Replace with' })).toBeInTheDocument()
  })
})
