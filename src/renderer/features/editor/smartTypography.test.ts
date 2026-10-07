import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildExtensions } from './extensions'

let editor: Editor

beforeEach(() => {
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => undefined }),
    content: { type: 'doc', content: [{ type: 'paragraph' }] }
  })
  editor.commands.focus('end')
})
afterEach(() => {
  editor.destroy()
})

/** Types `text` one character at a time through ProseMirror's text input path, as a keyboard does. */
function type(text: string): void {
  for (const char of text) {
    const { view } = editor
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) =>
      f(view, from, to, char, () => view.state.tr)
    )
    if (!handled) view.dispatch(view.state.tr.insertText(char, from, to))
  }
}

const text = (): string => editor.state.doc.textContent

describe('SmartTypography', () => {
  it('turns two hyphens into an em dash and three dots into an ellipsis', () => {
    type('She paused--then ran...')
    expect(text()).toBe('She paused—then ran…')
  })

  it('curls double and single quotes by what stands before them', () => {
    type(`"It's late," she said. 'Go.'`)
    expect(text()).toBe('“It’s late,” she said. ‘Go.’')
  })

  it('opens a quote right after an em dash', () => {
    type('He said--"wait"')
    expect(text()).toBe('He said—“wait”')
  })

  it('puts back what was typed on the undo right after a conversion', () => {
    type('a--')
    expect(text()).toBe('a—')
    expect(editor.commands.undoInputRule()).toBe(true)
    expect(text()).toBe('a--')
  })

  it('binds that undo to Ctrl+Z', () => {
    type('a--')
    const press = (): void => {
      const event = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })
      editor.view.someProp('handleKeyDown', (f) => f(editor.view, event))
    }
    press()
    expect(text()).toBe('a--')
    type('b')
    expect(text()).toBe('a--b')
  })
})
