import { describe, expect, it } from 'vitest'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import type { ImportBlock } from './blocks'
import { decodeEntities, htmlToBlocks } from './html'

/** The content of the nth block, which must be a paragraph. */
function content(blocks: ImportBlock[], index: number): TiptapNodeT[] {
  const block = blocks[index]
  if (block?.type !== 'paragraph') throw new Error(`block ${index} is ${block?.type ?? 'missing'}`)
  return block.node.content ?? []
}

describe('htmlToBlocks', () => {
  it('reads the shape mammoth emits for a chapter', () => {
    const blocks = htmlToBlocks(
      '<h1>Chapter One</h1><p>The bell rang.</p><p>She listened to the <em>second</em> one.</p><p></p><p>* * *</p><p>Morning came.</p>'
    )
    expect(blocks.map((block) => block.type)).toEqual([
      'heading',
      'paragraph',
      'paragraph',
      'blank',
      'break',
      'paragraph'
    ])
    expect(blocks[0]).toEqual({ type: 'heading', level: 1, text: 'Chapter One' })
    expect(content(blocks, 2)).toEqual([
      { type: 'text', text: 'She listened to the ' },
      { type: 'text', text: 'second', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' one.' }
    ])
  })

  it('carries the imported origin on every paragraph', () => {
    const blocks = htmlToBlocks('<p>One.</p>')
    expect(blocks[0]).toMatchObject({
      type: 'paragraph',
      node: { attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN } }
    })
  })

  it('reads every heading level', () => {
    expect(htmlToBlocks('<h2>Part</h2><h6>Deep</h6>')).toEqual([
      { type: 'heading', level: 2, text: 'Part' },
      { type: 'heading', level: 6, text: 'Deep' }
    ])
  })

  it('maps strong and b to bold, em and i to italic, and nests them', () => {
    const blocks = htmlToBlocks(
      '<p><strong>A</strong><b>B</b><i>C</i><em><strong>D</strong></em></p>'
    )
    expect(content(blocks, 0)).toEqual([
      { type: 'text', text: 'AB', marks: [{ type: 'bold' }] },
      { type: 'text', text: 'C', marks: [{ type: 'italic' }] },
      { type: 'text', text: 'D', marks: [{ type: 'bold' }, { type: 'italic' }] }
    ])
  })

  it('turns br into a hard break', () => {
    expect(content(htmlToBlocks('<p>one<br />two</p>'), 0)).toEqual([
      { type: 'text', text: 'one' },
      { type: 'hardBreak' },
      { type: 'text', text: 'two' }
    ])
  })

  it('keeps the text of tags it does not know and ignores the tags', () => {
    expect(
      content(htmlToBlocks('<p>See <a href="http://x/y">the map</a><sup>1</sup>.</p>'), 0)
    ).toEqual([{ type: 'text', text: 'See the map1.' }])
  })

  it('reads list items and table cells as paragraphs without inventing blank lines', () => {
    const blocks = htmlToBlocks(
      '<ul><li>First</li><li>Second</li></ul><table><tr><td><p>Cell</p></td></tr></table>'
    )
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'paragraph', 'paragraph'])
    expect(content(blocks, 2)).toEqual([{ type: 'text', text: 'Cell' }])
  })

  it('reads a paragraph holding only a glyph as a scene break', () => {
    expect(htmlToBlocks('<p>&#8258;</p>')).toEqual([{ type: 'break' }])
  })

  it('keeps text that arrives outside any block', () => {
    expect(content(htmlToBlocks('Loose text\n<p>In a block</p>'), 0)).toEqual([
      { type: 'text', text: 'Loose text\n' }
    ])
  })

  it('answers nothing for empty input', () => {
    expect(htmlToBlocks('')).toEqual([])
  })
})

describe('decodeEntities', () => {
  it('decodes the named entities mammoth writes', () => {
    expect(decodeEntities('a &amp; b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe(
      'a & b <c> "d" \'e\''
    )
  })

  it('decodes a non-breaking space and numeric references, decimal and hex', () => {
    expect(decodeEntities('one&nbsp;two &#8212; three &#x201C;four&#x201D;')).toBe(
      'one two — three “four”'
    )
  })

  it('leaves an entity it does not know exactly as it was typed', () => {
    expect(decodeEntities('R&D and &unknown; and &amp')).toBe('R&D and &unknown; and &amp')
  })
})
