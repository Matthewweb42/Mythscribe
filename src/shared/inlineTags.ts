import type { TiptapNodeT } from './tiptap'

/** The node type of an inline tag token in a document (F-4.6); the editor extension and the counters share it. */
export const INLINE_TAG_NODE_TYPE = 'inlineTag'

/**
 * How often each tag appears as an inline token in a document (F-4.6, for the tag bar's
 * occurrence list of F-4.4): a recursive walk over the stored JSON counting `inlineTag` nodes
 * by their `id` attribute, in order of first appearance. A token whose `id` is not a string
 * (a hand-edited file) is skipped rather than counted under a bogus key.
 */
export function countInlineTags(doc: TiptapNodeT): Record<string, number> {
  const counts: Record<string, number> = {}
  const walk = (node: TiptapNodeT): void => {
    if (node.type === INLINE_TAG_NODE_TYPE) {
      const id = node.attrs?.id
      if (typeof id === 'string') counts[id] = (counts[id] ?? 0) + 1
    }
    for (const child of node.content ?? []) walk(child)
  }
  walk(doc)
  return counts
}
