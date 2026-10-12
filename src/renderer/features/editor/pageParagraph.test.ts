import { Editor } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import { afterEach, describe, expect, it } from 'vitest'
import {
  AI_FILED_ATTR,
  AI_WRITTEN_ATTR,
  NOT_CANON_ATTR,
  markedParagraphs
} from '@shared/memory/pageMarks'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { buildPageExtensions, manuscriptSchema, pageSchema } from './extensions'
import { MEMORY_PROGRAMMATIC_META } from './pageParagraph'

/**
 * F-16.6, F-16.8 (plan P1 §2.3): the page paragraph's attributes round-trip through `getJSON`
 * and the HTML clipboard flavour; `clearAiMarks` drops `aiFiled`/`aiWritten` on the author's edit
 * of a paragraph's text only; `toggleNotCanon` marks and unmarks; the manuscript schema is left
 * exactly as it was.
 */

const FILED = { doc: 'node-1', para: 2, quote: 'The coast is chalk.' }
const WRITTEN = { turn: 'turn-9', date: '2026-10-11' }

const paragraph = (text: string, attrs: Record<string, unknown> = {}): TiptapNodeT => ({
  type: 'paragraph',
  attrs,
  content: [{ type: 'text', text }]
})

let editor: Editor | null = null
afterEach(() => {
  editor?.destroy()
  editor = null
})

const open = (...paragraphs: TiptapNodeT[]): Editor => {
  editor = new Editor({
    extensions: buildPageExtensions({ sceneBreak: '* * *', onSave: () => undefined }),
    content: { type: 'doc', content: paragraphs }
  })
  return editor
}

const attrsOf = (ed: Editor, index: number): Record<string, unknown> =>
  ed.getJSON().content?.[index]?.attrs ?? {}

/** The document position just inside paragraph `index` (its first character). */
const startOf = (ed: Editor, index: number): number => {
  let pos = 0
  for (let i = 0; i < index; i++) pos += ed.state.doc.child(i).nodeSize
  return pos + 1
}

describe('the page paragraph (F-16.6, F-16.8)', () => {
  it('round-trips notCanon, aiFiled and aiWritten through getJSON and the HTML parser', () => {
    const ed = open(
      paragraph('Not real.', { [NOT_CANON_ATTR]: true }),
      paragraph('Filed.', { [AI_FILED_ATTR]: FILED }),
      paragraph('Written.', { [AI_WRITTEN_ATTR]: WRITTEN })
    )
    const json = ed.getJSON()
    expect(TiptapNode.parse(json)).toEqual(json)
    expect(attrsOf(ed, 0)).toMatchObject({ notCanon: true, aiFiled: null, aiWritten: null })
    expect(attrsOf(ed, 1)).toMatchObject({ notCanon: false, aiFiled: FILED })
    expect(attrsOf(ed, 2)).toMatchObject({ aiWritten: WRITTEN })
    const html = ed.getHTML()
    expect(html).toContain('data-not-canon=""')
    const again = new Editor({
      extensions: buildPageExtensions({ sceneBreak: '* * *', onSave: () => undefined }),
      content: html
    })
    expect(again.getJSON()).toEqual(json)
    again.destroy()
    // Main reads the same marks from the stored JSON.
    expect(markedParagraphs(json).map((p) => p.notCanon)).toEqual([true, false, false])
  })

  it('clears aiFiled and aiWritten when the author edits the paragraph, and only that one', () => {
    const ed = open(
      paragraph('Filed.', { [AI_FILED_ATTR]: FILED }),
      paragraph('Written.', { [AI_WRITTEN_ATTR]: WRITTEN })
    )
    ed.chain()
      .setTextSelection(startOf(ed, 0) + 2)
      .insertContent('x')
      .run()
    expect(attrsOf(ed, 0)).toMatchObject({ aiFiled: null })
    expect(attrsOf(ed, 1)).toMatchObject({ aiWritten: WRITTEN })
    // A deletion at the very start of the next paragraph is an edit of that one.
    const at = startOf(ed, 1)
    ed.view.dispatch(ed.state.tr.delete(at, at + 1))
    expect(attrsOf(ed, 1)).toMatchObject({ aiWritten: null })
  })

  it('keeps the mark of a paragraph whose words stay: Enter at its end or start, Backspace below it', () => {
    const ed = open(
      paragraph('Filed.', { [AI_FILED_ATTR]: FILED }),
      paragraph('Next.', { [AI_WRITTEN_ATTR]: WRITTEN })
    )
    const marks = (): [string, unknown, unknown][] =>
      (TiptapNode.parse(ed.getJSON()).content ?? []).map((block) => [
        (block.content ?? []).map((child) => child.text ?? '').join(''),
        block.attrs?.[AI_FILED_ATTR] ?? null,
        block.attrs?.[AI_WRITTEN_ATTR] ?? null
      ])
    // Enter at the end: a new line of her own, the filed line untouched.
    ed.chain()
      .setTextSelection(startOf(ed, 0) + 'Filed.'.length)
      .splitBlock()
      .run()
    expect(marks()).toEqual([
      ['Filed.', FILED, null],
      ['', null, null],
      ['Next.', null, WRITTEN]
    ])
    // Backspace on that empty line takes it away and leaves the filed line as it was.
    ed.chain().setTextSelection(startOf(ed, 1)).joinBackward().run()
    expect(marks()).toEqual([
      ['Filed.', FILED, null],
      ['Next.', null, WRITTEN]
    ])
    // Enter at the start: the mark stays with the words, never on the empty line above them.
    ed.chain().setTextSelection(startOf(ed, 1)).splitBlock().run()
    expect(marks()).toEqual([
      ['Filed.', FILED, null],
      ['', null, null],
      ['Next.', null, WRITTEN]
    ])
    // Joining the next paragraph into the filed one changes its words: the marks go.
    ed.chain().setTextSelection(startOf(ed, 1)).joinBackward().run()
    ed.chain().setTextSelection(startOf(ed, 1)).joinBackward().run()
    expect(marks()).toEqual([['Filed.Next.', null, null]])
  })

  it('keeps the marks through the app’s own writes, formatting, and the Not canon switch', () => {
    const ed = open(paragraph('Filed text.', { [AI_FILED_ATTR]: FILED }))
    const tr = ed.state.tr.insertText(' More.', ed.state.doc.content.size - 1)
    tr.setMeta(MEMORY_PROGRAMMATIC_META, true)
    ed.view.dispatch(tr)
    expect(ed.getText()).toBe('Filed text. More.')
    expect(attrsOf(ed, 0)).toMatchObject({ aiFiled: FILED })
    ed.chain().setTextSelection({ from: 1, to: 6 }).toggleBold().run()
    expect(attrsOf(ed, 0)).toMatchObject({ aiFiled: FILED })
    ed.commands.toggleNotCanon()
    expect(attrsOf(ed, 0)).toMatchObject({ aiFiled: FILED, notCanon: true })
  })

  it('undoes the clearing together with the edit that caused it', () => {
    const ed = open(paragraph('Filed.', { [AI_FILED_ATTR]: FILED }))
    ed.chain().setTextSelection(3).insertContent('y').run()
    expect(attrsOf(ed, 0)).toMatchObject({ aiFiled: null })
    ed.commands.undo()
    expect(ed.getText()).toBe('Filed.')
    expect(attrsOf(ed, 0)).toMatchObject({ aiFiled: FILED })
  })

  it('toggleNotCanon marks every paragraph the selection touches, and unmarks when all are', () => {
    const ed = open(
      paragraph('One.'),
      paragraph('Two.', { [NOT_CANON_ATTR]: true }),
      paragraph('Three.')
    )
    ed.view.dispatch(
      ed.state.tr.setSelection(
        TextSelection.create(ed.state.doc, startOf(ed, 0), startOf(ed, 1) + 1)
      )
    )
    expect(ed.commands.toggleNotCanon()).toBe(true)
    expect([0, 1, 2].map((i) => attrsOf(ed, i)[NOT_CANON_ATTR])).toEqual([true, true, false])
    ed.commands.toggleNotCanon()
    expect([0, 1, 2].map((i) => attrsOf(ed, i)[NOT_CANON_ATTR])).toEqual([false, false, false])
    // A Not canon paragraph split by Enter stays Not canon on both sides; its AI mark does not carry.
    ed.commands.setContent({
      type: 'doc',
      content: [paragraph('Maybe so.', { [NOT_CANON_ATTR]: true, [AI_FILED_ATTR]: FILED })]
    })
    ed.chain().setTextSelection(6).splitBlock().run()
    expect([0, 1].map((i) => attrsOf(ed, i)[NOT_CANON_ATTR])).toEqual([true, true])
    expect([0, 1].map((i) => attrsOf(ed, i)[AI_FILED_ATTR])).toEqual([null, null])
  })

  it('marks a heading Not canon too, and main reads it so', () => {
    const ed = open(paragraph('Intro.'))
    ed.commands.setContent({
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Possible ending' }] },
        paragraph('Mara dies.')
      ]
    })
    ed.chain().setTextSelection(2).toggleNotCanon().run()
    const json = ed.getJSON()
    expect(json.content?.[0]?.attrs).toMatchObject({ level: 2, notCanon: true })
    expect(json.content?.[1]?.attrs).toMatchObject({ notCanon: false })
    expect(ed.getHTML()).toContain('<h2 data-not-canon="">')
    expect(markedParagraphs(json).map((p) => [p.text, p.notCanon])).toEqual([
      ['Possible ending', true],
      ['Mara dies.', false]
    ])
    ed.chain().setTextSelection(2).toggleNotCanon().run()
    expect(ed.getJSON().content?.[0]?.attrs).toMatchObject({ notCanon: false })
  })

  it('leaves the manuscript schema as it was: no page attribute on its paragraph', () => {
    const manuscript = manuscriptSchema('* * *').nodes.paragraph?.spec.attrs ?? {}
    expect(Object.keys(manuscript).sort()).toEqual(['origin', 'textAlign'])
    const page = pageSchema('* * *').nodes.paragraph?.spec.attrs ?? {}
    expect(Object.keys(page).sort()).toEqual([
      'aiFiled',
      'aiWritten',
      'notCanon',
      'origin',
      'textAlign'
    ])
    expect(Object.keys(manuscriptSchema('* * *').nodes.heading?.spec.attrs ?? {}).sort()).toEqual([
      'level',
      'textAlign'
    ])
    expect(Object.keys(pageSchema('* * *').nodes.heading?.spec.attrs ?? {}).sort()).toEqual([
      'level',
      'notCanon',
      'textAlign'
    ])
    // Nothing of the manuscript's own tools is in the page schema.
    expect(pageSchema('* * *').nodes.inlineTag).toBeUndefined()
    expect(Object.keys(manuscriptSchema('* * *').nodes).sort()).toMatchInlineSnapshot(`
      [
        "blockquote",
        "doc",
        "hardBreak",
        "heading",
        "inlineTag",
        "paragraph",
        "sceneBreak",
        "text",
      ]
    `)
    expect(Object.keys(manuscriptSchema('* * *').marks).sort()).toMatchInlineSnapshot(`
      [
        "aiOrigin",
        "bold",
        "code",
        "italic",
        "strike",
        "tagRange",
        "underline",
      ]
    `)
  })
})
