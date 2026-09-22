import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { IMPORTED_ORIGIN, PARAGRAPH_ORIGIN_ATTR } from '@shared/provenance'
import { readDocx } from './docx'

/**
 * `fixtures/sample.docx` is a 1 KB Word file written once by a throwaway script: a Heading 1
 * "Chapter One", two paragraphs (the second with an italic run), an empty paragraph, a "* * *"
 * line, and one more paragraph. Small enough to check in, real enough to prove mammoth's output
 * and the tokenizer agree on a file Word itself would produce.
 */
const SAMPLE = path.join(import.meta.dirname, 'fixtures', 'sample.docx')

describe('readDocx', () => {
  it('reads headings, marks, empty paragraphs, and glyph lines out of a real DOCX', async () => {
    const blocks = await readDocx(fs.readFileSync(SAMPLE))
    expect(blocks).toEqual([
      { type: 'heading', level: 1, text: 'Chapter One' },
      {
        type: 'paragraph',
        node: {
          type: 'paragraph',
          attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
          content: [{ type: 'text', text: 'The bell rang twice & then stopped.' }]
        }
      },
      {
        type: 'paragraph',
        node: {
          type: 'paragraph',
          attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
          content: [
            { type: 'text', text: 'She listened to the ' },
            { type: 'text', text: 'second', marks: [{ type: 'italic' }] },
            { type: 'text', text: ' one fade.' }
          ]
        }
      },
      { type: 'blank' },
      { type: 'break' },
      {
        type: 'paragraph',
        node: {
          type: 'paragraph',
          attrs: { [PARAGRAPH_ORIGIN_ATTR]: IMPORTED_ORIGIN },
          content: [{ type: 'text', text: 'Morning came slowly.' }]
        }
      }
    ])
  })

  it('refuses a file that is not a DOCX', async () => {
    await expect(readDocx(Buffer.from('not a zip'))).rejects.toThrow()
  })
})
