import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'

export interface RangeTextOptions {
  /** Put between two blocks; `docToText` (F-14.1) uses one newline, the rewrite passage (F-14.10) a blank line. */
  blockSeparator: string
  /** What a hard break reads as: nothing (the exemplar) or a newline (the rewrite passage). */
  hardBreak: string
}

/**
 * The plain text of `[from, to)` the way the manuscript reads it: blocks joined by
 * `blockSeparator`, an inline tag token as `#name`, a hard break as `hardBreak`, any other
 * atom as nothing. Not trimmed: the callers decide what the edges mean.
 */
export function rangeText(
  doc: PmNode,
  from: number,
  to: number,
  { blockSeparator, hardBreak }: RangeTextOptions
): string {
  return doc.textBetween(from, to, blockSeparator, (node) => {
    if (node.type.name === INLINE_TAG_NODE_TYPE && typeof node.attrs.name === 'string') {
      return `#${node.attrs.name}`
    }
    return node.type.name === 'hardBreak' ? hardBreak : ''
  })
}

/**
 * The editor's selection as plain text, the way `docToText` reads a document (F-14.1): blocks
 * joined by newlines, an inline tag token as `#name`, atoms without text as nothing, trimmed.
 * Shared so the exemplar the author marks reads exactly like the manuscript text the profile
 * is computed from.
 */
export function selectedText(editor: Editor): string {
  const { from, to } = editor.state.selection
  return rangeText(editor.state.doc, from, to, { blockSeparator: '\n', hardBreak: '' }).trim()
}
