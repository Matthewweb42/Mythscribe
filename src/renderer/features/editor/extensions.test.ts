import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TiptapNode } from '@shared/tiptap'
import { buildExtensions } from './extensions'

let editor: Editor
let onSave: () => void

beforeEach(() => {
  onSave = vi.fn()
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Hello' }] }]
    }
  })
})
afterEach(() => {
  editor.destroy()
})

describe('buildExtensions', () => {
  it('inserts a scene break that renders the configured text and opens a paragraph after it', () => {
    editor.commands.focus('end')
    expect(editor.commands.insertSceneBreak()).toBe(true)

    const types = editor.getJSON().content?.map((n) => n.type)
    expect(types).toEqual(['paragraph', 'sceneBreak', 'paragraph'])
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
    expect(editor.state.selection.from).toBe(editor.state.doc.content.size - 1)
    expect(editor.getHTML()).toContain('<div data-scene-break="" class="scene-break">~~~</div>')
  })

  it('splits a paragraph around a scene break inserted mid-text', () => {
    editor.commands.setTextSelection(3) // He|llo
    editor.commands.insertSceneBreak()
    // Paragraphs carry TextAlign's `attrs`, so match the structure rather than the exact JSON.
    expect(editor.getJSON().content).toMatchObject([
      { type: 'paragraph', content: [{ type: 'text', text: 'He' }] },
      { type: 'sceneBreak' },
      { type: 'paragraph', content: [{ type: 'text', text: 'llo' }] }
    ])
    expect(editor.state.selection.from).toBe(6) // start of "llo"
  })

  it('round-trips the document through the shared TiptapNode schema and the HTML parser', () => {
    editor.commands.focus('end')
    editor.commands.insertSceneBreak()
    editor.commands.insertContent('After')
    const json = editor.getJSON()
    const parsed = TiptapNode.parse(json)
    expect(parsed).toEqual(json)

    const reloaded = new Editor({ extensions: buildExtensions({ sceneBreak: '~~~', onSave }) })
    reloaded.commands.setContent(parsed)
    expect(reloaded.getJSON()).toEqual(json)
    reloaded.commands.setContent(editor.getHTML())
    expect(reloaded.getJSON()).toEqual(json)
    reloaded.destroy()
  })

  it('stores no text in the scene break, so the configured style applies to old breaks', () => {
    editor.commands.focus('end')
    editor.commands.insertSceneBreak()
    const json = editor.getJSON()
    expect(json.content?.[1]).toEqual({ type: 'sceneBreak' })

    const restyled = new Editor({ extensions: buildExtensions({ sceneBreak: '###', onSave }) })
    restyled.commands.setContent(json)
    expect(restyled.getHTML()).toContain('class="scene-break">###</div>')
    restyled.destroy()
  })

  it('runs onSave for Mod-s and swallows the key (F-3.2)', () => {
    const keydown = (key: string, init: KeyboardEventInit): boolean =>
      editor.view.someProp('handleKeyDown', (f) =>
        f(editor.view, new KeyboardEvent('keydown', { key, ...init }))
      ) === true
    // `Mod` resolves to Ctrl here (jsdom is not a Mac platform) and to Cmd on macOS.
    expect(keydown('s', { ctrlKey: true })).toBe(true)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(keydown('s', {})).toBe(false)
    expect(onSave).toHaveBeenCalledTimes(1)
    expect(editor.getText()).toBe('Hello')
  })

  it('offers headings 1–3 only', () => {
    editor.commands.selectAll()
    expect(editor.can().toggleHeading({ level: 3 })).toBe(true)
    expect(editor.can().toggleHeading({ level: 4 })).toBe(false)
    expect(editor.commands.toggleHeading({ level: 4 })).toBe(false)
    expect(editor.getJSON().content?.[0]?.type).toBe('paragraph')
  })

  it('leaves lists, links, code blocks, and horizontal rules out of the schema', () => {
    const { nodes, marks } = editor.schema
    for (const name of ['bulletList', 'orderedList', 'listItem', 'codeBlock', 'horizontalRule']) {
      expect(nodes[name], name).toBeUndefined()
    }
    expect(marks.link).toBeUndefined()
    for (const name of ['paragraph', 'heading', 'blockquote', 'hardBreak', 'sceneBreak']) {
      expect(nodes[name], name).toBeDefined()
    }
    // The inline tag token (F-4.6) joins only with a document to link to.
    expect(nodes.inlineTag).toBeUndefined()
    const tagged = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave, inlineTagNodeId: 'sc-1' })
    })
    expect(tagged.schema.nodes.inlineTag).toBeDefined()
    tagged.destroy()
    for (const name of ['bold', 'italic', 'underline', 'strike', 'code']) {
      expect(marks[name], name).toBeDefined()
    }
  })
})
