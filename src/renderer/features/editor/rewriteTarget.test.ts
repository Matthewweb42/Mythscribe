import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { REWRITE_CONTEXT_CHARS } from '@shared/rewrite'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions } from './extensions'
import {
  captureRewriteText,
  passageText,
  REWRITE_TARGET_CLASS,
  rewriteContext,
  rewriteTargetOf
} from './rewriteTarget'

const FIRST = 'The storm broke at dusk. Rain followed.'
/** `FIRST` occupies positions 1–40; the second paragraph's text starts at 42, its tag token sits at 49. */
const FIRST_END = FIRST.length + 1
const SECOND_START = FIRST_END + 2
const SECOND_END = SECOND_START + 'Tagged '.length + 1 + ' after.'.length
const THIRD_START = SECOND_END + 2

let editor: Editor

beforeEach(() => {
  resetTagStore()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: FIRST }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Tagged ' },
            { type: 'inlineTag', attrs: { id: 't1', name: 'dark-forest' } },
            { type: 'text', text: ' after.' }
          ]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'One' },
            { type: 'hardBreak' },
            { type: 'text', text: 'two' }
          ]
        }
      ]
    }
  })
})
afterEach(() => {
  editor.destroy()
})

const select = (from: number, to: number): boolean => editor.commands.setTextSelection({ from, to })
const highlighted = (): string[] =>
  Array.from(editor.view.dom.querySelectorAll(`.${REWRITE_TARGET_CLASS}`)).map(
    (el) => el.textContent ?? ''
  )
/** Each paragraph's text; a tag token or a hard break reads as nothing. */
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => out.push(p.textContent))
  return out
}

describe('captureRewriteText (F-14.10)', () => {
  it('renders the selection with a blank line between paragraphs, tags as #name, breaks as newlines', () => {
    select(FIRST_END - 14, SECOND_END)
    expect(captureRewriteText(editor)).toEqual({
      from: FIRST_END - 14,
      to: SECOND_END,
      text: 'Rain followed.\n\nTagged #dark-forest after.'
    })
    select(THIRD_START, THIRD_START + 7)
    expect(captureRewriteText(editor).text).toBe('One\ntwo')
  })

  it('tightens the range past whitespace, breaks, and block boundaries at either edge', () => {
    select(4, 11) // " storm "
    expect(captureRewriteText(editor)).toEqual({ from: 5, to: 10, text: 'storm' })
    select(FIRST_END, SECOND_END) // from the first paragraph's closing token
    expect(captureRewriteText(editor)).toEqual({
      from: SECOND_START,
      to: SECOND_END,
      text: 'Tagged #dark-forest after.'
    })
    select(THIRD_START + 3, THIRD_START + 7) // from the hard break
    expect(captureRewriteText(editor)).toEqual({
      from: THIRD_START + 4,
      to: THIRD_START + 7,
      text: 'two'
    })
  })

  it('is empty for a caret or a blank selection', () => {
    editor.commands.setTextSelection(5)
    expect(captureRewriteText(editor).text).toBe('')
    select(FIRST_END, SECOND_START) // the two block tokens only
    expect(captureRewriteText(editor).text).toBe('')
  })
})

describe('rewriteContext (F-14.10)', () => {
  it('reads the text each side of the range, with the paragraph seam', () => {
    expect(rewriteContext(editor.state.doc, FIRST_END - 14, FIRST_END)).toEqual({
      before: 'The storm broke at dusk. ',
      after: '\n\nTagged #dark-forest after.\n\nOne\ntwo'
    })
    expect(rewriteContext(editor.state.doc, SECOND_START, SECOND_END).before).toBe(`${FIRST}\n\n`)
  })

  it('caps each window at the contract limit', () => {
    const long = 'word '.repeat(200).trim()
    editor.commands.setContent({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: `${long} MID ${long}` }] }]
    })
    const from = long.length + 2
    const { before, after } = rewriteContext(editor.state.doc, from, from + 3)
    expect(before).toHaveLength(REWRITE_CONTEXT_CHARS)
    expect(before.endsWith('word ')).toBe(true)
    expect(after).toHaveLength(REWRITE_CONTEXT_CHARS)
    expect(after.startsWith(' word')).toBe(true)
  })
})

describe('RewriteTarget extension (F-14.10)', () => {
  it('is only in the manuscript schema, never in notes', () => {
    expect(editor.extensionManager.extensions.some((e) => e.name === 'rewriteTarget')).toBe(true)
    const notes = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} })
    })
    expect(notes.extensionManager.extensions.some((e) => e.name === 'rewriteTarget')).toBe(false)
    notes.destroy()
  })

  it('sets, highlights, and clears the target without touching the document', () => {
    const before = editor.getJSON()
    expect(editor.commands.setRewriteTarget(1, 1, 'x')).toBe(false)
    expect(editor.commands.clearRewriteTarget()).toBe(false)
    expect(editor.commands.setRewriteTarget(1, FIRST_END, FIRST)).toBe(true)
    expect(rewriteTargetOf(editor.state)).toEqual({ from: 1, to: FIRST_END, text: FIRST })
    expect(highlighted()).toEqual([FIRST])
    expect(editor.getJSON()).toEqual(before)
    expect(editor.commands.clearRewriteTarget()).toBe(true)
    expect(rewriteTargetOf(editor.state)).toBeNull()
    expect(highlighted()).toEqual([])
  })

  it('maps through edits outside the passage, at either edge included', () => {
    editor.commands.setRewriteTarget(1, FIRST_END, FIRST)
    editor.commands.insertContentAt(1, 'Well. ')
    expect(rewriteTargetOf(editor.state)).toEqual({ from: 7, to: FIRST_END + 6, text: FIRST })
    editor.commands.insertContentAt(FIRST_END + 6, ' Then silence.')
    expect(rewriteTargetOf(editor.state)).toEqual({ from: 7, to: FIRST_END + 6, text: FIRST })
    editor.commands.insertContentAt(SECOND_START + 30, 'X')
    expect(rewriteTargetOf(editor.state)?.from).toBe(7)
    expect(highlighted()).toEqual([FIRST])
  })

  it('survives a mark-only change and an edit that leaves the text as sent', () => {
    editor.commands.setRewriteTarget(1, FIRST_END, FIRST)
    select(1, 10)
    editor.commands.setBold()
    expect(editor.state.doc.rangeHasMark(1, 10, editor.schema.marks.bold!)).toBe(true)
    expect(rewriteTargetOf(editor.state)).toEqual({ from: 1, to: FIRST_END, text: FIRST })
  })

  it('is dropped by an edit inside the passage or a deletion across it', () => {
    editor.commands.setRewriteTarget(1, FIRST_END, FIRST)
    editor.commands.insertContentAt(5, 'X')
    expect(rewriteTargetOf(editor.state)).toBeNull()
    expect(highlighted()).toEqual([])
    editor.commands.undo()
    editor.commands.setRewriteTarget(1, FIRST_END, FIRST)
    editor.commands.deleteRange({ from: FIRST_END - 3, to: SECOND_START + 3 })
    expect(rewriteTargetOf(editor.state)).toBeNull()
  })

  it('acceptRewrite replaces the passage as prose, marks it AI-origin, selects after it, and undoes as one step', () => {
    editor.commands.setRewriteTarget(1, FIRST_END, FIRST)
    const text = 'The storm came down at dusk.\n\nRain came after.'
    expect(editor.commands.acceptRewrite('', 'p1')).toBe(false)
    expect(editor.commands.acceptRewrite(text, 'p1')).toBe(true)
    expect(paragraphs()).toEqual([
      'The storm came down at dusk.',
      'Rain came after.',
      'Tagged  after.', // the tag token reads as nothing here
      'Onetwo'
    ])
    const spans = editor.view.dom.querySelectorAll('.ai-origin[data-proposal-id="p1"]')
    expect(Array.from(spans).map((s) => s.textContent)).toEqual([
      'The storm came down at dusk.',
      'Rain came after.'
    ])
    expect(spans[0]?.getAttribute('data-accepted')).toBe(String(text.length))
    expect(editor.state.selection.empty).toBe(true)
    expect(editor.state.selection.$from.parent.textContent).toBe('Rain came after.')
    expect(editor.state.selection.$from.parentOffset).toBe('Rain came after.'.length)
    expect(rewriteTargetOf(editor.state)).toBeNull()
    expect(highlighted()).toEqual([])
    expect(editor.commands.acceptRewrite(text, 'p1')).toBe(false)
    editor.commands.undo()
    expect(paragraphs()[0]).toBe(FIRST)
    expect(editor.view.dom.querySelectorAll('.ai-origin')).toHaveLength(0)
  })

  it('acceptRewrite replaces a passage that spans paragraphs, joining what is left', () => {
    select(FIRST_END - 14, SECOND_END)
    const { from, to, text } = captureRewriteText(editor)
    editor.commands.setRewriteTarget(from, to, text)
    expect(editor.commands.acceptRewrite('Rain came. Tagged later.', 'p2')).toBe(true)
    expect(paragraphs()).toEqual(['The storm broke at dusk. Rain came. Tagged later.', 'Onetwo'])
    expect(passageText(editor.state.doc, 1, editor.state.doc.content.size)).toBe(
      'The storm broke at dusk. Rain came. Tagged later.\n\nOne\ntwo'
    )
    expect(editor.getText()).not.toContain('dark-forest')
  })
})
