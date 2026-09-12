import { INLINE_TAG_NODE_TYPE } from './inlineTags'
import type { TiptapNodeT } from './tiptap'

/**
 * Counts the words of a Tiptap document (F-3.2): every `text` leaf is split on whitespace and
 * empty tokens are dropped, so marks, alignment, and block structure never change the count.
 * An inline tag token (F-4.6) counts as one word (its visible name); atoms without text (the
 * scene break) count as 0. One owner, so the cached `node.word_count` and any live count in the
 * renderer agree.
 */
export function countWords(doc: TiptapNodeT): number {
  let total = 0
  if (doc.type === INLINE_TAG_NODE_TYPE) total += 1
  if (doc.text !== undefined) {
    for (const token of doc.text.split(/\s+/)) if (token.length > 0) total += 1
  }
  for (const child of doc.content ?? []) total += countWords(child)
  return total
}
