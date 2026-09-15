import { Editor } from '@tiptap/core'
import { closeHistory } from '@tiptap/pm/history'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AI_ORIGIN_KEEP_RATIO, AI_ORIGIN_MARK, aiOriginStats } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import { resetTagStore } from '@renderer/features/tags/tagStore'
import { AI_ORIGIN_CLASS, AI_ORIGIN_KEY, AI_ORIGIN_SELECTOR } from './aiOrigin'
import { buildExtensions } from './extensions'
import { ghostOf } from './ghostText'

let editor: Editor
const CONTENT = 'The storm broke at dusk.'
const SUGGESTION = ' Rain followed. Then silence.'

const press = (key: string, shiftKey = false): boolean =>
  !editor.view.dom.dispatchEvent(
    new KeyboardEvent('keydown', { key, shiftKey, bubbles: true, cancelable: true })
  )

const mark = (proposalId: string, accepted: number): TiptapNodeT['marks'] => [
  { type: AI_ORIGIN_MARK, attrs: { proposalId, accepted } }
]
const inline = (): TiptapNodeT[] => editor.getJSON().content?.[0]?.content ?? []
const spans = (): HTMLElement[] =>
  Array.from(editor.view.dom.querySelectorAll<HTMLElement>(AI_ORIGIN_SELECTOR))
const marked = (): boolean => AI_ORIGIN_KEY.getState(editor.state)?.marked ?? false
/** Ends the undo group, so the next edit is one undo step of its own (history groups adjacent edits within 500 ms). */
const closeUndoGroup = (): void => editor.view.dispatch(closeHistory(editor.state.tr))

/** Shows a suggestion for `proposalId` at the caret and accepts all of it with Tab. */
const accept = (proposalId: string, text = SUGGESTION): void => {
  expect(editor.commands.setGhost(text, false, null, proposalId)).toBe(true)
  expect(press('Tab')).toBe(true)
}

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
  vi.unstubAllGlobals()
})

describe('AiOrigin mark (F-14.6)', () => {
  it('is in the manuscript schema only, and an unmarked document pays nothing', () => {
    expect(editor.schema.marks[AI_ORIGIN_MARK]).toBeDefined()
    expect(marked()).toBe(false)
    editor.commands.insertContent(' More.')
    expect(marked()).toBe(false)
    expect(inline()).toEqual([{ type: 'text', text: `${CONTENT} More.` }])
    const notes = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} })
    })
    expect(notes.schema.marks[AI_ORIGIN_MARK]).toBeUndefined()
    notes.destroy()
  })

  it('accepting a suggestion marks exactly the inserted range with the proposal and renders the span', () => {
    accept('p1')
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: SUGGESTION, marks: mark('p1', SUGGESTION.length) }
    ])
    expect(marked()).toBe(true)
    const [span] = spans()
    expect(spans()).toHaveLength(1)
    expect(span?.className).toBe(AI_ORIGIN_CLASS)
    expect(span?.dataset.proposalId).toBe('p1')
    expect(span?.dataset.accepted).toBe(String(SUGGESTION.length))
    expect(span?.textContent).toBe(SUGGESTION)
    expect(aiOriginStats(editor.getJSON())).toEqual({
      aiChars: SUGGESTION.length,
      totalChars: CONTENT.length + SUGGESTION.length,
      byProposal: { p1: SUGGESTION.length }
    })
  })

  it('word-by-word acceptance yields one span carrying the running total; typing along is unmarked', () => {
    editor.commands.setGhost(SUGGESTION, false, null, 'p1')
    press('Tab', true) // ' Rain '
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: ' Rain ', marks: mark('p1', 6) }
    ])
    press('Tab', true) // 'followed. '
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: ' Rain followed. ', marks: mark('p1', 16) }
    ])
    editor.commands.insertContent('Then ') // typed along: consumed, but the author's
    expect(ghostOf(editor.state)?.text).toBe('silence.')
    press('Tab')
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: ' Rain followed. ', marks: mark('p1', 16) },
      { type: 'text', text: 'Then ' },
      { type: 'text', text: 'silence.', marks: mark('p1', 24) }
    ])
    expect(spans()).toHaveLength(2)
  })

  it('a suggestion without a proposal inserts unmarked', () => {
    editor.commands.setGhost(SUGGESTION)
    press('Tab')
    expect(inline()).toEqual([{ type: 'text', text: CONTENT + SUGGESTION }])
    expect(marked()).toBe(false)
  })

  it('typing at the edge of a span does not extend it', () => {
    accept('p1')
    editor.commands.insertContent(' Wind.')
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: SUGGESTION, marks: mark('p1', SUGGESTION.length) },
      { type: 'text', text: ' Wind.' }
    ])
    editor.commands.setTextSelection(CONTENT.length + 1)
    editor.commands.insertContent(' Quiet.')
    expect(inline()).toEqual([
      { type: 'text', text: `${CONTENT} Quiet.` },
      { type: 'text', text: SUGGESTION, marks: mark('p1', SUGGESTION.length) },
      { type: 'text', text: ' Wind.' }
    ])
  })

  it('typing inside a span leaves the typed text unmarked and splits the span, in one undo step', () => {
    accept('p1')
    const inside = CONTENT.length + 1 + ' Rain'.length
    editor.commands.setTextSelection(inside)
    closeUndoGroup()
    editor.commands.insertContent(' still')
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: ' Rain', marks: mark('p1', SUGGESTION.length) },
      { type: 'text', text: ' still' },
      { type: 'text', text: ' followed. Then silence.', marks: mark('p1', SUGGESTION.length) }
    ])
    expect(spans()).toHaveLength(2)
    editor.commands.undo()
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: SUGGESTION, marks: mark('p1', SUGGESTION.length) }
    ])
  })

  it('replacing a selection inside a span leaves the replacement unmarked', () => {
    accept('p1')
    const start = CONTENT.length + 1 + ' Rain '.length
    editor.commands.setTextSelection({ from: start, to: start + 'followed'.length })
    editor.commands.insertContent('poured')
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: ' Rain ', marks: mark('p1', SUGGESTION.length) },
      { type: 'text', text: 'poured' },
      { type: 'text', text: '. Then silence.', marks: mark('p1', SUGGESTION.length) }
    ])
  })

  it('deleting past the keep ratio clears every span of that proposal and no other; undo restores them', () => {
    accept('p1')
    editor.commands.setTextSelection(CONTENT.length + 1)
    editor.commands.insertContent(' Author.')
    accept('p2', ' Hail came.')
    // Doc: CONTENT + ' Author.' + ' Hail came.'(p2) + SUGGESTION(p1)
    const p1Start = CONTENT.length + 1 + ' Author.'.length + ' Hail came.'.length
    // Delete just under half of p1: it survives with the rest of its accepted text.
    const keep = Math.ceil(SUGGESTION.length * AI_ORIGIN_KEEP_RATIO)
    editor.commands.deleteRange({ from: p1Start, to: p1Start + (SUGGESTION.length - keep) })
    expect(aiOriginStats(editor.getJSON()).byProposal).toEqual({ p2: 11, p1: keep })
    // One more character and it falls under the ratio: p1 is the author's now, p2 untouched.
    closeUndoGroup()
    editor.commands.deleteRange({ from: p1Start, to: p1Start + 1 })
    expect(inline()).toEqual([
      { type: 'text', text: `${CONTENT} Author.` },
      { type: 'text', text: ' Hail came.', marks: mark('p2', 11) },
      { type: 'text', text: SUGGESTION.slice(SUGGESTION.length - keep + 1) }
    ])
    expect(aiOriginStats(editor.getJSON()).byProposal).toEqual({ p2: 11 })
    editor.commands.undo()
    expect(aiOriginStats(editor.getJSON()).byProposal).toEqual({ p2: 11, p1: keep })
  })

  it('clears a proposal split across spans as one, and the flag drops once no span is left', () => {
    accept('p1')
    const inside = CONTENT.length + 1 + ' Rain'.length
    editor.commands.setTextSelection(inside)
    editor.commands.insertContent(' (mine)')
    expect(spans()).toHaveLength(2)
    // Drop the first span entirely: 24 of the 29 accepted characters survive in the second.
    editor.commands.deleteRange({ from: CONTENT.length + 1, to: inside })
    expect(aiOriginStats(editor.getJSON()).byProposal).toEqual({ p1: 24 })
    // Ten more characters of the second span and 14 of 29 is under the ratio: the span goes too.
    const second = CONTENT.length + 1 + ' (mine)'.length
    editor.commands.deleteRange({ from: second, to: second + 10 })
    expect(spans()).toHaveLength(0)
    expect(marked()).toBe(false)
    expect(inline()).toEqual([{ type: 'text', text: `${CONTENT} (mine) Then silence.` }])
  })

  it('a paste inside the app keeps the provenance it carries and parses the span back', () => {
    // jsdom has no ClipboardEvent; `pasteHTML` only constructs one to hand to the paste handlers.
    vi.stubGlobal('ClipboardEvent', class extends Event {})
    editor.view.pasteHTML(
      `<p>Copied <span data-ai-origin data-proposal-id="p9" data-accepted="8">AI text</span> here.</p>`
    )
    expect(inline()).toEqual([
      { type: 'text', text: `${CONTENT}Copied ` },
      { type: 'text', text: 'AI text', marks: mark('p9', 8) },
      { type: 'text', text: ' here.' }
    ])
    expect(marked()).toBe(true)
  })

  it('a suggestion showing inside a span survives the provenance strip of a matching keystroke', () => {
    accept('p1')
    const inside = CONTENT.length + 1 + ' Rain'.length
    editor.commands.setTextSelection(inside)
    editor.commands.setGhost(' still', false, null, 'p2')
    editor.commands.insertContent(' ')
    expect(ghostOf(editor.state)?.text).toBe('still')
    expect(inline()[2]).toEqual({ type: 'text', text: ' ' })
    press('Tab')
    expect(inline()).toEqual([
      { type: 'text', text: CONTENT },
      { type: 'text', text: ' Rain', marks: mark('p1', SUGGESTION.length) },
      { type: 'text', text: ' ' },
      { type: 'text', text: 'still', marks: mark('p2', 5) },
      { type: 'text', text: ' followed. Then silence.', marks: mark('p1', SUGGESTION.length) }
    ])
  })
})
