import { z } from 'zod'

/**
 * Tiptap (ProseMirror) JSON as stored in `node.content` (F-3.1). One owner for the shape so the
 * editor, the v0 importer (F-1.6), and the AI post-processors (§2.14) agree on it. The editor
 * schema decides which node and mark types are valid; this only pins the document structure.
 */
export interface TiptapMarkT {
  type: string
  attrs?: Record<string, unknown>
}

export interface TiptapNodeT {
  type: string
  attrs?: Record<string, unknown>
  content?: TiptapNodeT[]
  marks?: TiptapMarkT[]
  text?: string
}

const attrs = z.record(z.string(), z.unknown()).optional()

export const TiptapMark: z.ZodType<TiptapMarkT, TiptapMarkT> = z.object({ type: z.string(), attrs })

// Both type parameters are given so `z.input` of a channel that carries a document (`document:save`)
// is `TiptapNodeT` too, not `unknown`.
export const TiptapNode: z.ZodType<TiptapNodeT, TiptapNodeT> = z.lazy(() =>
  z.object({
    type: z.string(),
    attrs,
    content: z.array(TiptapNode).optional(),
    marks: z.array(TiptapMark).optional(),
    text: z.string().optional()
  })
)

/** What the editor shows for a document that has never been written to (`content` NULL). */
export const EMPTY_DOC: TiptapNodeT = { type: 'doc', content: [{ type: 'paragraph' }] }

/** A value with object keys in sorted order and absent (undefined) properties dropped. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  for (const [key, field] of entries) {
    if (field !== undefined) out[key] = canonical(field)
  }
  return out
}

/**
 * Whether two documents are the same JSON whatever order their keys were written in (the editor's
 * `getJSON` and a stored, schema-parsed document order them differently). Rename in book's undo
 * (F-16.13) restores a scene only while it still reads as the rename left it.
 */
export function sameTiptap(a: TiptapNodeT, b: TiptapNodeT): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}
