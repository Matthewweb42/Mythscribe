import { describe, expect, it } from 'vitest'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import type { TiptapNodeT } from '@shared/tiptap'
import type { ImportBlock } from './blocks'
import { looksHardWrapped, parseEmphasis, readMarkdown, readPlainText } from './text'

function content(blocks: ImportBlock[], index: number): TiptapNodeT[] {
  const block = blocks[index]
  if (block?.type !== 'paragraph') throw new Error(`block ${index} is ${block?.type ?? 'missing'}`)
  return block.node.content ?? []
}

/** The plain text of every paragraph block, in order. */
function texts(blocks: ImportBlock[]): string[] {
  return blocks
    .filter((block) => block.type === 'paragraph')
    .map((block) => (block.node.content ?? []).map((child) => child.text ?? '').join(''))
}

describe('readMarkdown', () => {
  it('reads ATX headings at every level and keeps the rest as prose', () => {
    const blocks = readMarkdown('# Part One\n\n## Chapter One\n\nThe bell rang.\n')
    expect(blocks.filter((block) => block.type === 'heading')).toEqual([
      { type: 'heading', level: 1, text: 'Part One' },
      { type: 'heading', level: 2, text: 'Chapter One' }
    ])
    expect(texts(blocks)).toEqual(['The bell rang.'])
  })

  it('strips the closing hashes of a closed heading', () => {
    expect(readMarkdown('## Chapter One ##')).toEqual([
      { type: 'heading', level: 2, text: 'Chapter One' }
    ])
  })

  it('joins consecutive lines into one paragraph and splits on a blank line', () => {
    const blocks = readMarkdown('One line\nand its wrap.\n\nA second paragraph.\n')
    expect(texts(blocks)).toEqual(['One line and its wrap.', 'A second paragraph.'])
    expect(blocks.map((block) => block.type)).toEqual(['paragraph', 'blank', 'paragraph', 'blank'])
  })

  it('reads emphasis into marks and marks the paragraph as imported', () => {
    const blocks = readMarkdown('She said **no** and _meant_ it.')
    expect(content(blocks, 0)).toEqual([
      { type: 'text', text: 'She said ' },
      { type: 'text', text: 'no', marks: [{ type: 'bold' }] },
      { type: 'text', text: ' and ' },
      { type: 'text', text: 'meant', marks: [{ type: 'italic' }] },
      { type: 'text', text: ' it.' }
    ])
    expect(blocks[0]).toMatchObject({
      node: { attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN } }
    })
  })

  it('reads a glyph line as a break and a bare hash as one too', () => {
    expect(readMarkdown('a\n\n* * *\n\nb\n\n#\n\nc').filter((b) => b.type === 'break')).toEqual([
      { type: 'break' },
      { type: 'break' }
    ])
  })

  it('normalises CRLF line endings and a leading byte-order mark', () => {
    expect(readMarkdown('﻿# Title\r\n\r\nText.\r\n')).toEqual([
      { type: 'heading', level: 1, text: 'Title' },
      { type: 'blank' },
      expect.objectContaining({ type: 'paragraph' }),
      { type: 'blank' }
    ])
  })
})

describe('readPlainText', () => {
  const wrapped = [
    'The bell rang twice and then it',
    'stopped, and the house was quiet.',
    '',
    'She listened to the second one fade',
    'into the fields beyond the road.',
    ''
  ].join('\n')

  it('joins the lines of a hard-wrapped file back into paragraphs', () => {
    expect(texts(readPlainText(wrapped))).toEqual([
      'The bell rang twice and then it stopped, and the house was quiet.',
      'She listened to the second one fade into the fields beyond the road.'
    ])
  })

  it('starts a new paragraph on an indented line inside a wrapped file', () => {
    const text = `${wrapped}\n\tA new one begins.\nand wraps.\n`
    expect(texts(readPlainText(text)).at(-1)).toBe('A new one begins. and wraps.')
  })

  it('keeps one paragraph per line when the file is not hard-wrapped', () => {
    const long = 'x'.repeat(200)
    const text = `${long}\n\n${long} again\n`
    expect(texts(readPlainText(text))).toEqual([long, `${long} again`])
  })

  it('reads glyph lines and blank lines without reading marks', () => {
    const blocks = readPlainText('One.\n\n***\n\nTwo **not bold**.\n')
    expect(blocks.map((block) => block.type)).toEqual([
      'paragraph',
      'blank',
      'break',
      'blank',
      'paragraph',
      'blank'
    ])
    expect(content(blocks, 4)).toEqual([{ type: 'text', text: 'Two **not bold**.' }])
  })
})

describe('looksHardWrapped', () => {
  it('is true when short lines dominate and the file uses blank lines', () => {
    expect(looksHardWrapped(['a short line', '', 'another short line'])).toBe(true)
  })

  it('is false without a blank line anywhere', () => {
    expect(looksHardWrapped(['a short line', 'another short line'])).toBe(false)
  })

  it('is false when the ninetieth percentile line is long', () => {
    expect(looksHardWrapped(['x'.repeat(300), 'y'.repeat(300), ''])).toBe(false)
  })

  it('lets one long line pass in an otherwise wrapped file', () => {
    const lines = [...Array.from({ length: 30 }, () => 'a short wrapped line'), 'z'.repeat(400), '']
    expect(looksHardWrapped(lines)).toBe(true)
  })
})

describe('parseEmphasis', () => {
  it('leaves an unmatched marker as text', () => {
    expect(parseEmphasis('2 * 3 = 6')).toEqual([
      { kind: 'text', text: '2 * 3 = 6', bold: false, italic: false }
    ])
  })

  it('does not open emphasis inside a word', () => {
    expect(parseEmphasis('snake_case_name')).toEqual([
      { kind: 'text', text: 'snake_case_name', bold: false, italic: false }
    ])
  })

  it('reads italic inside bold', () => {
    expect(parseEmphasis('**a *b* c**')).toEqual([
      { kind: 'text', text: 'a ', bold: true, italic: false },
      { kind: 'text', text: 'b', bold: true, italic: true },
      { kind: 'text', text: ' c', bold: true, italic: false }
    ])
  })
})
