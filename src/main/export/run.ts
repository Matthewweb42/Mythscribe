import type {
  ExportOptions,
  ExportPageSize,
  ExportProgress,
  ExportResult
} from '@shared/bookExport'
import { writeBufferAtomic, writeTextAtomic } from '../fs'
import type { TreeDb } from '../tree/treeStore'
import { collectBook } from './collect'
import { renderDocx } from './docx'
import { renderEpub } from './epub'
import { renderPrintHtml } from './html'
import { renderMarkdown } from './markdown'

export interface ExportBookInput {
  options: ExportOptions
  /** The book's title in the file's metadata. */
  projectName: string
  /** The chosen file. */
  path: string
  requestId: string
  onProgress: (progress: ExportProgress) => void
  /** Prints the HTML to PDF; Electron's in the app, a fake in tests. */
  renderPdf: (html: string, pageSize: ExportPageSize) => Promise<Buffer>
}

/**
 * Runs one export (F-12.1): collects the book, renders it in the chosen format, and writes the
 * file atomically, reporting each stage under `requestId`. Rendering counts the book's units
 * (front matter, body, end matter) so a long manuscript shows progress; PDF renders in one step
 * once the page is built.
 */
export async function exportBook(db: TreeDb, input: ExportBookInput): Promise<ExportResult> {
  const { options, projectName, path, requestId, onProgress } = input
  const report = (stage: ExportProgress['stage'], done: number, total: number): void =>
    onProgress({ requestId, stage, done, total })

  report('collect', 0, 1)
  const book = collectBook(db, options, projectName)
  report('collect', 1, 1)

  const { formatting } = options
  const total = book.units.length
  report('render', 0, total)
  let output: string | Buffer
  switch (options.format) {
    case 'md':
      output = renderMarkdown(book.units, formatting.sceneBreak)
      break
    case 'docx':
      output = renderDocx(book.units, formatting, projectName)
      break
    case 'epub':
      output = renderEpub(book.units, formatting, projectName)
      break
    case 'pdf':
      output = await input.renderPdf(
        renderPrintHtml(book.units, formatting, projectName),
        formatting.pageSize
      )
      break
  }
  report('render', total, total)

  report('write', 0, 1)
  if (typeof output === 'string') writeTextAtomic(path, output)
  else writeBufferAtomic(path, output)
  report('write', 1, 1)
  return { path, format: options.format, words: book.words }
}
