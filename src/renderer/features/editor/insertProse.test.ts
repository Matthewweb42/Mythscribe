import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildExtensions } from './extensions'
import { insertProse } from './insertProse'

let editor: Editor

beforeEach(() => {
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Before after.' }] }]
    }
  })
})
afterEach(() => {
  editor.destroy()
})

/** Each paragraph's text, a hard break as a newline. */
const paragraphs = (): string[] => {
  const out: string[] = []
  editor.state.doc.forEach((p) => {
    out.push(p.textBetween(0, p.content.size, '', (n) => (n.type.name === 'hardBreak' ? '\n' : '')))
  })
  return out
}

describe('insertProse (F-14.10)', () => {
  it('inserts a single line as plain text and returns the position after it', () => {
    const tr = editor.state.tr
    const end = insertProse(tr, 8, 'and ')
    editor.view.dispatch(tr)
    expect(end).toBe(12)
    expect(paragraphs()).toEqual(['Before and after.'])
  })

  it('splits paragraphs on blank lines, keeping the text before the insert in the first one', () => {
    const tr = editor.state.tr
    const end = insertProse(tr, 8, 'one.\n\ntwo.\n \n three.')
    editor.view.dispatch(tr)
    expect(paragraphs()).toEqual(['Before one.', 'two.', 'three.after.'])
    // Two block tokens per split: past `text.length` by four, minus the whitespace the breaks ate.
    expect(editor.state.doc.textBetween(end, editor.state.doc.content.size)).toBe('after.')
  })

  it('turns a single newline into a hard break', () => {
    const tr = editor.state.tr
    const end = insertProse(tr, 8, 'one\ntwo ')
    editor.view.dispatch(tr)
    expect(paragraphs()).toEqual(['Before one\ntwo after.'])
    expect(editor.getJSON().content?.[0]?.content?.[1]).toEqual({ type: 'hardBreak' })
    expect(editor.state.doc.textBetween(end, editor.state.doc.content.size)).toBe('after.')
  })
})
