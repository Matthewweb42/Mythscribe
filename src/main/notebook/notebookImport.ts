import { CONTEXT_FILE_MAX_BYTES, contextFileTypeOf } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import {
  NOTEBOOK_TITLE_MAX,
  notebookDocFromText,
  notebookTitleFromFileName,
  type NotebookImportResult,
  type NotebookItem
} from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import type { ImportBlock } from '../import/blocks'
import { readDocx } from '../import/docx'
import { readMarkdown, readPlainText } from '../import/text'
import { extractContextText } from '../library/extract'
import type { TreeDb } from '../tree/treeStore'
import { createNotebookItem } from './notebookStore'

/**
 * Importing files as note pages (notes redesign phase 1, slice 1): one page per file, through the
 * readers the manuscript import (F-12.2) and the context library (F-9.8) already use. Word and
 * Markdown keep their headings and paragraphs (with bold and italic), plain text its paragraphs,
 * a PDF the paragraphs of its text layer. A file dropped inside folders lands in the same folders,
 * made once per import.
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

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Imports `sources` under `parentId`: the folders each was dropped in first (one folder per path,
 * made on first use), then its page. A file that cannot become a page is skipped with its reason
 * and the rest still import.
 */
export async function importNotebookFiles(
  db: TreeDb,
  parentId: string | null,
  sources: readonly NotebookImportSource[]
): Promise<NotebookImportResult> {
  const items: NotebookItem[] = []
  const skipped: NotebookImportResult['skipped'] = []
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
    const made = createNotebookItem(db, {
      parentId: folderFor(source.folders),
      kind: 'page',
      title: notebookTitleFromFileName(source.name),
      content: page.content
    })
    items.push(made)
  }
  return { items: items.map(toItem), skipped }
}

function toItem(page: NotebookItem): NotebookItem {
  return {
    id: page.id,
    parentId: page.parentId,
    kind: page.kind,
    title: page.title,
    position: page.position,
    modified: page.modified
  }
}
