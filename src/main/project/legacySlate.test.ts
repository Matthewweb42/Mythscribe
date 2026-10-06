import { describe, expect, it } from 'vitest'
import { slateToText, slateToTiptap } from './legacySlate'

describe('slateToTiptap (F-1.6)', () => {
  it('maps v0 blocks and marks, merges equal leaves, and drops what v1 has no place for', () => {
    const doc = slateToTiptap(
      JSON.stringify([
        { type: 'heading', level: 5, align: 'right', children: [{ text: 'Title' }] },
        {
          type: 'paragraph',
          align: 'left',
          children: [
            { text: 'One ', bold: true, fontSize: 30 },
            { text: 'two', bold: true, color: '#f00' },
            { text: ' three', strikethrough: true, underline: true, isTag: true, tagId: 'x' },
            { text: '' }
          ]
        },
        { type: 'paragraph', children: [{ text: '' }] },
        { type: 'sceneBreak', children: [{ text: '' }] },
        { type: 'blockquote', children: [{ text: 'Said.', code: true }] }
      ])
    )
    expect(doc).toEqual({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 3, textAlign: 'right' },
          content: [{ type: 'text', text: 'Title' }]
        },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'One two', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' three', marks: [{ type: 'underline' }, { type: 'strike' }] }
          ]
        },
        { type: 'paragraph' },
        { type: 'sceneBreak' },
        {
          type: 'blockquote',
          content: [
            {
              type: 'paragraph',
              content: [{ type: 'text', text: 'Said.', marks: [{ type: 'code' }] }]
            }
          ]
        }
      ]
    })
  })

  it('reads empty values as no document and anything else unreadable as plain paragraphs', () => {
    expect(slateToTiptap(null)).toBeNull()
    expect(slateToTiptap('  ')).toBeNull()
    expect(
      slateToTiptap(JSON.stringify([{ type: 'paragraph', children: [{ text: '' }] }]))
    ).toBeNull()
    expect(slateToTiptap('First line\n\nSecond line')).toEqual({
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line' }] }
      ]
    })
    expect(slateToTiptap('1984')).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: '1984' }] }]
    })
  })

  it('flattens a block that nests blocks into its paragraphs', () => {
    const doc = slateToTiptap(
      JSON.stringify([
        { type: 'list', children: [{ type: 'paragraph', children: [{ text: 'Inside' }] }] }
      ])
    )
    expect(doc?.content).toEqual([
      { type: 'paragraph', content: [{ type: 'text', text: 'Inside' }] }
    ])
  })
})

describe('slateToText (F-1.6)', () => {
  it('keeps plain text as written and turns Slate into lines', () => {
    expect(slateToText('Grey eyes.\nAfraid of water.')).toBe('Grey eyes.\nAfraid of water.')
    expect(
      slateToText(
        JSON.stringify([
          { type: 'paragraph', children: [{ text: 'One' }] },
          { type: 'paragraph', children: [{ text: 'Two' }] }
        ])
      )
    ).toBe('One\nTwo')
    expect(slateToText(null)).toBe('')
  })
})
