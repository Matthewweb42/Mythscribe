import { INLINE_TAG_NODE_TYPE } from './inlineTags'
import type { TiptapNodeT } from './tiptap'

/**
 * The plain text of a Tiptap document (F-4.7): block children of the root joined by newlines,
 * every `text` leaf as-is, and an inline tag token (F-4.6) rendered as `#name`, the way the
 * author sees it in the editor. One owner, so the tag bar's 50-character gate and the text a
 * prompt sends agree; atoms without text (the scene break) contribute nothing. A token whose
 * `name` is not a string (a hand-edited file) renders as an empty string rather than `#`.
 */
export function docToText(doc: TiptapNodeT): string {
  return (doc.content ?? []).map(blockText).join('\n')
}

function blockText(node: TiptapNodeT): string {
  if (node.type === INLINE_TAG_NODE_TYPE) {
    const name = node.attrs?.name
    return typeof name === 'string' ? `#${name}` : ''
  }
  if (node.text !== undefined) return node.text
  return (node.content ?? []).map(blockText).join('')
}
