import { Editor } from '@tiptap/core'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { Tag } from '@shared/ipc/contract'
import { TAG_RANGE_MARK } from '@shared/tagRanges'
import type { TiptapNodeT } from '@shared/tiptap'
import { tagFixture } from '@renderer/features/tags/tagFixture'
import { resetTagStore, useTagStore } from '@renderer/features/tags/tagStore'
import { buildExtensions, manuscriptSchema } from './extensions'
import {
  blockTagsOf,
  TAG_RANGE_BLOCK_CLASS,
  TAG_RANGE_KEY,
  TAG_RANGE_RUN_CLASS,
  TAG_RANGE_SELECTOR,
  tagRunsOf
} from './TagRange'

const TEXT = 'Mara waited by the gate.'
const range = (tagId: string) => ({ type: TAG_RANGE_MARK, attrs: { tagId } })

let editor: Editor
let onTagSelection: Mock<(editor: Editor) => void>

const loadBank = (): void => {
  const byId: Record<string, Tag> = {}
  for (const tag of tagFixture) byId[tag.id] = tag
  useTagStore.setState({ byId, ids: tagFixture.map((t) => t.id), loaded: true })
}

const mount = (content: TiptapNodeT): void => {
  editor = new Editor({
    extensions: buildExtensions({
      sceneBreak: '~~~',
      onSave: () => {},
      inlineTagNodeId: 'sc-1',
      onTagSelection: (e) => onTagSelection(e)
    }),
    content
  })
}

const paragraphs = (...texts: TiptapNodeT[][]): TiptapNodeT => ({
  type: 'doc',
  content: texts.map((content) => ({ type: 'paragraph', content }))
})

const inline = (index = 0): TiptapNodeT[] => editor.getJSON().content?.[index]?.content ?? []
const tag = (from: number, to: number, tagId: string): void => {
  editor.chain().setTextSelection({ from, to }).setTagRange(tagId).run()
}
const runs = (): HTMLElement[] =>
  Array.from(editor.view.dom.querySelectorAll<HTMLElement>(`.${TAG_RANGE_RUN_CLASS}`))

beforeEach(() => {
  resetTagStore()
  loadBank()
  onTagSelection = vi.fn<(editor: Editor) => void>()
  mount(paragraphs([{ type: 'text', text: TEXT }]))
})
afterEach(() => {
  editor.destroy()
  resetTagStore()
})

describe('TagRange mark (F-4.8)', () => {
  it('is a non-inclusive mark that excludes nothing, in the manuscript and the preview schema', () => {
    const type = editor.schema.marks[TAG_RANGE_MARK]
    expect(type).toBeDefined()
    expect(type?.spec.inclusive).toBe(false)
    expect(type?.excludes(type)).toBe(false)
    expect(manuscriptSchema('~~~').marks[TAG_RANGE_MARK]).toBeDefined()
    const notes = new Editor({
      extensions: buildExtensions({ sceneBreak: '~~~', onSave: () => {} })
    })
    expect(notes.schema.marks[TAG_RANGE_MARK]).toBeUndefined()
    notes.destroy()
  })

  it('tags the selection and refuses an empty one', () => {
    expect(editor.chain().setTextSelection(3).setTagRange('t-mara').run()).toBe(false)
    tag(1, 5, 't-mara')
    expect(inline()).toEqual([
      { type: 'text', text: 'Mara', marks: [range('t-mara')] },
      { type: 'text', text: ' waited by the gate.' }
    ])
    const span = editor.view.dom.querySelector<HTMLElement>(TAG_RANGE_SELECTOR)
    expect(span).toHaveAttribute('data-tag-id', 't-mara')
  })

  it('joins the same tag over overlapping or touching text into one range', () => {
    tag(1, 5, 't-mara')
    tag(3, 12, 't-mara')
    tag(12, 15, 't-mara')
    expect(inline()).toEqual([
      { type: 'text', text: 'Mara waited by', marks: [range('t-mara')] },
      { type: 'text', text: ' the gate.' }
    ])
    expect(tagRunsOf(editor.state.doc)).toEqual([{ from: 1, to: 15, tagIds: ['t-mara'] }])
  })

  it('keeps different tags over overlapping text side by side', () => {
    tag(1, 12, 't-mara')
    tag(6, 19, 't-forest')
    expect(inline()).toEqual([
      { type: 'text', text: 'Mara ', marks: [range('t-mara')] },
      { type: 'text', text: 'waited', marks: [range('t-mara'), range('t-forest')] },
      { type: 'text', text: ' by the', marks: [range('t-forest')] },
      { type: 'text', text: ' gate.' }
    ])
    expect(tagRunsOf(editor.state.doc)).toEqual([
      { from: 1, to: 6, tagIds: ['t-mara'] },
      { from: 6, to: 12, tagIds: ['t-mara', 't-forest'] },
      { from: 12, to: 19, tagIds: ['t-forest'] }
    ])
  })

  it('does not grow when the author types at either edge, and moves with edits before it', () => {
    tag(6, 12, 't-mara')
    editor.chain().setTextSelection(12).insertContent('!').run()
    editor.chain().setTextSelection(6).insertContent('so ').run()
    editor.chain().setTextSelection(1).insertContent('And ').run()
    expect(inline()).toEqual([
      { type: 'text', text: 'And Mara so ' },
      { type: 'text', text: 'waited', marks: [range('t-mara')] },
      { type: 'text', text: '! by the gate.' }
    ])
  })

  it('clears every range in the selection and nothing outside it', () => {
    tag(1, 12, 't-mara')
    tag(6, 19, 't-forest')
    expect(editor.chain().setTextSelection({ from: 5, to: 15 }).clearTagRanges().run()).toBe(true)
    expect(inline()).toEqual([
      { type: 'text', text: 'Mara', marks: [range('t-mara')] },
      { type: 'text', text: ' waited by' },
      { type: 'text', text: ' the', marks: [range('t-forest')] },
      { type: 'text', text: ' gate.' }
    ])
    expect(editor.chain().setTextSelection(3).clearTagRanges().run()).toBe(false)
  })

  it('clears whole every range covering a position', () => {
    tag(1, 12, 't-mara')
    tag(6, 19, 't-forest')
    tag(21, 25, 't-moody')
    expect(editor.commands.clearTagRangesAt(8)).toBe(true)
    expect(inline()).toEqual([
      { type: 'text', text: 'Mara waited by the g' },
      { type: 'text', text: 'ate.', marks: [range('t-moody')] }
    ])
    expect(editor.commands.clearTagRangesAt(3)).toBe(false)
  })

  it('Mod+Alt+T hands a non-empty selection to the picker callback, and nothing else', () => {
    const press = (): boolean =>
      !editor.view.dom.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 't',
          code: 'KeyT',
          keyCode: 84,
          ctrlKey: true,
          altKey: true,
          bubbles: true,
          cancelable: true
        })
      )
    editor.commands.setTextSelection(3)
    expect(press()).toBe(false)
    expect(onTagSelection).not.toHaveBeenCalled()
    editor.commands.setTextSelection({ from: 1, to: 5 })
    expect(press()).toBe(true)
    expect(onTagSelection).toHaveBeenCalledWith(editor)
  })
})

describe('tag range decorations (F-4.8)', () => {
  it('paints one line per tag under each run with the names as a tooltip', () => {
    tag(1, 12, 't-mara')
    tag(6, 19, 't-forest')
    const painted = runs()
    expect(painted.map((r) => r.textContent)).toEqual(['Mara ', 'waited', ' by the'])
    expect(painted[0]?.getAttribute('title')).toBe('#mara')
    expect(painted[1]?.getAttribute('title')).toBe('#mara #dark-forest')
    const style = painted[1]?.getAttribute('style') ?? ''
    // The DOM normalizes the hex colours of the inline style (mara #dc2626, then dark-forest #ea580c).
    expect(style).toContain(
      'linear-gradient(rgb(220, 38, 38), rgb(220, 38, 38)), linear-gradient(rgb(234, 88, 12), rgb(234, 88, 12))'
    )
    expect(style).toContain('padding-bottom: 5px')
  })

  it('marks each block holding a range with its tags in first-appearance order', () => {
    editor.destroy()
    mount(
      paragraphs(
        [{ type: 'text', text: 'One two.' }],
        [{ type: 'text', text: 'Plain.' }],
        [{ type: 'text', text: 'Three four.' }]
      )
    )
    tag(5, 8, 't-forest')
    tag(1, 4, 't-mara')
    tag(20, 25, 't-moody')
    expect(blockTagsOf(editor.state.doc)).toEqual([
      { from: 0, to: 10, tagIds: ['t-mara', 't-forest'] },
      { from: 18, to: 31, tagIds: ['t-moody'] }
    ])
    const blocks = Array.from(editor.view.dom.querySelectorAll('p'))
    expect(blocks.map((p) => p.classList.contains(TAG_RANGE_BLOCK_CLASS))).toEqual([
      true,
      false,
      true
    ])
    expect(blocks[0]?.getAttribute('style')).toContain(
      '--range-colors: linear-gradient(to bottom, #dc2626 0% 50%, #ea580c 50% 100%)'
    )
  })

  it('paints a merged tag as its survivor and a deleted tag not at all, keeping the marks', () => {
    tag(1, 5, 't-forest')
    tag(13, 15, 't-mara')
    const byId = Object.fromEntries(
      Object.entries(useTagStore.getState().byId).filter(
        ([id]) => id !== 't-forest' && id !== 't-mara'
      )
    )
    useTagStore.setState({ byId, ids: Object.keys(byId), aliases: { 't-forest': 't-moody' } })
    const painted = runs()
    expect(painted).toHaveLength(1)
    expect(painted[0]?.textContent).toBe('Mara')
    expect(painted[0]?.getAttribute('title')).toBe('#moody')
    expect(inline().filter((n) => n.marks !== undefined)).toHaveLength(2)
  })

  it('repaints on a bank change without a document change or an undo step', () => {
    tag(1, 5, 't-mara')
    const doc = editor.state.doc
    const onUpdate = vi.fn()
    editor.on('update', onUpdate)
    useTagStore.getState().merge({ ...tagFixture[1]!, name: 'mara-vell', color: '#112233' })
    expect(runs()[0]?.getAttribute('title')).toBe('#mara-vell')
    expect(runs()[0]?.getAttribute('style')).toContain('rgb(17, 34, 51)')
    expect(editor.state.doc).toBe(doc)
    expect(onUpdate).not.toHaveBeenCalled()
    expect(TAG_RANGE_KEY.getState(editor.state)).toBeDefined()
  })

  it('dispatches nothing on a bank change while the document holds no range', () => {
    const refreshes: unknown[] = []
    editor.on('transaction', ({ transaction }) => {
      const meta: unknown = transaction.getMeta(TAG_RANGE_KEY)
      if (meta !== undefined) refreshes.push(meta)
    })
    useTagStore.getState().merge({ ...tagFixture[1]!, color: '#112233' })
    expect(refreshes).toEqual([])
    tag(1, 5, 't-mara')
    useTagStore.getState().merge({ ...tagFixture[1]!, color: '#445566' })
    expect(refreshes).toEqual(['refresh'])
  })

  it('paints nothing for a document without ranges', () => {
    expect(runs()).toHaveLength(0)
    expect(TAG_RANGE_KEY.getState(editor.state)?.find()).toEqual([])
  })
})
