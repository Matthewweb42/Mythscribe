import type { TiptapMarkT, TiptapNodeT } from '@shared/tiptap'

/**
 * The v0 editor's Slate JSON as Tiptap JSON (F-1.6). v0 stored an array of blocks: `paragraph`
 * and `heading` (both with an optional `align`), `blockquote`, and `sceneBreak`, each holding text
 * leaves with `bold`, `italic`, `underline`, `strikethrough`, and `code`. Leaves also carried
 * presentation the v1 schema does not have (font size, colours, highlight) and v0's inline tag
 * marks (`isTag`, `tagId`): those are dropped and the text kept, so automatic mentions (F-4.12)
 * find the names again. Pure and lenient: an unreadable value becomes plain paragraphs, never an
 * error, because the author's words matter more than their formatting.
 */

const ALIGNMENTS = new Set(['center', 'right', 'justify'])
const MARKS: Record<string, string> = {
  bold: 'bold',
  italic: 'italic',
  underline: 'underline',
  strikethrough: 'strike',
  code: 'code'
}
/** v1's heading levels (`HEADING_LEVELS` in the editor); deeper v0 levels become level 3. */
const HEADING_MAX = 3

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The converted document, or null when the stored value holds no text at all. */
export function slateToTiptap(stored: string | null): TiptapNodeT | null {
  if (stored === null || stored.trim() === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(stored)
  } catch {
    return textToDoc(stored)
  }
  const blocks = Array.isArray(parsed) ? parsed : isObject(parsed) ? [parsed] : null
  // A JSON string, or text that happens to parse as a number or a word like `true`: still text.
  if (blocks === null) return textToDoc(typeof parsed === 'string' ? parsed : stored)
  const content = blocks.flatMap(convertBlock)
  return content.some(hasText) || content.some((node) => node.type === 'sceneBreak')
    ? { type: 'doc', content }
    : null
}

/**
 * The plain text of a stored v0 value: Slate blocks on their own lines, or the value itself when
 * it is not Slate JSON (v0's reference pages were plain text), line breaks kept.
 */
export function slateToText(stored: string | null): string {
  if (stored === null) return ''
  if (!stored.trimStart().startsWith('[')) return stored.trim()
  const doc = slateToTiptap(stored)
  if (doc === null) return ''
  return (doc.content ?? []).map(blockText).join('\n').trim()
}

function blockText(node: TiptapNodeT): string {
  if (node.text !== undefined) return node.text
  return (node.content ?? []).map(blockText).join(node.type === 'blockquote' ? '\n' : '')
}

/** Plain text as paragraphs, one per line; blank lines dropped. */
function textToDoc(text: string): TiptapNodeT | null {
  const content = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => ({ type: 'paragraph', content: [{ type: 'text', text: line }] }))
  return content.length > 0 ? { type: 'doc', content } : null
}

function convertBlock(block: unknown): TiptapNodeT[] {
  if (!isObject(block)) return []
  const type = typeof block.type === 'string' ? block.type : 'paragraph'
  if (type === 'sceneBreak') return [{ type: 'sceneBreak' }]
  if (type === 'blockquote') {
    const inner = paragraph(block, false)
    return [{ type: 'blockquote', content: [inner] }]
  }
  if (type === 'heading') {
    const raw = typeof block.level === 'number' ? Math.trunc(block.level) : 1
    const level = Math.min(Math.max(raw, 1), HEADING_MAX)
    const node = withText({ type: 'heading', attrs: { level } }, inline(block.children))
    return [withAlign(node, block)]
  }
  // `paragraph` and anything v0 never shipped but a hand-edited file might hold: keep its text.
  // A block that nests blocks (not a v0 shape) is flattened into its paragraphs.
  const children = Array.isArray(block.children) ? block.children : []
  if (children.some((child) => isObject(child) && 'type' in child)) {
    return children.flatMap(convertBlock)
  }
  return [paragraph(block, true)]
}

function paragraph(block: Json, aligned: boolean): TiptapNodeT {
  const node = withText({ type: 'paragraph' }, inline(block.children))
  return aligned ? withAlign(node, block) : node
}

/** An empty block keeps no `content` key, as the editor stores an empty paragraph. */
function withText(node: TiptapNodeT, text: TiptapNodeT[]): TiptapNodeT {
  return text.length > 0 ? { ...node, content: text } : node
}

function withAlign(node: TiptapNodeT, block: Json): TiptapNodeT {
  const align = block.align
  if (typeof align !== 'string' || !ALIGNMENTS.has(align)) return node
  return { ...node, attrs: { ...node.attrs, textAlign: align } }
}

/** The text leaves, with their marks; adjacent leaves with the same marks are merged. */
function inline(children: unknown): TiptapNodeT[] {
  if (!Array.isArray(children)) return []
  const out: TiptapNodeT[] = []
  for (const leaf of children) {
    if (!isObject(leaf)) continue
    // An inline element (v0 had none, but Slate allows them) contributes its text.
    if (Array.isArray(leaf.children)) {
      out.push(...inline(leaf.children))
      continue
    }
    const text = typeof leaf.text === 'string' ? leaf.text.replace(/\r?\n/g, ' ') : ''
    if (text === '') continue
    const marks: TiptapMarkT[] = Object.entries(MARKS)
      .filter(([key]) => leaf[key] === true)
      .map(([, type]) => ({ type }))
    const previous = out.at(-1)
    if (previous?.text !== undefined && sameMarks(previous.marks ?? [], marks)) {
      out[out.length - 1] = { ...previous, text: previous.text + text }
      continue
    }
    out.push(marks.length > 0 ? { type: 'text', text, marks } : { type: 'text', text })
  }
  return out
}

function sameMarks(a: readonly TiptapMarkT[], b: readonly TiptapMarkT[]): boolean {
  return a.length === b.length && a.every((mark, index) => mark.type === b[index]?.type)
}

function hasText(node: TiptapNodeT): boolean {
  if (node.text !== undefined) return node.text.trim() !== ''
  return (node.content ?? []).some(hasText)
}
