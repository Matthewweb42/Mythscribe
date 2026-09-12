import { describe, expect, it } from 'vitest'
import { countInlineTags, INLINE_TAG_NODE_TYPE } from './inlineTags'
import { EMPTY_DOC, type TiptapNodeT } from './tiptap'

const token = (id: string, name = id): TiptapNodeT => ({
  type: INLINE_TAG_NODE_TYPE,
  attrs: { id, name }
})
const paragraph = (...content: TiptapNodeT[]): TiptapNodeT => ({ type: 'paragraph', content })
const text = (value: string): TiptapNodeT => ({ type: 'text', text: value })

describe('countInlineTags (F-4.6)', () => {
  it('counts nothing for a document without tokens', () => {
    expect(countInlineTags(EMPTY_DOC)).toEqual({})
    expect(countInlineTags({ type: 'doc' })).toEqual({})
    expect(countInlineTags({ type: 'doc', content: [paragraph(text('plain'))] })).toEqual({})
  })

  it('counts every occurrence per id, nested in blocks, in order of first appearance', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        paragraph(
          text('Into the '),
          token('t-forest', 'dark-forest'),
          text(' with '),
          token('t-mara')
        ),
        { type: 'blockquote', content: [paragraph(token('t-forest', 'dark-forest'))] },
        { type: 'sceneBreak' },
        paragraph(token('t-forest', 'renamed-later'))
      ]
    }
    expect(countInlineTags(doc)).toEqual({ 't-forest': 3, 't-mara': 1 })
    expect(Object.keys(countInlineTags(doc))).toEqual(['t-forest', 't-mara'])
  })

  it('skips a token without a string id', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        paragraph({ type: INLINE_TAG_NODE_TYPE }, { type: INLINE_TAG_NODE_TYPE, attrs: { id: 7 } })
      ]
    }
    expect(countInlineTags(doc)).toEqual({})
  })
})
