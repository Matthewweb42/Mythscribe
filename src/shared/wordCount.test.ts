import { describe, expect, it } from 'vitest'
import { EMPTY_DOC, type TiptapNodeT } from './tiptap'
import { addTextStats, countWords, estimatedPages, textStats } from './wordCount'

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

describe('textStats (F-10.4)', () => {
  it('counts words, characters, and characters without whitespace', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [paragraph('The storm  broke.'), { type: 'sceneBreak' }, paragraph('Rain\tfell')]
    }
    expect(textStats(doc)).toEqual({ words: 5, characters: 26, charactersNoSpaces: 22 })
  })

  it('counts an inline tag as one word with its name, and nothing for a nameless token', () => {
    const doc: TiptapNodeT = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Into ' },
            { type: 'inlineTag', attrs: { id: 't-forest', name: 'dark-forest' } },
            { type: 'inlineTag', attrs: { id: 't-odd' } }
          ]
        }
      ]
    }
    expect(textStats(doc)).toEqual({ words: 3, characters: 16, charactersNoSpaces: 15 })
  })

  it('agrees with countWords and counts the empty document as zeros', () => {
    expect(textStats(EMPTY_DOC)).toEqual({ words: 0, characters: 0, charactersNoSpaces: 0 })
    const doc: TiptapNodeT = { type: 'doc', content: [paragraph('  spaced \n out  ')] }
    expect(textStats(doc).words).toBe(countWords(doc))
  })

  it('adds stats field by field', () => {
    expect(
      addTextStats(
        { words: 1, characters: 2, charactersNoSpaces: 3 },
        { words: 10, characters: 20, charactersNoSpaces: 30 }
      )
    ).toEqual({ words: 11, characters: 22, charactersNoSpaces: 33 })
  })
})

describe('estimatedPages (F-10.4)', () => {
  it('rounds up at 250 words a page, with 0 for no words', () => {
    expect(estimatedPages(0)).toBe(0)
    expect(estimatedPages(1)).toBe(1)
    expect(estimatedPages(250)).toBe(1)
    expect(estimatedPages(251)).toBe(2)
    expect(estimatedPages(80_000)).toBe(320)
  })
})
