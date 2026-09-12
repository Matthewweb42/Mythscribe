import { describe, expect, it } from 'vitest'
import { EMPTY_DOC, type TiptapNodeT } from './tiptap'
import { countWords } from './wordCount'

const paragraph = (...texts: string[]): TiptapNodeT => ({
  type: 'paragraph',
  content: texts.map((text) => ({ type: 'text', text }))
})

describe('countWords', () => {
  it('counts the empty document as 0', () => {
    expect(countWords(EMPTY_DOC)).toBe(0)
    expect(countWords({ type: 'doc' })).toBe(0)
  })

  it('counts the words of one paragraph', () => {
    expect(countWords({ type: 'doc', content: [paragraph('The storm broke at dusk.')] })).toBe(5)
  })

  it('adds up several paragraphs and headings', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Chapter One' }] },
        paragraph('It was late.'),
        { type: 'blockquote', content: [paragraph('Come home, she said.')] }
      ]
    }
    expect(countWords(doc)).toBe(9)
  })

  it('ignores marks: split text runs count the same as one run', () => {
    const marked: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'plain ' },
            { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
            { type: 'text', text: ' and italic', marks: [{ type: 'italic' }] }
          ]
        }
      ]
    }
    expect(countWords(marked)).toBe(4)
    expect(countWords({ type: 'doc', content: [paragraph('plain bold and italic')] })).toBe(4)
  })

  it('counts a scene break and other text-less atoms as 0', () => {
    expect(countWords({ type: 'sceneBreak' })).toBe(0)
    expect(
      countWords({
        type: 'doc',
        content: [paragraph('One two'), { type: 'sceneBreak' }, paragraph('three')]
      })
    ).toBe(3)
  })

  it('counts an inline tag token as one word (F-4.6)', () => {
    expect(countWords({ type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } })).toBe(
      1
    )
    expect(
      countWords({
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [
              { type: 'text', text: 'Into the ' },
              { type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } },
              { type: 'text', text: ' at dusk' }
            ]
          }
        ]
      })
    ).toBe(5)
  })

  it('collapses runs of whitespace and ignores leading and trailing spaces', () => {
    expect(countWords(paragraph('  spaced \n\t out   words  '))).toBe(3)
    expect(countWords(paragraph('   '))).toBe(0)
    expect(countWords(paragraph(''))).toBe(0)
  })
})
