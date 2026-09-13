import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions } from './extensions'
import { GHOST_TEXT_CLASS, ghostOf } from './ghostText'

let editor: Editor
const CONTENT = 'The storm broke at dusk.'
const SUGGESTION = ' Rain followed. Then silence.'

/** A real keydown on the editor, as the browser sends it; `keyboardShortcut()` would drop the plugin metadata. */
const press = (key: string, shiftKey = false): boolean =>
  !editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  )

const widget = (): HTMLElement | null =>
  editor.view.dom.querySelector<HTMLElement>(`.${GHOST_TEXT_CLASS}`)
const text = (): string => editor.getText()

beforeEach(() => {
  resetTagStore()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: CONTENT }] }]
    }
  })
  editor.commands.focus('end')
})
afterEach(() => {
  editor.destroy()
})

describe('GhostText extension (F-5.3)', () => {
  it('is only in the manuscript schema, never in notes', () => {
    expect(editor.extensionManager.extensions.some((e) => e.name === 'ghostText')).toBe(true)
    const notes = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} })
    })
    expect(notes.extensionManager.extensions.some((e) => e.name === 'ghostText')).toBe(false)
    notes.destroy()
  })

  it('shows the suggestion as a widget at the caret without touching the document', () => {
    const before = editor.getJSON()
    expect(editor.commands.setGhost(SUGGESTION)).toBe(true)
    expect(widget()?.textContent).toBe(SUGGESTION)
    expect(widget()?.getAttribute('aria-hidden')).toBe('true')
    expect(ghostOf(editor.state)).toEqual({ text: SUGGESTION, from: CONTENT.length + 1 })
    expect(editor.getJSON()).toEqual(before)
    expect(text()).toBe(CONTENT)
    expect(editor.commands.setGhost('')).toBe(false)
  })

  it('Tab accepts everything as plain text with the marks at the caret, in one undo step', () => {
    editor.commands.setMark('bold')
    editor.commands.setGhost(SUGGESTION)
    expect(press('Tab')).toBe(true)
    expect(text()).toBe(CONTENT + SUGGESTION)
    expect(widget()).toBeNull()
    expect(ghostOf(editor.state)).toBeNull()
    const inline = editor.getJSON().content?.[0]?.content
    expect(inline).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', marks: [{ type: 'bold' }], text: SUGGESTION }
    ])
    expect(editor.state.selection.from).toBe(CONTENT.length + SUGGESTION.length + 1)
    editor.commands.undo()
    expect(text()).toBe(CONTENT)
  })

  it('Shift+Tab accepts one word with its trailing space and keeps the rest showing', () => {
    editor.commands.setGhost(SUGGESTION)
    expect(press('Tab', true)).toBe(true)
    expect(text()).toBe(`${CONTENT} Rain `)
    expect(widget()?.textContent).toBe('followed. Then silence.')
    expect(ghostOf(editor.state)?.from).toBe(editor.state.selection.from)
    press('Tab', true)
    expect(text()).toBe(`${CONTENT} Rain followed. `)
    expect(widget()?.textContent).toBe('Then silence.')
    press('Tab', true)
    press('Tab', true)
    expect(text()).toBe(CONTENT + SUGGESTION)
    expect(widget()).toBeNull()
  })

  it('Escape clears without inserting; Tab and Escape fall through when nothing is showing', () => {
    editor.commands.setGhost(SUGGESTION)
    expect(press('Escape')).toBe(true)
    expect(widget()).toBeNull()
    expect(text()).toBe(CONTENT)
    expect(editor.commands.clearGhost()).toBe(false)
    expect(editor.commands.acceptGhost()).toBe(false)
    expect(editor.commands.acceptGhostWord()).toBe(false)
    expect(press('Tab')).toBe(false)
    expect(press('Escape')).toBe(false)
    expect(text()).toBe(CONTENT)
  })

  it('typing the suggestion’s next characters consumes them, including a space', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.commands.insertContent(' ')
    expect(widget()?.textContent).toBe('Rain followed. Then silence.')
    editor.commands.insertContent('R')
    editor.commands.insertContent('ai')
    expect(widget()?.textContent).toBe('n followed. Then silence.')
    expect(text()).toBe(`${CONTENT} Rai`)
    editor.commands.insertContent('n followed. Then silence.')
    expect(widget()).toBeNull()
    expect(text()).toBe(CONTENT + SUGGESTION)
  })

  it('typing anything else clears it, as does a deletion', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.commands.insertContent('x')
    expect(widget()).toBeNull()
    expect(text()).toBe(`${CONTENT}x`)
    editor.commands.setGhost(SUGGESTION)
    editor.commands.deleteRange({
      from: editor.state.selection.from - 1,
      to: editor.state.selection.from
    })
    expect(widget()).toBeNull()
  })

  it('moving the caret or selecting a range clears it', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.commands.setTextSelection(3)
    expect(widget()).toBeNull()
    editor.commands.focus('end')
    editor.commands.setGhost(SUGGESTION)
    editor.commands.setTextSelection({ from: 1, to: CONTENT.length + 1 })
    expect(widget()).toBeNull()
  })

  it('survives a transaction that neither edits nor moves the caret', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.view.dispatch(editor.state.tr.setMeta('unrelated', true))
    expect(widget()?.textContent).toBe(SUGGESTION)
  })

  it('clears on blur and on the start of an IME composition', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.view.dom.dispatchEvent(new FocusEvent('blur'))
    expect(widget()).toBeNull()
    editor.commands.focus('end')
    editor.commands.setGhost(SUGGESTION)
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(widget()).toBeNull()
  })
})
