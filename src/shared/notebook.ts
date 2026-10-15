import { z } from 'zod'
import { docToText } from './docText'
import { TiptapNode, type TiptapNodeT } from './tiptap'

/**
 * The notebook (notes redesign phase 1, `docs/research/notes-redesign-2026-10-15/phase1.md`):
 * the author's note pages in folders, edited by the author and by Ms Scribe. Named `notebook` in
 * code because `notes:*` is the per-scene notes panel (F-3.7); the UI calls it Notes.
 */

export const NOTEBOOK_KINDS = ['folder', 'page'] as const
export const NotebookKind = z.enum(NOTEBOOK_KINDS)
export type NotebookKind = z.infer<typeof NotebookKind>

/** Who wrote a page version: the author, Ms Scribe, or an import. */
export const NOTEBOOK_AUTHORS = ['me', 'ai', 'import'] as const
export const NotebookAuthor = z.enum(NOTEBOOK_AUTHORS)
export type NotebookAuthor = z.infer<typeof NotebookAuthor>

/** Versions kept per page (the Undo of Ms Scribe's edits and a short history). */
export const NOTEBOOK_VERSIONS_KEPT = 20

/** A row of the notebook tree, without its content. */
export const NotebookItem = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  kind: NotebookKind,
  title: z.string(),
  position: z.number(),
  modified: z.string()
})
export type NotebookItem = z.infer<typeof NotebookItem>

/** A page with its content (Tiptap JSON; null for an empty page or a folder). */
export const NotebookPage = NotebookItem.extend({
  content: TiptapNode.nullable(),
  /** The page's plain text, derived (search and prompts). */
  plain: z.string(),
  created: z.string()
})
export type NotebookPage = z.infer<typeof NotebookPage>

/** One kept version of a page (newest first in a list). */
export const NotebookVersion = z.object({
  id: z.string(),
  pageId: z.string(),
  author: NotebookAuthor,
  title: z.string(),
  content: TiptapNode.nullable(),
  created: z.string()
})
export type NotebookVersion = z.infer<typeof NotebookVersion>

/** The longest page or folder title. */
export const NOTEBOOK_TITLE_MAX = 200

export const NotebookTitle = z.string().trim().min(1).max(NOTEBOOK_TITLE_MAX)

/** The plain text of a page's content, '' when empty. */
export function notebookPlain(content: TiptapNodeT | null): string {
  return content === null ? '' : docToText(content)
}

/** A Tiptap document of plain paragraphs, one per line (imports and Ms Scribe's writes). */
export function notebookDocFromText(text: string): TiptapNodeT {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return {
    type: 'doc',
    content: lines.map((line) =>
      line.length === 0 ? { type: 'paragraph' } : { type: 'paragraph', content: [{ type: 'text', text: line }] }
    )
  }
}
