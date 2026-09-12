import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Tag } from '@shared/ipc/contract'
import { TiptapNode } from '@shared/tiptap'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions } from './extensions'
import { INLINE_TAG_SUGGESTION_KEY, resyncInlineTags, suggestItems } from './InlineTag'

const token = (id: string, name: string) => ({ type: 'inlineTag', attrs: { id, name } })
const bank = (): Tag[] => tagFixture

let editor: Editor

beforeEach(() => {
  resetTagStore()
  const byId: Record<string, Tag> = {}
  for (const tag of tagFixture) byId[tag.id] = tag
  useTagStore.setState({ byId, ids: tagFixture.map((t) => t.id), loaded: true })
  editor = new Editor({
    extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' }),
    content: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Into the ' }] }]
    }
  })
})
afterEach(() => {
  editor.destroy()
})

describe('suggestItems (F-4.6)', () => {
  it('lists every tag for an empty query, with no Create row', () => {
    expect(suggestItems(bank(), '')).toEqual(tagFixture.map((tag) => ({ kind: 'tag', tag })))
  })

  it('filters by name substring, case-insensitive, and offers to create the kebab-cased text', () => {
    expect(suggestItems(bank(), 'MO')).toEqual([
      { kind: 'tag', tag: tagFixture[2] },
      { kind: 'create', name: 'mo' }
    ])
    expect(suggestItems(bank(), 'Dark_Woods')).toEqual([{ kind: 'create', name: 'dark-woods' }])
  })

  it('hides the Create row for an exact match of an existing name, or text that kebab-cases to nothing', () => {
    expect(suggestItems(bank(), 'mara')).toEqual([{ kind: 'tag', tag: tagFixture[1] }])
    expect(suggestItems(bank(), 'MARA')).toEqual([{ kind: 'tag', tag: tagFixture[1] }])
    expect(suggestItems(bank(), '--')).toEqual([])
  })
})

describe('InlineTag node (F-4.6)', () => {
  it('is an inline atom that takes no marks and inserts with a plain space after it', () => {
    const type = editor.schema.nodes.inlineTag
    expect(type).toBeDefined()
    expect(type?.isInline).toBe(true)
    expect(type?.isAtom).toBe(true)
    expect(type?.spec.selectable).toBe(true)
    expect(type?.spec.draggable).toBe(false)
    editor.commands.focus('end')
    editor.commands.setMark('bold')
    editor.commands.insertContent([token('t-forest', 'dark-forest'), { type: 'text', text: ' ' }])
    const paragraph = editor.getJSON().content?.[0]?.content
    expect(paragraph).toMatchObject([
      { type: 'text', text: 'Into the ' },
      { type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } },
      { type: 'text', text: ' ' }
    ])
    expect(paragraph?.[1]?.marks).toBeUndefined()
    expect(paragraph?.[2]?.marks).toBeUndefined()
  })

  it('renders the bank’s live name and color, falling back to the stored name for a deleted tag', () => {
    editor.commands.focus('end')
    editor.commands.insertContent([token('t-forest', 'old-name'), token('t-gone', 'gone-tag')])
    const html = editor.getHTML()
    expect(html).toContain(
      '<span data-id="t-forest" data-name="old-name" data-inline-tag="" class="inline-tag" style="--tag-color: #ea580c;">#dark-forest</span>'
    )
    expect(html).toContain(
      '<span data-id="t-gone" data-name="gone-tag" data-inline-tag="" class="inline-tag">#gone-tag</span>'
    )
  })

  it('round-trips through the shared TiptapNode schema and the HTML parser (copy and paste)', () => {
    editor.commands.focus('end')
    editor.commands.insertContent([token('t-forest', 'dark-forest'), { type: 'text', text: ' on' }])
    const json = editor.getJSON()
    expect(TiptapNode.parse(json)).toEqual(json)
    const reloaded = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {}, inlineTagNodeId: 'sc-1' })
    })
    reloaded.commands.setContent(editor.getHTML())
    expect(reloaded.getJSON()).toEqual(json)
    reloaded.destroy()
  })

  it('Backspace after a token removes the whole token', () => {
    editor.commands.focus('end')
    editor.commands.insertContent([token('t-forest', 'dark-forest')])
    expect(editor.getText()).toBe('Into the ')
    expect(
      editor.commands.deleteRange({
        from: editor.state.selection.from - 1,
        to: editor.state.selection.from
      })
    ).toBe(true)
    expect(editor.getJSON().content?.[0]?.content).toEqual([{ type: 'text', text: 'Into the ' }])
  })

  it('resyncInlineTags repaints name and color from the bank and strips a deleted tag’s color', () => {
    editor.commands.focus('end')
    editor.commands.insertContent([token('t-forest', 'old-name'), token('t-mara', 'mara')])
    const spans = editor.view.dom.querySelectorAll<HTMLElement>('[data-inline-tag]')
    expect(spans).toHaveLength(2)
    resyncInlineTags(editor.view.dom, {
      't-forest': { ...tagFixture[0]!, name: 'gloomy-wood', color: '#112233' }
    })
    expect(spans[0]?.textContent).toBe('#gloomy-wood')
    expect(spans[0]?.style.getPropertyValue('--tag-color')).toBe('#112233')
    expect(spans[1]?.textContent).toBe('#mara')
    expect(spans[1]?.style.getPropertyValue('--tag-color')).toBe('')
    // The document itself is untouched: the stored name stays what it was at insertion.
    expect(TiptapNode.parse(editor.getJSON()).content?.[0]?.content?.[1]?.attrs).toEqual({
      id: 't-forest',
      name: 'old-name'
    })
  })

  it('leaves the token and the suggestion out of a schema built without a node id (notes)', () => {
    const notes = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} })
    })
    expect(notes.schema.nodes.inlineTag).toBeUndefined()
    expect(INLINE_TAG_SUGGESTION_KEY.get(notes.state)).toBeUndefined()
    expect(INLINE_TAG_SUGGESTION_KEY.get(editor.state)).toBeDefined()
    notes.destroy()
  })
})
