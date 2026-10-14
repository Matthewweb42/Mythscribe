import { describe, expect, it } from 'vitest'
import {
  AI_FILED_ATTR,
  AI_MARK_ATTRS,
  AI_WRITTEN_ATTR,
  NOT_CANON_ATTR,
  PAGE_ATTRS,
  aiFiledOf,
  aiWrittenOf,
  isNotCanon,
  markedParagraphs,
  pageTextBlocks,
  replaceBlockText,
  withoutAiMarks
} from './pageMarks'

describe('page marks in stored JSON (F-16.6, F-16.8)', () => {
  it('names the three page attributes and reads each one leniently', () => {
    expect(PAGE_ATTRS).toEqual(['notCanon', 'aiFiled', 'aiWritten'])
    const filed = { doc: 'n-1', para: 2, quote: 'Mara is 35.' }
    const paragraph = {
      type: 'paragraph',
      attrs: { [NOT_CANON_ATTR]: true, [AI_FILED_ATTR]: filed, [AI_WRITTEN_ATTR]: null }
    }
    expect(isNotCanon(paragraph)).toBe(true)
    expect(aiFiledOf(paragraph)).toEqual(filed)
    expect(aiWrittenOf(paragraph)).toBeNull()
    expect(
      aiWrittenOf({ type: 'paragraph', attrs: { aiWritten: { turn: 't', date: 'd' } } })
    ).toEqual({
      turn: 't',
      date: 'd'
    })
    // A hand-edited or older shape reads as no mark, never a throw.
    expect(aiFiledOf({ type: 'paragraph', attrs: { aiFiled: { doc: 'n', para: -1 } } })).toBeNull()
    expect(isNotCanon({ type: 'paragraph', attrs: { notCanon: 'yes' } })).toBe(false)
  })

  it('marks a paragraph Not canon when it, or a block around it, carries the mark', () => {
    const doc = {
      type: 'doc',
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'Canon.' }] },
        {
          type: 'paragraph',
          attrs: { notCanon: true },
          content: [{ type: 'text', text: 'Maybe.' }]
        },
        {
          type: 'blockquote',
          attrs: { notCanon: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Quoted maybe.' }] }]
        },
        { type: 'paragraph' }
      ]
    }
    expect(markedParagraphs(doc)).toEqual([
      { index: 0, text: 'Canon.', notCanon: false },
      { index: 1, text: 'Maybe.', notCanon: true },
      { index: 2, text: 'Quoted maybe.', notCanon: true }
    ])
  })

  it('clears the AI marks of a block, and returns a block without any as it is', () => {
    expect(AI_MARK_ATTRS).toEqual(['aiFiled', 'aiWritten'])
    const filed = {
      type: 'paragraph',
      attrs: {
        [NOT_CANON_ATTR]: true,
        [AI_FILED_ATTR]: { doc: 'n-1', para: 0, quote: 'q' },
        [AI_WRITTEN_ATTR]: null
      }
    }
    expect(withoutAiMarks(filed)).toEqual({
      type: 'paragraph',
      attrs: { [NOT_CANON_ATTR]: true, [AI_FILED_ATTR]: null, [AI_WRITTEN_ATTR]: null }
    })
    expect(filed.attrs[AI_FILED_ATTR]).not.toBeNull()
    const plain = { type: 'paragraph', attrs: { origin: null } }
    expect(withoutAiMarks(plain)).toBe(plain)
    const bare = { type: 'paragraph' }
    expect(withoutAiMarks(bare)).toBe(bare)
  })
})

describe('replaceBlockText (Update my note, F-16.29)', () => {
  const italic = [{ type: 'italic' }]
  const bold = [{ type: 'bold' }]
  const lines = {
    type: 'paragraph',
    content: [
      { type: 'text', text: 'Born: ' },
      { type: 'text', text: '1790', marks: italic },
      { type: 'hardBreak' },
      { type: 'text', text: 'Eyes: ', marks: bold },
      { type: 'text', text: 'green' }
    ]
  }
  const textOf = (block: Parameters<typeof replaceBlockText>[0]): string =>
    pageTextBlocks({ type: 'doc', content: [block] })[0]?.text ?? ''

  it('changes only the changed words, keeping marks and line breaks around them', () => {
    expect(textOf(lines)).toBe('Born: 1790\nEyes: green')
    const next = replaceBlockText(lines, 'Born: 1792\nEyes: green')
    expect(next.content).toEqual([
      { type: 'text', text: 'Born: ' },
      { type: 'text', text: '1792', marks: italic },
      { type: 'hardBreak' },
      { type: 'text', text: 'Eyes: ', marks: bold },
      { type: 'text', text: 'green' }
    ])
    expect(textOf(next)).toBe('Born: 1792\nEyes: green')
  })

  it('gives new words the marks where the change starts, and a typed line break a hardBreak', () => {
    const next = replaceBlockText(lines, 'Born: 1790\nEyes: grey\nHair: dark')
    expect(next.content).toEqual([
      { type: 'text', text: 'Born: ' },
      { type: 'text', text: '1790', marks: italic },
      { type: 'hardBreak' },
      { type: 'text', text: 'Eyes: ', marks: bold },
      { type: 'text', text: 'grey' },
      { type: 'hardBreak' },
      { type: 'text', text: 'Hair: dark' }
    ])
    // A whole value replaced at a node boundary takes that node's marks.
    const swapped = replaceBlockText(lines, 'Born: 1801\nEyes: green')
    expect(swapped.content?.[1]).toEqual({ type: 'text', text: '1801', marks: italic })
  })

  it('drops a line break or leaf inside the changed words, merges equal neighbours, and keeps an unchanged block', () => {
    const joined = replaceBlockText(lines, 'Born: 1790. Eyes: green')
    expect(textOf(joined)).toBe('Born: 1790. Eyes: green')
    expect(joined.content?.some((node) => node.type === 'hardBreak')).toBe(false)
    const plain = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'Orrin has ' },
        { type: 'text', text: 'green', marks: italic },
        { type: 'text', text: ' eyes.' }
      ]
    }
    expect(replaceBlockText(plain, 'Orrin has  eyes.').content).toEqual([
      { type: 'text', text: 'Orrin has  eyes.' }
    ])
    expect(replaceBlockText(plain, 'Orrin has green eyes.')).toBe(plain)
  })

  it('never splits a surrogate pair', () => {
    const block = { type: 'paragraph', content: [{ type: 'text', text: 'Sign: \u{1F600}' }] }
    const next = replaceBlockText(block, 'Sign: \u{1F601}')
    expect(textOf(next)).toBe('Sign: \u{1F601}')
  })
})
