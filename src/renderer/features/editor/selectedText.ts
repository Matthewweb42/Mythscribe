import type { Editor } from '@tiptap/core'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'

/**
 * The editor's selection as plain text, the way `docToText` reads a document (F-14.1): blocks
 * joined by newlines, an inline tag token as `#name`, atoms without text as nothing, trimmed.
 * Shared so the exemplar the author marks reads exactly like the manuscript text the profile
 * is computed from.
 */
export function selectedText(editor: Editor): string {
  const { from, to } = editor.state.selection
  return editor.state.doc
    .textBetween(from, to, '\n', (node) =>
      node.type.name === INLINE_TAG_NODE_TYPE && typeof node.attrs.name === 'string'
        ? `#${node.attrs.name}`
        : ''
    )
    .trim()
}
