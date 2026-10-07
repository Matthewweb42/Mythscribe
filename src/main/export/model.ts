import type { ExportOptions } from '@shared/bookExport'
import { BUILTIN_COMPILE_FORMATS, type CompileFormat } from '@shared/compileFormat'
import type { CompiledBook, ContentBlock, Inline as CompiledInline } from '@shared/compileModel'

/**
 * The F-12.1 writers' book model: units of titles, paragraphs, headings, quotes, and scene breaks
 * with plain runs. Since Compile v2 (CV1) it is no longer built from the tree here: `collect.ts`
 * runs the shared compile model (`@shared/compileModel`) and `legacyUnits` adapts its items, so
 * the Export dialog keeps working until the CV2 writers render `CompiledBook` directly. Pure; the
 * renderers own all escaping.
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
  /**
   * A part (level `part`) or chapter-level title from the tree: a chapter, or a scene placed at
   * chapter level such as a prologue. `inPart`: the title sits inside a part (false for a part,
   * and for a chapter-level node right under the manuscript root).
   */
  | { kind: 'title'; level: 'part' | 'chapter'; text: string; inPart: boolean }
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

/**
 * The compile format the F-12.1 Export dialog's options stand for, until the compile window
 * (Compile v2, CV3) replaces the dialog: node titles as headings (nothing numbered), the dialog's
 * scene break text, the project's own front and end matter when asked, no generated pages, no
 * replacements. Only structure is read from it; the legacy writers still take
 * `ExportOptions.formatting` for the look.
 */
export function legacyCompileFormat(options: ExportOptions): CompileFormat {
  const plain = BUILTIN_COMPILE_FORMATS.find((f) => f.id === 'builtin:plain-text')
  if (plain === undefined) throw new Error('The built-in Plain text format is missing')
  return {
    ...plain,
    id: 'legacy:export',
    name: 'Export',
    sceneSeparator: { kind: 'text', text: options.formatting.sceneBreak },
    matter: {
      ...plain.matter,
      titlePage: 'none',
      frontMatter: options.includeFront,
      endMatter: options.includeEnd
    },
    contents: { body: 'text', notes: 'none', keepTags: false, keepAiMarks: false },
    replacements: []
  }
}

function legacyInlines(runs: readonly CompiledInline[]): Inline[] {
  return runs.map((run): Inline =>
    run.kind === 'hardBreak'
      ? run
      : {
          kind: 'text',
          text: run.text,
          bold: run.bold,
          italic: run.italic,
          underline: run.underline,
          strike: run.strike,
          code: run.code
        }
  )
}

function legacyBlocks(blocks: readonly ContentBlock[]): BookBlock[] {
  return blocks.map((block): BookBlock => {
    switch (block.kind) {
      case 'paragraph':
        return { kind: 'paragraph', runs: legacyInlines(block.runs), align: block.align }
      case 'heading':
        return {
          kind: 'heading',
          level: block.level,
          runs: legacyInlines(block.runs),
          align: block.align
        }
      case 'quote':
        return { kind: 'quote', blocks: legacyBlocks(block.blocks) }
      case 'separator':
        return { kind: 'sceneBreak' }
    }
  })
}

function matterUnit(item: Extract<CompiledBook['items'][number], { kind: 'matter' }>): BookUnit {
  return { kind: 'matter', title: item.title, blocks: legacyBlocks(item.blocks) }
}

/**
 * The compiled book as the F-12.1 writers' units: each matter item its own unit, and the body one
 * unit titled `bodyTitle` (left out when it prints no word of text, titles included). Section
 * headings become titles (a chapter-level scene a chapter title), separators scene breaks.
 */
export function legacyUnits(book: CompiledBook, bodyTitle: string): BookUnit[] {
  const front: BookUnit[] = []
  const back: BookUnit[] = []
  const body: BookBlock[] = []
  for (const item of book.items) {
    switch (item.kind) {
      case 'matter':
        if (item.division === 'front') front.push(matterUnit(item))
        else back.push(matterUnit(item))
        break
      case 'section':
        if (item.heading !== null && item.level !== 'scene') {
          body.push({
            kind: 'title',
            level: item.level === 'part' ? 'part' : 'chapter',
            text: item.heading.lines.join(' '),
            inPart: item.inPart
          })
        }
        break
      case 'separator':
        body.push({ kind: 'sceneBreak' })
        break
      case 'text':
        body.push(...legacyBlocks(item.blocks))
        break
      case 'page':
      case 'synopsis':
      case 'note':
        break
    }
  }
  const bodyUnits: BookUnit[] =
    book.metadata.bodyWords > 0 ? [{ kind: 'body', title: bodyTitle, blocks: body }] : []
  return [...front, ...bodyUnits, ...back]
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
