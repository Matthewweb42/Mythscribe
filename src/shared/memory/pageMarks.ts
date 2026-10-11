import type { TiptapNodeT } from '../tiptap'

/**
 * The marks a page paragraph may carry in stored JSON (F-16.5, F-16.6), read by main without the
 * editor: the passage index labels a paragraph `notCanon` from them, and the Story notes block
 * (P1 slice 5) leaves such paragraphs out. Slice 2's page schema writes them (`PageParagraph`),
 * and adds `aiFiled` and `aiWritten` here; manuscript documents never carry any of them.
 */

/** The paragraph attribute the Not canon mark is stored under (`data-not-canon` when rendered). */
export const NOT_CANON_ATTR = 'notCanon'

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
