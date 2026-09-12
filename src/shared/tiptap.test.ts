import { describe, expect, it } from 'vitest'
import { EMPTY_DOC, TiptapMark, TiptapNode, type TiptapNodeT } from './tiptap'

describe('TiptapNode', () => {
  it('accepts a nested document with marks and attrs', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 2, textAlign: 'center' },
          content: [{ type: 'text', text: 'Chapter' }]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' link', marks: [{ type: 'link', attrs: { href: 'x' } }] }
          ]
        },
        { type: 'sceneBreak' }
      ]
    }
    expect(TiptapNode.parse(doc)).toEqual(doc)
  })

  it('accepts the empty document', () => {
    expect(TiptapNode.parse(EMPTY_DOC)).toEqual(EMPTY_DOC)
  })

  it('rejects nodes without a type, anywhere in the tree', () => {
    expect(TiptapNode.safeParse({ content: [] }).success).toBe(false)
    expect(
      TiptapNode.safeParse({ type: 'doc', content: [{ type: 'paragraph', content: [{}] }] }).success
    ).toBe(false)
  })

  it('rejects non-object content, malformed marks, and non-string text', () => {
    expect(TiptapNode.safeParse('doc').success).toBe(false)
    expect(TiptapNode.safeParse({ type: 'doc', content: 'x' }).success).toBe(false)
    expect(TiptapNode.safeParse({ type: 'text', text: 1 }).success).toBe(false)
    expect(TiptapNode.safeParse({ type: 'text', text: 'a', marks: [{}] }).success).toBe(false)
    expect(TiptapMark.safeParse({ type: 'bold', attrs: 'x' }).success).toBe(false)
  })
})
