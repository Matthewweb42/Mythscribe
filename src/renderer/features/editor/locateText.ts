import type { Node as PmNode } from '@tiptap/pm/model'
import { normalizeForMatch, straightenQuotes } from '@shared/critique'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'

/** A character of the document as it is matched, with the position it lives at (−1 for a boundary space). */
interface Entry {
  char: string
  pos: number
}

/** A range of the document, the way the editor's commands take it. */
export interface TextRange {
  from: number
  to: number
}

/**
 * The document as one normalized string with a position per character: straight quotes,
 * whitespace runs (block boundaries and hard breaks included) as one space, an inline tag
 * token as `#name` (the way `rangeText` reads it). Exactly `normalizeForMatch`'s rules, so a
 * quote main found in the text it sent is found here too.
 */
function scan(doc: PmNode): Entry[] {
  const entries: Entry[] = []
  const push = (char: string, pos: number): void => {
    if (/\s/.test(char)) {
      if (entries.length === 0 || entries[entries.length - 1]?.char === ' ') return
      entries.push({ char: ' ', pos: -1 })
      return
    }
    entries.push({ char: straightenQuotes(char), pos })
  }
  doc.descendants((node, pos) => {
    if (node.isText) {
      const text = node.text ?? ''
      for (let i = 0; i < text.length; i++) push(text[i] ?? '', pos + i)
      return false
    }
    if (node.type.name === INLINE_TAG_NODE_TYPE && typeof node.attrs.name === 'string') {
      const token = `#${node.attrs.name}`
      // An atom is one position: every character of the token maps to the node itself.
      for (const char of token) push(char, pos)
      return false
    }
    if (node.type.name === 'hardBreak' || node.isBlock) push(' ', -1)
    return true
  })
  return entries
}

/**
 * Where `quote` sits in the document, or null when it is not there (F-14.8). Both sides are
 * normalized the way `normalizeForMatch` does, so a quote that crosses a paragraph break (one
 * space once normalized) still resolves to the range holding it; the range runs from the first
 * matched character to just past the last, which is what `setRewriteTarget` and a selection
 * take. The needle is trimmed, so a match never begins or ends on a boundary space.
 */
export function locateText(doc: PmNode, quote: string): TextRange | null {
  const needle = normalizeForMatch(quote)
  if (needle === '') return null
  const entries = scan(doc)
  const at = entries
    .map((entry) => entry.char)
    .join('')
    .indexOf(needle)
  if (at === -1) return null
  const first = entries[at]
  const last = entries[at + needle.length - 1]
  if (!first || !last || first.pos < 0 || last.pos < 0) return null
  return { from: first.pos, to: last.pos + 1 }
}
