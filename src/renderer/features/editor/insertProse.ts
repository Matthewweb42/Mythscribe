import type { Transaction } from '@tiptap/pm/state'

/** A blank line (one or more empty or whitespace-only lines) between two paragraphs of plain prose. */
const PARAGRAPH_BREAK = /\n[ \t]*\n\s*/

/**
 * Inserts plain prose at `from` the way the manuscript reads it: blank lines split the text
 * into paragraphs of the same block type (a split at `from`, so the first paragraph joins the
 * text before it), and a single newline inside a paragraph becomes a hard break (a space where
 * the schema has none). Shared by ghost text (F-5.3, F-5.4) and the rewrite accept (F-14.10)
 * so an AI answer lands the same way wherever it came from. Returns the position right after
 * what was inserted, which is past `text.length` whenever a block boundary or a break token
 * went in.
 */
export function insertProse(tr: Transaction, from: number, text: string): number {
  const schema = tr.doc.type.schema
  const hardBreak = schema.nodes.hardBreak
  let pos = from
  text.split(PARAGRAPH_BREAK).forEach((paragraph, index) => {
    if (index > 0) {
      tr.split(pos)
      pos += 2
    }
    paragraph.split('\n').forEach((line, lineIndex) => {
      if (lineIndex > 0) {
        if (hardBreak) {
          tr.insert(pos, hardBreak.create())
          pos += 1
        } else {
          tr.insertText(' ', pos)
          pos += 1
        }
      }
      if (line) {
        tr.insertText(line, pos)
        pos += line.length
      }
    })
  })
  return pos
}
