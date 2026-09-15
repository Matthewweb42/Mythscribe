import { Editor } from '@tiptap/core'
import { Plugin } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions } from './extensions'
import {
  GHOST_TEXT_CLASS,
  GHOST_TEXT_FLAG_CLASS,
  ghostOf,
  type GhostSettleHandler
} from './ghostText'

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
    expect(ghostOf(editor.state)).toEqual({
      text: SUGGESTION,
      full: SUGGESTION,
      from: CONTENT.length + 1,
      flagged: false,
      violation: null
    })
    expect(widget()?.dataset.flagged).toBe('false')
    expect(widget()?.querySelector(`.${GHOST_TEXT_FLAG_CLASS}`)).toBeNull()
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
    expect(ghostOf(editor.state)?.full).toBe(SUGGESTION)
    press('Tab', true)
    expect(text()).toBe(`${CONTENT} Rain followed. `)
    expect(widget()?.textContent).toBe('Then silence.')
    press('Tab', true)
    press('Tab', true)
    expect(text()).toBe(CONTENT + SUGGESTION)
    expect(widget()).toBeNull()
  })

  it('renders a flagged suggestion with a badge naming the violation and keeps the flag while it is consumed (F-14.7)', () => {
    const violation = 'switches to present tense'
    expect(editor.commands.setGhost(SUGGESTION, true, violation)).toBe(true)
    expect(ghostOf(editor.state)).toEqual({
      text: SUGGESTION,
      full: SUGGESTION,
      from: CONTENT.length + 1,
      flagged: true,
      violation
    })
    expect(widget()?.dataset.flagged).toBe('true')
    const flag = widget()?.querySelector<HTMLElement>(`.${GHOST_TEXT_FLAG_CLASS}`)
    expect(flag?.title).toBe(violation)
    expect(flag?.getAttribute('aria-label')).toBe(`Voice warning: ${violation}`)
    // Accepting one word keeps the flag on what is left, as does typing the next character.
    press('Tab', true)
    expect(ghostOf(editor.state)).toMatchObject({
      text: 'followed. Then silence.',
      flagged: true,
      violation
    })
    expect(widget()?.dataset.flagged).toBe('true')
    editor.commands.insertContent('f')
    expect(ghostOf(editor.state)).toMatchObject({ text: 'ollowed. Then silence.', flagged: true })
    // Accepting the rest inserts the text only, never the badge.
    press('Tab')
    expect(widget()).toBeNull()
    expect(text()).toBe(CONTENT + SUGGESTION)
    expect(editor.view.dom.textContent).toBe(CONTENT + SUGGESTION)
    // A flag without a violation still names the check.
    editor.commands.setGhost(SUGGESTION, true)
    expect(
      widget()?.querySelector<HTMLElement>(`.${GHOST_TEXT_FLAG_CLASS}`)?.getAttribute('aria-label')
    ).toBe('Voice warning: does not match the voice profile')
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

describe('GhostText settlement (F-14.5)', () => {
  let onSettle: ReturnType<typeof vi.fn<GhostSettleHandler>>

  /** The storage slot the controller fills in the app; here a spy listens instead. */
  const listen = (target: Editor = editor): void => {
    target.storage.ghostText!.onSettle = onSettle
  }

  beforeEach(() => {
    onSettle = vi.fn<GhostSettleHandler>()
    listen()
  })

  it('ships an empty hook slot, so an editor nobody listens to settles silently', () => {
    const quiet = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-2' })
    })
    expect(quiet.storage.ghostText).toEqual({ onSettle: null })
    quiet.commands.setGhost(SUGGESTION)
    expect(() => quiet.commands.clearGhost()).not.toThrow()
    quiet.destroy()
  })

  it('Tab settles accepted with the whole text, once', () => {
    editor.commands.setGhost(SUGGESTION)
    expect(onSettle).not.toHaveBeenCalled()
    press('Tab')
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('accepted', SUGGESTION)
    editor.commands.insertContent('x')
    editor.commands.setTextSelection(2)
    expect(onSettle).toHaveBeenCalledTimes(1)
  })

  it('Shift+Tab settles nothing until the last word, then accepted', () => {
    editor.commands.setGhost(SUGGESTION)
    press('Tab', true)
    press('Tab', true)
    press('Tab', true)
    expect(onSettle).not.toHaveBeenCalled()
    press('Tab', true)
    expect(widget()).toBeNull()
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('accepted', SUGGESTION)
  })

  it('typing the suggestion through to its end settles accepted', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.commands.insertContent(' Rain')
    expect(onSettle).not.toHaveBeenCalled()
    editor.commands.insertContent(' followed. Then silence.')
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('accepted', SUGGESTION)
  })

  it('Escape settles rejected when nothing was taken, acceptedPart after a word', () => {
    editor.commands.setGhost(SUGGESTION)
    press('Escape')
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('rejected', '')
    press('Escape')
    expect(onSettle).toHaveBeenCalledTimes(1)

    editor.commands.setGhost(SUGGESTION)
    press('Tab', true)
    press('Escape')
    expect(onSettle).toHaveBeenCalledTimes(2)
    expect(onSettle).toHaveBeenLastCalledWith('acceptedPart', ' Rain ')
  })

  it('a mismatching keystroke settles rejected, or acceptedPart with what was typed along', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.commands.insertContent('x')
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('rejected', '')

    editor.commands.setGhost(SUGGESTION)
    editor.commands.insertContent(' R')
    expect(onSettle).toHaveBeenCalledTimes(1)
    editor.commands.insertContent('x')
    expect(onSettle).toHaveBeenCalledTimes(2)
    expect(onSettle).toHaveBeenLastCalledWith('acceptedPart', ' R')
    expect(text()).toBe(`${CONTENT}x Rx`)
  })

  it('a deletion, a caret move, and a range selection settle rejected', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.commands.deleteRange({
      from: editor.state.selection.from - 1,
      to: editor.state.selection.from
    })
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('rejected', '')

    editor.commands.focus('end')
    editor.commands.setGhost(SUGGESTION)
    editor.commands.setTextSelection(3)
    expect(onSettle).toHaveBeenCalledTimes(2)
    expect(onSettle).toHaveBeenLastCalledWith('rejected', '')

    editor.commands.focus('end')
    editor.commands.setGhost(SUGGESTION)
    editor.commands.setTextSelection({ from: 1, to: CONTENT.length + 1 })
    expect(onSettle).toHaveBeenCalledTimes(3)
    expect(onSettle).toHaveBeenLastCalledWith('rejected', '')
  })

  it('blur and the start of an IME composition settle rejected', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.view.dom.dispatchEvent(new FocusEvent('blur'))
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('rejected', '')

    editor.commands.focus('end')
    editor.commands.setGhost(SUGGESTION)
    editor.view.dom.dispatchEvent(new CompositionEvent('compositionstart'))
    expect(onSettle).toHaveBeenCalledTimes(2)
    expect(onSettle).toHaveBeenLastCalledWith('rejected', '')
  })

  it('a replacement settles the old suggestion on its own and lets the new one settle later', () => {
    editor.commands.setGhost(SUGGESTION)
    press('Tab', true)
    editor.commands.setGhost(' Wind rose.')
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('acceptedPart', ' Rain ')
    expect(ghostOf(editor.state)).toMatchObject({ text: ' Wind rose.', full: ' Wind rose.' })
    press('Tab')
    expect(onSettle).toHaveBeenCalledTimes(2)
    expect(onSettle).toHaveBeenLastCalledWith('accepted', ' Wind rose.')
  })

  it('an unrelated transaction and a plugin reconfigure leave the suggestion and settle nothing', () => {
    editor.commands.setGhost(SUGGESTION)
    editor.view.dispatch(editor.state.tr.setMeta('unrelated', true))
    editor.registerPlugin(new Plugin({}))
    expect(widget()?.textContent).toBe(SUGGESTION)
    expect(onSettle).not.toHaveBeenCalled()
    press('Escape')
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('rejected', '')
  })

  it('an editor torn down with a suggestion showing settles it rejected, once', () => {
    const leaving = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-3' }),
      content: {
        type: 'doc',
        content: [{ type: 'paragraph', content: [{ type: 'text', text: CONTENT }] }]
      }
    })
    leaving.commands.focus('end')
    listen(leaving)
    leaving.commands.setGhost(SUGGESTION)
    leaving.commands.insertContent(' R')
    leaving.destroy()
    expect(onSettle).toHaveBeenCalledExactlyOnceWith('acceptedPart', ' R')
    // Our own editor has nothing showing: destroying it in afterEach settles nothing.
  })
})
