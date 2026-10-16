import fs from 'node:fs'
import { eq } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import {
  DOCS_FOLDER_TITLE,
  NOTEBOOK_DOCS_COPIED_KEY,
  notebookDocFromText,
  notebookTitleFromFileName
} from '@shared/notebook'
import type { TiptapNodeT } from '@shared/tiptap'
import { settings } from '../db/schema'
import { getContextFileRow, listContextFiles, storedPath } from '../library/libraryStore'
import type { TreeDb } from '../tree/treeStore'
import { notebookPageFromFile } from './notebookImport'
import { createNotebookItem } from './notebookStore'

/**
 * Notes redesign, fresh start (the author 2026-10-15): the author's uploaded docs (the Library's
 * files, her own writing) come into Notes as editable pages in a top-level folder "Docs", once per
 * project. Free, local, no AI. The Library's rows and files stay as they were.
 *
 * Each file is read again from its stored original through the notes import's readers, so Word
 * and Markdown keep their headings; when the original cannot be read (gone, or a reader fails),
 * the text the Library stored for it is used, one paragraph per line. A file with no text (an
 * image) is left out. A project whose Library is empty is left alone (nothing to copy, nothing
 * recorded). Once the Library has files the copy runs and is recorded in the project settings,
 * whether or not it made pages, so it never runs twice and a Docs folder the author deleted is
 * never made again.
 */

/** One page the copy makes. */
export interface DocsPage {
  title: string
  content: TiptapNodeT
}

/** Whether this project has been through the copy already. */
export function libraryDocsCopied(db: TreeDb): boolean {
  return (
    db.select().from(settings).where(eq(settings.key, NOTEBOOK_DOCS_COPIED_KEY)).get() !== undefined
  )
}

function hasText(content: TiptapNodeT): boolean {
  return docToText(content).trim().length > 0
}

/** The pages the Library's files make, in name order; reads the originals, writes nothing. */
export async function readLibraryDocs(db: TreeDb, folder: string): Promise<DocsPage[]> {
  const files = listContextFiles(db)
    .filter((file) => file.type !== 'image')
    .sort((a, b) => a.name.localeCompare(b.name))
  const pages: DocsPage[] = []
  for (const file of files) {
    const row = getContextFileRow(db, file.id)
    if (row === undefined) continue
    let content: TiptapNodeT | null = null
    try {
      const page = await notebookPageFromFile(
        row.name,
        fs.readFileSync(storedPath(folder, row.stored))
      )
      if ('content' in page) content = page.content
    } catch {
      content = null
    }
    if (content === null && row.processedText !== null && row.processedText.trim() !== '') {
      content = notebookDocFromText(row.processedText.trim())
    }
    if (content !== null && hasText(content)) {
      pages.push({ title: notebookTitleFromFileName(row.name), content })
    }
  }
  return pages
}

/**
 * Writes the copy in one transaction: the Docs folder with `pages` (none when there are no pages)
 * and the settings row. Answers the ids made; nothing at all when the copy was already recorded.
 */
export function writeLibraryDocs(db: TreeDb, pages: readonly DocsPage[], now: Date): string[] {
  return db.transaction((tx) => {
    if (libraryDocsCopied(tx)) return []
    const ids: string[] = []
    if (pages.length > 0) {
      const docs = createNotebookItem(tx, {
        parentId: null,
        kind: 'folder',
        title: DOCS_FOLDER_TITLE
      })
      ids.push(docs.id)
      for (const page of pages) {
        const made = createNotebookItem(tx, {
          parentId: docs.id,
          kind: 'page',
          title: page.title,
          content: page.content
        })
        ids.push(made.id)
      }
    }
    tx.insert(settings)
      .values({
        key: NOTEBOOK_DOCS_COPIED_KEY,
        value: JSON.stringify({ at: now.toISOString(), pages: pages.length })
      })
      .run()
    return ids
  })
}

/**
 * The whole copy for a project that has not been through it and has Library files: read them,
 * then write. Answers the ids made (empty when it had run before or there was nothing to copy). `stillOpen` is asked
 * after the reading, which is asynchronous: a project closed meanwhile is left for its next open.
 */
export async function copyLibraryDocsOnce(
  db: TreeDb,
  folder: string,
  stillOpen: () => boolean,
  now: () => Date = () => new Date()
): Promise<string[]> {
  if (libraryDocsCopied(db) || listContextFiles(db).length === 0) return []
  const pages = await readLibraryDocs(db, folder)
  if (!stillOpen()) return []
  return writeLibraryDocs(db, pages, now())
}
