import { CONTEXT_FILE_MAX_BYTES, contextFileTypeOf } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import {
  NOTEBOOK_TITLE_MAX,
  notebookDocFromText,
  notebookTitleFromFileName,
  type NotebookImportResult,
  type NotebookImportSplit,
  type NotebookItem,
  type NotebookSplitResult
} from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppError } from '../ipc/errors'
import type { ImportBlock } from '../import/blocks'
import { readDocx } from '../import/docx'
import { readMarkdown, readPlainText } from '../import/text'
import { extractContextText } from '../library/extract'
import type { TreeDb } from '../tree/treeStore'
import { createNotebookItem, deleteNotebookItem, getNotebookPage } from './notebookStore'

/**
 * Importing files as note pages (notes redesign phase 1, slice 1): one page per file, through the
 * readers the manuscript import (F-12.2) and the context library (F-9.8) already use. Word and
 * Markdown keep their headings and paragraphs (with bold and italic), plain text its paragraphs,
 * a PDF the paragraphs of its text layer. A file dropped inside folders lands in the same folders,
 * made once per import. Notes structure part B (2026-10-16): Split at headings makes a folder per
 * file with a page per heading (`splitAtHeadings`), and a page already in Notes splits the same
 * way (`splitNotebookPage`).
 */

/** The heading levels a page holds (the editor's 1–3); a deeper heading becomes a level-3 one. */
const PAGE_HEADING_MAX = 3

const UNSUPPORTED = 'Notes import Word (.docx), Markdown (.md), text (.txt) and PDF files.'
const IMAGE = 'An image has no text to make a page from.'
const NO_TEXT = 'No text found in the file.'
const TOO_LARGE = 'The file is larger than 25 MB.'

/** One file to import: its name, the folders it was dropped in, and its bytes (read lazily). */
export interface NotebookImportSource {
  name: string
  folders: readonly string[]
  /** The file's size in bytes when known before reading (a picked path), for the size cap. */
  size?: number
  read: () => Buffer
}

function hasText(doc: TiptapNodeT): boolean {
  return docToText(doc).trim().length > 0
}

/** A page document from the import readers' blocks: headings and paragraphs; blanks and breaks dropped. */
export function blocksToPage(blocks: readonly ImportBlock[]): TiptapNodeT {
  const content: TiptapNodeT[] = []
  for (const block of blocks) {
    if (block.type === 'heading') {
      if (block.text.trim() === '') continue
      content.push({
        type: 'heading',
        attrs: { level: Math.min(Math.max(1, block.level), PAGE_HEADING_MAX) },
        content: [{ type: 'text', text: block.text }]
      })
    } else if (block.type === 'paragraph') {
      content.push(block.node)
    }
  }
  return { type: 'doc', content }
}

/**
 * The page a file becomes, or why it does not: Word through the manuscript's mammoth reader,
 * Markdown and text through its line readers, a PDF through the library's text-layer reader
 * (one paragraph per block of text).
 */
export async function notebookPageFromFile(
  name: string,
  data: Buffer
): Promise<{ content: TiptapNodeT } | { skip: string }> {
  const type = contextFileTypeOf(name)
  if (type === null) return { skip: UNSUPPORTED }
  if (type === 'image') return { skip: IMAGE }
  let content: TiptapNodeT
  switch (type) {
    case 'docx':
      content = blocksToPage(await readDocx(data))
      break
    case 'md':
      content = blocksToPage(readMarkdown(data.toString('utf8')))
      break
    case 'txt':
      content = blocksToPage(readPlainText(data.toString('utf8')))
      break
    case 'pdf': {
      const text = await extractContextText('pdf', data)
      content = notebookDocFromText((text ?? '').replace(/\n{2,}/g, '\n'))
      break
    }
  }
  return hasText(content) ? { content } : { skip: NO_TEXT }
}

/** One page of a split: its title and its blocks (null when the heading had nothing under it). */
export interface SplitPart {
  title: string
  content: TiptapNodeT | null
}

const headingText = (block: TiptapNodeT): string =>
  docToText({ type: 'doc', content: [block] })
    .replace(/\s+/g, ' ')
    .trim()

const isHeading = (block: TiptapNodeT): boolean =>
  block.type === 'heading' && headingText(block) !== ''

const levelOf = (block: TiptapNodeT): number => {
  const level = block.attrs?.level
  return typeof level === 'number' ? level : 1
}

/**
 * A document split at the headings of the highest level it uses (the smallest level number): one
 * part per such heading, titled by it, holding what follows it up to the next one (lower headings
 * stay inside); text before the first heading is a part titled `title`. Null when the document
 * has no heading. Nothing is lost: every block is in exactly one part, but the split headings,
 * which become the titles.
 */
export function splitAtHeadings(title: string, doc: TiptapNodeT | null): SplitPart[] | null {
  const blocks = doc?.content ?? []
  const headings = blocks.filter(isHeading)
  if (headings.length === 0) return null
  const top = Math.min(...headings.map(levelOf))
  const parts: { title: string; blocks: TiptapNodeT[] }[] = []
  let current: { title: string; blocks: TiptapNodeT[] } = { title, blocks: [] }
  let opening = true
  const close = (): void => {
    const body = { type: 'doc', content: current.blocks }
    // The text before the first heading is a page only when it holds something.
    if (!opening || hasText(body)) parts.push(current)
  }
  for (const block of blocks) {
    if (isHeading(block) && levelOf(block) === top) {
      close()
      opening = false
      current = { title: headingText(block).slice(0, NOTEBOOK_TITLE_MAX), blocks: [] }
    } else {
      current.blocks.push(block)
    }
  }
  close()
  return parts.map((part) => ({
    title: part.title,
    content: part.blocks.length === 0 ? null : { type: 'doc', content: part.blocks }
  }))
}

/**
 * Splits a page already in Notes at its headings, in one transaction: a folder named after the
 * page takes its place (its parent, its position), a page per part goes in it, and the page is
 * deleted (soft: restoring it and deleting the folder is the Undo). VALIDATION for a folder or a
 * page with no heading.
 */
export function splitNotebookPage(db: TreeDb, id: string): NotebookSplitResult {
  const page = getNotebookPage(db, id)
  if (page.kind !== 'page') throw new AppError('VALIDATION', 'Only a page can be split.')
  const parts = splitAtHeadings(page.title, page.content)
  if (parts === null) {
    throw new AppError('VALIDATION', `“${page.title}” has no headings to split at.`)
  }
  return db.transaction((tx) => {
    const folder = createNotebookItem(tx, {
      parentId: page.parentId,
      kind: 'folder',
      title: page.title,
      position: page.position
    })
    const pages = parts.map((part) =>
      createNotebookItem(tx, {
        parentId: folder.id,
        kind: 'page',
        title: part.title,
        content: part.content
      })
    )
    deleteNotebookItem(tx, id)
    return { folder: toItem(folder), pages: pages.map(toItem), pageId: id }
  })
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Imports `sources` under `parentId`: the folders each was dropped in first (one folder per path,
 * made on first use), then its page, or with `split` `headings` a folder named after the file
 * holding a page per heading (a file with no heading is one page, named in `unsplit`). A file
 * that cannot become a page is skipped with its reason and the rest still import.
 */
export async function importNotebookFiles(
  db: TreeDb,
  parentId: string | null,
  sources: readonly NotebookImportSource[],
  split: NotebookImportSplit = 'none'
): Promise<NotebookImportResult> {
  const items: NotebookItem[] = []
  const skipped: NotebookImportResult['skipped'] = []
  const unsplit: string[] = []
  const folders = new Map<string, string>()
  const folderFor = (path: readonly string[]): string | null => {
    let parent = parentId
    for (let depth = 1; depth <= path.length; depth++) {
      const key = path.slice(0, depth).join('\u0000')
      let id = folders.get(key)
      if (id === undefined) {
        const name = (path[depth - 1] ?? '').trim()
        const title = (name === '' ? 'Untitled' : name).slice(0, NOTEBOOK_TITLE_MAX)
        const folder = createNotebookItem(db, { parentId: parent, kind: 'folder', title })
        items.push(folder)
        id = folder.id
        folders.set(key, id)
      }
      parent = id
    }
    return parent
  }
  for (const source of sources) {
    if (source.size !== undefined && source.size > CONTEXT_FILE_MAX_BYTES) {
      skipped.push({ name: source.name, reason: TOO_LARGE })
      continue
    }
    let page: Awaited<ReturnType<typeof notebookPageFromFile>>
    try {
      page = await notebookPageFromFile(source.name, source.read())
    } catch (err) {
      skipped.push({ name: source.name, reason: `Could not read the file: ${messageOf(err)}` })
      continue
    }
    if ('skip' in page) {
      skipped.push({ name: source.name, reason: page.skip })
      continue
    }
    const title = notebookTitleFromFileName(source.name)
    const parts = split === 'headings' ? splitAtHeadings(title, page.content) : null
    if (split === 'headings' && parts === null) unsplit.push(source.name)
    if (parts === null) {
      items.push(
        createNotebookItem(db, {
          parentId: folderFor(source.folders),
          kind: 'page',
          title,
          content: page.content
        })
      )
      continue
    }
    const folder = createNotebookItem(db, {
      parentId: folderFor(source.folders),
      kind: 'folder',
      title
    })
    items.push(folder)
    for (const part of parts) {
      items.push(
        createNotebookItem(db, {
          parentId: folder.id,
          kind: 'page',
          title: part.title,
          content: part.content
        })
      )
    }
  }
  return {
    items: items.map(toItem),
    skipped,
    ...(split === 'headings' ? { unsplit } : {})
  }
}

function toItem(page: NotebookItem): NotebookItem {
  return {
    id: page.id,
    parentId: page.parentId,
    kind: page.kind,
    title: page.title,
    position: page.position,
    modified: page.modified,
    role: page.role ?? null
  }
}
