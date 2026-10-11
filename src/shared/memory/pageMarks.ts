import { z } from 'zod'
import type { TiptapNodeT } from '../tiptap'

/**
 * The marks a page paragraph may carry in stored JSON (F-16.5, F-16.6, F-16.8), read by main
 * without the editor: the passage index labels a paragraph `notCanon` from them, and the Story
 * notes block (P1 slice 5) leaves such paragraphs out. The page schema writes them
 * (`PageParagraph` in the renderer, used by Research pages and, from slice 3, Pinned and Ideas);
 * manuscript documents and scene notes never carry any of them.
 */

/** The paragraph attribute the Not canon mark is stored under (`data-not-canon` when rendered). */
export const NOT_CANON_ATTR = 'notCanon'

/**
 * A paragraph filed from an upload (F-16.9, written from slice 5): the source document, the
 * paragraph there, and the words it was filed from. Cleared when the author edits the paragraph.
 */
export const AI_FILED_ATTR = 'aiFiled'
export const AiFiled = z.object({
  doc: z.string().min(1),
  para: z.number().int().nonnegative(),
  quote: z.string()
})
export type AiFiled = z.infer<typeof AiFiled>

/**
 * A paragraph Ms Scribe wrote from the chat (F-16.26, written from P3): the chat turn and the
 * day. Cleared when the author edits the paragraph.
 */
export const AI_WRITTEN_ATTR = 'aiWritten'
export const AiWritten = z.object({ turn: z.string().min(1), date: z.string().min(1) })
export type AiWritten = z.infer<typeof AiWritten>

/** Every attribute the page paragraph adds to the manuscript paragraph, by stored name. */
export const PAGE_ATTRS = [NOT_CANON_ATTR, AI_FILED_ATTR, AI_WRITTEN_ATTR] as const

/** The `aiFiled` mark of a stored block, or null when it has none (or an unreadable one). */
export function aiFiledOf(node: TiptapNodeT): AiFiled | null {
  const parsed = AiFiled.safeParse(node.attrs?.[AI_FILED_ATTR])
  return parsed.success ? parsed.data : null
}

/** The `aiWritten` mark of a stored block, or null when it has none (or an unreadable one). */
export function aiWrittenOf(node: TiptapNodeT): AiWritten | null {
  const parsed = AiWritten.safeParse(node.attrs?.[AI_WRITTEN_ATTR])
  return parsed.success ? parsed.data : null
}

/** Whether a stored block carries the Not canon mark. */
export function isNotCanon(node: TiptapNodeT): boolean {
  return node.attrs?.[NOT_CANON_ATTR] === true
}

/** One paragraph of a stored page with its mark, in `passageParagraphs` order. */
export interface MarkedParagraph {
  index: number
  text: string
  /** The block, or a block around it, is marked Not canon. */
  notCanon: boolean
}

/** Inline leaves that read as a line break; every other inline leaf reads as a space. */
const LINE_BREAK = 'hardBreak'

/**
 * The page's paragraphs (a text block with text, numbered from 0 in document order, the same
 * blocks and text as `passageParagraphs`) with whether each is Not canon: marked itself, or
 * inside a marked block (a list item or quote). Pure; positions are not needed for pages.
 */
export function markedParagraphs(doc: TiptapNodeT): MarkedParagraph[] {
  const found: MarkedParagraph[] = []
  const visit = (node: TiptapNodeT, inherited: boolean): void => {
    if (typeof node.text === 'string') return
    const children = node.content ?? []
    const marked = inherited || isNotCanon(node)
    if (children.some((child) => typeof child.text === 'string')) {
      let text = ''
      for (const child of children) {
        if (typeof child.text === 'string') text += child.text
        else text += child.type === LINE_BREAK ? '\n' : ' '
      }
      if (text.trim() !== '') found.push({ index: found.length, text, notCanon: marked })
      return
    }
    for (const child of children) visit(child, marked)
  }
  for (const child of doc.content ?? []) visit(child, false)
  return found
}
