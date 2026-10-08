import fs from 'node:fs'
import { assetUrl, imageExtension } from '@shared/assets'
import type { ExportProgress } from '@shared/bookExport'
import { webDocument } from '@shared/compileHtml'
import type {
  CompileFormat,
  CompileOutput,
  CompileRunResult,
  CompileScope
} from '@shared/compileFormat'
import type { CompiledBook } from '@shared/compileModel'
import { writeBufferAtomic, writeTextAtomic } from '../fs'
import { assetPathFor } from '../project/assetUrl'
import type { TreeDb } from '../tree/treeStore'
import { compileProject } from './collect'
import { renderDocx } from './docx'
import { renderEpub, type EpubCover } from './epub'
import { renderMarkdown } from './markdown'
import { renderOdt } from './odt'
import { renderRtf } from './rtf'
import { renderText } from './text'

/** Prints a compiled book to PDF; Electron's Paged.js printer in the app, a fake in tests. */
export type PdfRenderer = (book: CompiledBook) => Promise<Buffer>

/**
 * The book's cover for the EPUB: the Book details cover file under the project's
 * `assets/covers/`, when the format includes it and the file reads; null otherwise.
 */
export function readCover(projectFolder: string, book: CompiledBook): EpubCover | null {
  const name = book.metadata.cover
  if (name === null) return null
  const extension = imageExtension(name)
  const file = assetPathFor(projectFolder, assetUrl('covers', name))
  if (extension === null || file === null) return null
  try {
    return { data: fs.readFileSync(file), extension }
  } catch {
    return null
  }
}

/** The compiled book in one output: text for the text formats, bytes for the packages. */
export async function renderOutput(
  book: CompiledBook,
  output: CompileOutput,
  projectFolder: string,
  renderPdf: PdfRenderer
): Promise<string | Buffer> {
  switch (output) {
    case 'pdf':
      return renderPdf(book)
    case 'docx':
      return renderDocx(book)
    case 'epub':
      return renderEpub(book, { cover: readCover(projectFolder, book) })
    case 'rtf':
      return renderRtf(book)
    case 'odt':
      return renderOdt(book)
    case 'html':
      return webDocument(book)
    case 'txt':
      return renderText(book)
    case 'md':
      return renderMarkdown(book)
  }
}

export interface CompileFileInput {
  format: CompileFormat
  output: CompileOutput
  scope: CompileScope
  /** The book's title when Book details has none. */
  projectName: string
  /** The project folder (the cover lives under its `assets/covers/`). */
  projectFolder: string
  /** The chosen file. */
  path: string
  requestId: string
  onProgress: (progress: ExportProgress) => void
  renderPdf: PdfRenderer
}

/**
 * Runs one compile (Compile v2): compiles the project through the model, renders the output, and
 * writes the file atomically, reporting each stage (`collect`, `render`, `write`) under
 * `requestId` on the `export:progress` shape.
 */
export async function compileToFile(
  db: TreeDb,
  input: CompileFileInput
): Promise<CompileRunResult> {
  const { requestId, onProgress } = input
  const report = (stage: ExportProgress['stage'], done: number): void =>
    onProgress({ requestId, stage, done, total: 1 })

  report('collect', 0)
  const book = compileProject(db, input)
  report('collect', 1)

  report('render', 0)
  const output = await renderOutput(book, input.output, input.projectFolder, input.renderPdf)
  report('render', 1)

  report('write', 0)
  if (typeof output === 'string') writeTextAtomic(input.path, output)
  else writeBufferAtomic(input.path, output)
  report('write', 1)
  return { path: input.path, output: input.output, words: book.words }
}
