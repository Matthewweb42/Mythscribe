import type { CompiledEntry } from '@shared/compile'
import { compiledBlocks } from '@shared/compiledBlocks'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import type { TiptapNodeT } from '@shared/tiptap'

/**
 * The export's neutral book model (F-12.1): the Tiptap JSON of the editor schema read into
 * paragraphs, headings, quotes, and scene breaks with plain runs, so every format renders the
 * same reading of a document. Pure; the renderers own all escaping.
 */

/** A stretch of text with the marks a book can print (the AI-origin mark is never printed). */
export interface Run {
  kind: 'text'
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  code: boolean
}

export interface HardBreak {
  kind: 'hardBreak'
}

export type Inline = Run | HardBreak

export const EXPORT_ALIGNMENTS = ['left', 'center', 'right', 'justify'] as const
export type Align = (typeof EXPORT_ALIGNMENTS)[number]

export type BookBlock =
  /** A part (level `part`) or chapter title from the tree. */
  | { kind: 'title'; level: 'part' | 'chapter'; text: string }
  | { kind: 'paragraph'; runs: Inline[]; align: Align | null }
  /** A heading the author set inside a document, 1–3; renderers print it below chapter titles. */
  | { kind: 'heading'; level: 1 | 2 | 3; runs: Inline[]; align: Align | null }
  | { kind: 'quote'; blocks: BookBlock[] }
  /** A scene break: the author's own inside a document, or the one between two scenes. */
  | { kind: 'sceneBreak' }

/**
 * One stretch that starts a new page (PDF, DOCX) and its own file (EPUB): a front or end matter
 * unit, whose title only labels the EPUB contents, or the body.
 */
export interface BookUnit {
  kind: 'matter' | 'body'
  title: string
  blocks: BookBlock[]
}

function alignOf(node: TiptapNodeT): Align | null {
  const value = node.attrs?.textAlign
  return EXPORT_ALIGNMENTS.find((align) => align === value) ?? null
}

function runOf(text: string, node: TiptapNodeT): Run {
  const marks = new Set((node.marks ?? []).map((mark) => mark.type))
  return {
    kind: 'text',
    text,
    bold: marks.has('bold'),
    italic: marks.has('italic'),
    underline: marks.has('underline'),
    strike: marks.has('strike'),
    code: marks.has('code')
  }
}

/**
 * The inline content of a paragraph or heading. An inline tag token prints its name without the
 * `#`: the token is a word of the author's sentence. Unknown inline nodes give their content.
 */
function inlines(nodes: readonly TiptapNodeT[]): Inline[] {
  const out: Inline[] = []
  for (const node of nodes) {
    if (node.type === 'text') {
      if (node.text !== undefined && node.text.length > 0) out.push(runOf(node.text, node))
    } else if (node.type === 'hardBreak') {
      out.push({ kind: 'hardBreak' })
    } else if (node.type === INLINE_TAG_NODE_TYPE) {
      const name = node.attrs?.name
      if (typeof name === 'string' && name.length > 0) out.push(runOf(name, node))
    } else {
      out.push(...inlines(node.content ?? []))
    }
  }
  return out
}

const INLINE_TYPES = new Set(['text', 'hardBreak', INLINE_TAG_NODE_TYPE])

/**
 * The blocks of a stored document. An empty paragraph prints nothing (books space paragraphs by
 * style, not by blank lines); inline content found at block level reads as its own paragraph;
 * unknown block nodes give their content.
 */
export function docBlocks(doc: TiptapNodeT): BookBlock[] {
  const out: BookBlock[] = []
  const walk = (nodes: readonly TiptapNodeT[], into: BookBlock[]): void => {
    let stray: TiptapNodeT[] = []
    const flush = (): void => {
      const runs = inlines(stray)
      if (runs.length > 0) into.push({ kind: 'paragraph', runs, align: null })
      stray = []
    }
    for (const node of nodes) {
      if (INLINE_TYPES.has(node.type)) {
        stray.push(node)
        continue
      }
      flush()
      if (node.type === 'paragraph') {
        const runs = inlines(node.content ?? [])
        if (runs.length > 0) into.push({ kind: 'paragraph', runs, align: alignOf(node) })
      } else if (node.type === 'heading') {
        const runs = inlines(node.content ?? [])
        const raw = node.attrs?.level
        const level = raw === 2 || raw === 3 ? raw : 1
        if (runs.length > 0) into.push({ kind: 'heading', level, runs, align: alignOf(node) })
      } else if (node.type === 'blockquote') {
        const blocks: BookBlock[] = []
        walk(node.content ?? [], blocks)
        if (blocks.length > 0) into.push({ kind: 'quote', blocks })
      } else if (node.type === 'sceneBreak') {
        into.push({ kind: 'sceneBreak' })
      } else {
        walk(node.content ?? [], into)
      }
    }
    flush()
  }
  walk(doc.type === 'doc' ? (doc.content ?? []) : [doc], out)
  return out
}

/**
 * The body's blocks in reading order, by the compiled preview's rules (`compiledBlocks` without
 * scene headers): a part or chapter prints its title, a break between scenes the scene break,
 * and a document its text.
 */
export function bodyBlocks(entries: readonly CompiledEntry[]): BookBlock[] {
  const out: BookBlock[] = []
  for (const block of compiledBlocks(entries, false)) {
    if (block.kind === 'heading') {
      out.push({ kind: 'title', level: block.level, text: block.entry.title })
    } else if (block.kind === 'break') {
      out.push({ kind: 'sceneBreak' })
    } else if (block.kind === 'text') {
      out.push(...docBlocks(block.content))
    }
  }
  return out
}

/**
 * Whether the block at `blockIndex` of unit `unitIndex` starts a new page: every unit after the
 * first does, and with `chapterNewPage` every part and chapter title that is not already at the
 * top of the book or of its unit.
 */
export function startsPage(
  unitIndex: number,
  blockIndex: number,
  block: BookBlock,
  chapterNewPage: boolean
): boolean {
  if (blockIndex === 0) return unitIndex > 0
  return chapterNewPage && block.kind === 'title'
}
