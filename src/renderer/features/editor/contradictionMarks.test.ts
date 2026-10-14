import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { UnderlineView } from '@shared/memory/underlines'
import { findingViewFixture } from '@renderer/features/memory/memoryFixture'
import {
  CARD_CLOSE_DELAY_MS,
  CONTRADICTION_CLASS,
  resetContradictionCardStore,
  useContradictionCardStore,
  type ContradictionCardOpen
} from './contradictionMarks'
import { buildExtensions } from './extensions'
import { resetNameCheck } from './nameCheck'

/**
 * The contradiction underlines (F-16.28, P4-D15): decorations at each quote found inside its
 * paragraph, never in the document, none in the caret's paragraph while the editor has the focus,
 * dropped for a paragraph edited since the last set (kept bare while the document has unsaved
 * edits), reported as drawn, and the hover card opened by hover, a click on a drawn underline or
 * Alt+Enter, and closed when she types in the scene or its underline goes.
 */

const FIRST = 'Mara walked in.'
const BROWN = "Mara's eyes were brown."
let editor: Editor
let onUpdate: () => void

function build(paragraphs: readonly string[] = [FIRST, BROWN], v2 = true): Editor {
  onUpdate = vi.fn()
  editor = new Editor({
    extensions: buildExtensions({
      sceneBreak: '~~~',
      onSave: () => {},
      inlineTagNodeId: 'sc-2',
      inertTags: v2
    }),
    content: {
      type: 'doc',
      content: paragraphs.map((text) => ({ type: 'paragraph', content: [{ type: 'text', text }] }))
    },
    onUpdate
  })
  return editor
}

/** The brown side of Mara's eyes (grey in 1.1), in ¶`para` of this scene. */
function brown(para = 1, quote = "Mara's eyes were brown"): UnderlineView {
  return {
    findingId: 'f-1',
    side: 'b',
    para,
    quote,
    finding: findingViewFixture('f-1', {
      b: {
        kind: 'claim',
        ref: '1.2',
        nodeId: 'sc-2',
        para,
        quote,
        value: 'brown',
        voice: 'narration',
        mode: 'now',
        label: '1.2',
        open: { kind: 'scene', id: 'sc-2', para }
      }
    })
  }
}

const marks = (): HTMLElement[] =>
  Array.from(editor.view.dom.querySelectorAll<HTMLElement>(`.${CONTRADICTION_CLASS}`))

/** Puts the caret at `pos` and gives the editor the focus as Tiptap reports it. */
function caretAt(pos: number): void {
  const { state } = editor.view
  editor.view.dispatch(
    state.tr.setSelection(TextSelection.create(state.doc, pos)).setMeta('focus', { event: null })
  )
}

const blur = (): void => {
  editor.view.dispatch(editor.state.tr.setMeta('blur', { event: null }))
}

beforeEach(() => {
  resetNameCheck()
  resetContradictionCardStore()
})

afterEach(() => {
  vi.useRealTimers()
  editor.destroy()
})

describe('ContradictionMarks (F-16.28)', () => {
  it('underlines the quote inside its paragraph, as a decoration only', () => {
    build()
    const drawn = vi.fn()
    if (editor.storage.contradictionMarks) editor.storage.contradictionMarks.onDrawn = drawn
    editor.commands.setContradictionMarks([brown()])
    const [mark] = marks()
    expect(marks()).toHaveLength(1)
    expect(mark?.textContent).toBe("Mara's eyes were brown")
    expect(mark?.dataset.finding).toBe('f-1')
    expect(mark?.dataset.side).toBe('b')
    expect(drawn).toHaveBeenCalledWith(['f-1'])
    // Never in the document: nothing saved, no edit, nothing in the undo history.
    expect(JSON.stringify(editor.getJSON())).not.toMatch(/contradiction|f-1/u)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(editor.can().undo()).toBe(false)
    // Cleared.
    editor.commands.setContradictionMarks([])
    expect(marks()).toEqual([])
  })

  it('draws nothing for a quote no longer in its paragraph', () => {
    build()
    editor.commands.setContradictionMarks([brown(0)])
    expect(marks()).toEqual([])
    editor.commands.setContradictionMarks([brown(1, "Mara's eyes were grey")])
    expect(marks()).toEqual([])
  })

  it('hides the underline in the caret’s paragraph while the editor has the focus', () => {
    build()
    editor.commands.setContradictionMarks([brown()])
    // The caret in the first paragraph: drawn.
    caretAt(3)
    expect(marks()).toHaveLength(1)
    // In the underlined paragraph: hidden; leaving the editor shows it again.
    caretAt(FIRST.length + 5)
    expect(marks()).toEqual([])
    blur()
    expect(marks()).toHaveLength(1)
  })

  it('drops the underline of a paragraph edited since, until the next refresh', () => {
    build()
    editor.commands.setContradictionMarks([brown()])
    // An edit in another paragraph keeps it.
    editor.commands.insertContentAt(1, 'So ')
    expect(marks()).toHaveLength(1)
    // An edit in its own paragraph drops it.
    editor.commands.insertContentAt(editor.state.doc.content.size - 1, ' Truly.')
    expect(marks()).toEqual([])
    // A refresh while the edit is unsaved keeps that paragraph bare...
    editor.commands.setContradictionMarks([brown()], { keepEdited: true })
    expect(marks()).toEqual([])
    // ... and once it is saved (and read), draws it again.
    editor.commands.setContradictionMarks([brown()])
    expect(marks()).toHaveLength(1)
  })

  it('is left out of a v1 manuscript editor', () => {
    build([FIRST, BROWN], false)
    expect(editor.storage.contradictionMarks).toBeUndefined()
    expect('setContradictionMarks' in editor.commands).toBe(false)
  })

  it('opens the hover card on hover and closes it a moment after the pointer leaves', () => {
    vi.useFakeTimers()
    build()
    editor.commands.setContradictionMarks([brown()])
    const [mark] = marks()
    if (mark === undefined) throw new Error('no underline')
    mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(useContradictionCardStore.getState().card).toMatchObject({
      nodeId: 'sc-2',
      pinned: false,
      underline: { findingId: 'f-1', side: 'b' }
    })
    mark.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body }))
    expect(useContradictionCardStore.getState().card).not.toBeNull()
    vi.advanceTimersByTime(CARD_CLOSE_DELAY_MS + 1)
    expect(useContradictionCardStore.getState().card).toBeNull()
  })

  it('opens the hover card from the keyboard with Alt+Enter in the underlined paragraph', () => {
    build()
    editor.commands.setContradictionMarks([brown()])
    vi.spyOn(editor.view, 'coordsAtPos').mockReturnValue({
      left: 10,
      right: 10,
      top: 20,
      bottom: 30
    })
    const press = (): boolean =>
      editor.view.someProp('handleKeyDown', (handle) =>
        handle(editor.view, new KeyboardEvent('keydown', { key: 'Enter', altKey: true }))
      ) === true
    // Not in the underlined paragraph: Alt+Enter is left alone.
    caretAt(3)
    expect(press()).toBe(false)
    expect(useContradictionCardStore.getState().card).toBeNull()
    caretAt(FIRST.length + 5)
    expect(press()).toBe(true)
    expect(useContradictionCardStore.getState().card).toMatchObject({
      pinned: true,
      keyboard: true,
      x: 10,
      y: 34
    })
  })

  it('opens the hover card pinned on a click on a drawn underline, never on one hidden at the caret', () => {
    build()
    editor.commands.setContradictionMarks([brown()])
    // jsdom has no layout: ProseMirror's own mousedown finds no position and leaves the selection.
    vi.spyOn(editor.view, 'posAtCoords').mockReturnValue(null)
    const pos = FIRST.length + 6
    const card = (): ContradictionCardOpen | null => useContradictionCardStore.getState().card
    const clickAt = (target: Element | null): void => {
      target?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
      const event = new MouseEvent('click', { clientX: 5, clientY: 6 })
      editor.view.someProp('handleClick', (handle) => handle(editor.view, pos, event))
    }
    const [mark] = marks()
    if (mark === undefined) throw new Error('no underline')
    clickAt(mark)
    expect(card()).toMatchObject({ pinned: true, keyboard: false, x: 5 })
    // A hover never unpins it.
    mark.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    expect(card()?.pinned).toBe(true)
    // The caret in its paragraph hides the underline: a click on those words opens nothing.
    resetContradictionCardStore()
    caretAt(pos)
    expect(marks()).toEqual([])
    clickAt(editor.view.dom.querySelectorAll('p')[1] ?? null)
    expect(card()).toBeNull()
    // Nor does a click whose press began elsewhere.
    blur()
    clickAt(null)
    expect(card()).toBeNull()
  })

  it('closes a card of its scene when she types, unless the keyboard opened it, and when its underline goes', () => {
    build()
    editor.commands.setContradictionMarks([brown()])
    const card = (): ContradictionCardOpen | null => useContradictionCardStore.getState().card
    const openCard = (nodeId: string, keyboard: boolean): void => {
      useContradictionCardStore.getState().open({
        underline: brown(),
        nodeId,
        x: 0,
        y: 0,
        pinned: true,
        keyboard,
        returnFocus: () => {}
      })
    }
    openCard('sc-2', false)
    // A selection change keeps it; a keystroke anywhere in the scene closes it.
    caretAt(3)
    expect(card()).not.toBeNull()
    editor.commands.insertContentAt(1, 'So ')
    expect(card()).toBeNull()
    // A keyboard card holds the focus, so an edit elsewhere leaves it; its underline gone, it goes.
    openCard('sc-2', true)
    editor.commands.insertContentAt(1, 'And ')
    expect(card()).not.toBeNull()
    editor.commands.setContradictionMarks([])
    expect(card()).toBeNull()
    // Another scene's card is left alone.
    openCard('sc-9', false)
    editor.commands.insertContentAt(1, 'Then ')
    expect(card()).not.toBeNull()
  })
})
