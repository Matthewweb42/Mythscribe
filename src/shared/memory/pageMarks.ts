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

/**
 * The marks that say an AI wrote a block. The rule (F-16.6): once the author changes a block's
 * words they are hers, and these marks go. The page editor applies it to typing
 * (`clearAiMarks`); main's own author writes to stored pages (Replace in project) apply it with
 * `withoutAiMarks`.
 */
export const AI_MARK_ATTRS = [AI_FILED_ATTR, AI_WRITTEN_ATTR] as const

/**
 * `node` with its AI marks cleared (null, as the editor stores a cleared mark), for a block whose
 * words the author changed. The very same object when it carries none, so a manuscript block,
 * which never has these attributes, is never touched.
 */
export function withoutAiMarks(node: TiptapNodeT): TiptapNodeT {
  const attrs = node.attrs
  if (attrs === undefined) return node
  if (AI_MARK_ATTRS.every((attr) => attrs[attr] === null || attrs[attr] === undefined)) return node
  const cleared: Record<string, unknown> = { ...attrs }
  for (const attr of AI_MARK_ATTRS) if (attr in cleared) cleared[attr] = null
  return { ...node, attrs: cleared }
}

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

/** One inline child of a text block as the page's text reads it. */
function inlineText(child: TiptapNodeT): string {
  if (typeof child.text === 'string') return child.text
  return child.type === LINE_BREAK ? '\n' : ' '
}

/** One paragraph of a stored page with the block itself (its attributes: `aiFiled`, …). */
export interface PageTextBlock extends MarkedParagraph {
  block: TiptapNodeT
}

/**
 * The page's text blocks in `markedParagraphs` order, each with its block, so a caller can read a
 * block's marks (F-16.9: the filed lines of a Pinned page) by the same index.
 */
export function pageTextBlocks(doc: TiptapNodeT): PageTextBlock[] {
  const found: PageTextBlock[] = []
  const visit = (node: TiptapNodeT, inherited: boolean): void => {
    if (typeof node.text === 'string') return
    const children = node.content ?? []
    const marked = inherited || isNotCanon(node)
    if (children.some((child) => typeof child.text === 'string')) {
      const text = children.map(inlineText).join('')
      if (text.trim() !== '') {
        found.push({ index: found.length, text, notCanon: marked, block: node })
      }
      return
    }
    for (const child of children) visit(child, marked)
  }
  for (const child of doc.content ?? []) visit(child, false)
  return found
}

/**
 * The page's paragraphs (a text block with text, numbered from 0 in document order, the same
 * blocks and text as `passageParagraphs`) with whether each is Not canon: marked itself, or
 * inside a marked block (a list item or quote). Pure; positions are not needed for pages.
 */
export function markedParagraphs(doc: TiptapNodeT): MarkedParagraph[] {
  return pageTextBlocks(doc).map(({ index, text, notCanon }) => ({ index, text, notCanon }))
}

const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff

/** `text` as inline nodes carrying `marks`: each line break a `hardBreak`, no empty text node. */
function inlineNodes(text: string, marks: TiptapNodeT['marks']): TiptapNodeT[] {
  return text
    .split('\n')
    .flatMap((line, i) => [
      ...(i === 0 ? [] : [{ type: LINE_BREAK }]),
      ...(line === ''
        ? []
        : [
            marks === undefined || marks.length === 0
              ? { type: 'text', text: line }
              : { type: 'text', text: line, marks }
          ])
    ])
}

const sameMarks = (x: TiptapNodeT, y: TiptapNodeT): boolean =>
  JSON.stringify(x.marks ?? []) === JSON.stringify(y.marks ?? [])

/**
 * A text block (one `pageTextBlocks` returns) with its text, as `pageTextBlocks` reads it, changed
 * to `text` by the smallest edit: the words both share at the start and the end keep their nodes,
 * so the marks (bold, italic, links), line breaks and inline leaves outside the change stay as
 * they are. The new words take the marks of the text where the change starts (the text before
 * it, for a pure insertion); a line break in them is a `hardBreak`. The same block when nothing
 * changed. Used by *Update my note* (F-16.29), which must change only what the author changed.
 */
export function replaceBlockText(block: TiptapNodeT, text: string): TiptapNodeT {
  const children = block.content ?? []
  const before = children.map(inlineText).join('')
  if (before === text) return block
  const most = Math.min(before.length, text.length)
  let start = 0
  while (start < most && before[start] === text[start]) start += 1
  if (start > 0 && start < before.length && isLowSurrogate(before.charCodeAt(start))) start -= 1
  let tail = 0
  while (tail < most - start && before[before.length - 1 - tail] === text[text.length - 1 - tail]) {
    tail += 1
  }
  if (tail > 0 && isLowSurrogate(before.charCodeAt(before.length - tail))) tail -= 1
  const end = before.length - tail
  const inserted = text.slice(start, text.length - tail)
  const out: TiptapNodeT[] = []
  let marks: TiptapNodeT['marks'] = undefined
  let placed = false
  const place = (): void => {
    if (placed) return
    out.push(...inlineNodes(inserted, marks))
    placed = true
  }
  let at = 0
  for (const child of children) {
    const from = at
    const to = at + inlineText(child).length
    at = to
    if (to <= start) {
      out.push(child)
      if (typeof child.text === 'string') marks = child.marks
      continue
    }
    if (from >= end) {
      place()
      out.push(child)
      continue
    }
    // The child holds part of the change.
    if (typeof child.text === 'string') {
      if (start > from) out.push({ ...child, text: child.text.slice(0, start - from) })
      if (!placed) marks = child.marks
      place()
      if (end < to) out.push({ ...child, text: child.text.slice(end - from) })
    } else {
      // An inline leaf inside the changed words goes with them.
      place()
    }
  }
  place()
  const merged: TiptapNodeT[] = []
  for (const node of out) {
    const last = merged[merged.length - 1]
    if (
      last !== undefined &&
      typeof last.text === 'string' &&
      typeof node.text === 'string' &&
      sameMarks(last, node)
    ) {
      merged[merged.length - 1] = { ...last, text: last.text + node.text }
    } else if (typeof node.text !== 'string' || node.text !== '') {
      merged.push(node)
    }
  }
  return { ...block, content: merged }
}
