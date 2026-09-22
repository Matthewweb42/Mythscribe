import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions, EDITOR_CORE_OPTIONS } from './extensions'
import { ghostOf } from './ghostText'

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

  describe('Escape hand-off (F-6.1)', () => {
    /** A real keydown on the editor, with the keyCode ProseMirror's own Escape capture reads; answers whether default was prevented. */
    const escape = (view: Editor): boolean =>
      !view.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Escape',
          keyCode: 27,
          bubbles: true,
          cancelable: true
        })
      )

    it('is left out unless the caller asks for it', () => {
      expect(editor.extensionManager.extensions.some((e) => e.name === 'escapeShortcut')).toBe(
        false
      )
    })

    it('hands a bare Escape to the callback and reports its answer', () => {
      const onEscape = vi.fn<() => boolean>(() => false)
      const view = new Editor({
        extensions: buildExtensions({ sceneBreak: '~~~', onSave, onEscape }),
        content: { type: 'doc', content: [{ type: 'paragraph' }] }
      })
      view.commands.focus()
      // Unused by the callback: ProseMirror still captures Escape, so the key is prevented either way.
      expect(escape(view)).toBe(true)
      expect(onEscape).toHaveBeenCalledTimes(1)
      onEscape.mockReturnValue(true)
      expect(escape(view)).toBe(true)
      expect(onEscape).toHaveBeenCalledTimes(2)
      view.destroy()
    })

    it('runs after ghost text: Escape clears a showing suggestion first, the next one reaches the callback', () => {
      resetTagStore()
      const onEscape = vi.fn<() => boolean>(() => true)
      const view = new Editor({
        extensions: buildExtensions({
          sceneBreak: '~~~',
          onSave,
          onEscape,
          inlineTagNodeId: 'sc-1'
        }),
        content: {
          type: 'doc',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'The storm' }] }]
        }
      })
      view.commands.focus('end')
      expect(view.commands.setGhost(' broke at dusk.')).toBe(true)
      expect(escape(view)).toBe(true)
      expect(ghostOf(view.state)).toBeNull()
      expect(onEscape).not.toHaveBeenCalled()
      expect(escape(view)).toBe(true)
      expect(onEscape).toHaveBeenCalledTimes(1)
      view.destroy()
    })
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
    // The rewrite target (F-14.10) joins with the same document, never in notes.
    expect(tagged.extensionManager.extensions.some((e) => e.name === 'rewriteTarget')).toBe(true)
    expect(editor.extensionManager.extensions.some((e) => e.name === 'rewriteTarget')).toBe(false)
    tagged.destroy()
    for (const name of ['bold', 'italic', 'underline', 'strike', 'code']) {
      expect(marks[name], name).toBeDefined()
    }
  })
})

describe('plain-text copy (F-3.13)', () => {
  /** What the clipboard's text/plain flavour gets for the whole document, as the component builds it. */
  const copiedText = (content: TiptapNodeT, inlineTagNodeId?: string): string => {
    const built = new Editor({
      extensions: buildExtensions({ sceneBreak: '* * *', onSave, inlineTagNodeId }),
      coreExtensionOptions: EDITOR_CORE_OPTIONS,
      content
    })
    built.commands.selectAll()
    const text = built.view.someProp('clipboardTextSerializer', (serialize) =>
      serialize(built.state.selection.content(), built.view)
    )
    built.destroy()
    return text ?? ''
  }
  const paragraph = (text: string): TiptapNodeT => ({
    type: 'paragraph',
    content: [{ type: 'text', text }]
  })

  it('joins paragraphs with one newline, not a blank line', () => {
    expect(copiedText({ type: 'doc', content: [paragraph('One.'), paragraph('Two.')] })).toBe(
      'One.\nTwo.'
    )
  })

  it('keeps a blank line either side of a scene break and shows its text', () => {
    expect(
      copiedText({
        type: 'doc',
        content: [paragraph('One.'), { type: 'sceneBreak' }, paragraph('Two.')]
      })
    ).toBe('One.\n\n* * *\n\nTwo.')
  })

  it('reads an inline tag as the #name it shows', () => {
    resetTagStore()
    const [tag] = tagFixture
    if (!tag) throw new Error('fixture has no tag')
    useTagStore.setState({ byId: { [tag.id]: tag }, ids: [tag.id], loaded: true })
    const text = copiedText(
      {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Enter ' },
              { type: 'inlineTag', attrs: { id: tag.id, name: 'old-name' } },
              { type: 'text', text: '.' }
            ]
          }
        ]
      },
      'sc-1'
    )
    expect(text).toBe(`Enter #${tag.name}.`)
    resetTagStore()
  })
})
