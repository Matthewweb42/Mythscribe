import type { ExportOptions } from '@shared/bookExport'
import { compileBook, type CompiledBook } from '@shared/compileModel'
import { compileSource } from '../document/compileStore'
import { AppError } from '../ipc/errors'
import { getBookDetails, getCompileState } from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { legacyCompileFormat, legacyUnits, type BookUnit } from './model'

/**
 * The book an export prints (F-12.1): the units in reading order (front matter, the body, end
 * matter) and the words of the text they print. Collected from the stored documents, so the
 * renderer flushes its stores before asking.
 */
export interface Book {
  units: BookUnit[]
  words: number
}

/**
 * Refuses a single-document scope whose node is missing (NOT_FOUND) or a folder (VALIDATION),
 * before anything is compiled. Shared by the F-12.1 export and the compile window's run.
 */
export function checkCompileScope(db: TreeDb, scope: ExportOptions['scope']): void {
  if (scope.kind !== 'document') return
  const row = listNodes(db).find((r) => r.id === scope.id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Document not found', { id: scope.id })
  if (row.kind !== 'document') {
    throw new AppError('VALIDATION', 'Only a document can be exported on its own', {
      id: scope.id
    })
  }
}

/**
 * The book for `options` through the compile model (Compile v2): the manuscript, the chosen
 * chapters (with the parts that hold them as titles), or one document from any section printed
 * alone. Front and end matter come along when asked, except for a single document. Documents
 * unticked "Include in compile" are left out. Nothing to print is VALIDATION.
 */
export function collectBook(db: TreeDb, options: ExportOptions, projectName: string): Book {
  checkCompileScope(db, options.scope)
  const { scope } = options
  const book: CompiledBook = compileBook({
    source: compileSource(db),
    format: legacyCompileFormat(options),
    output: options.format,
    details: getBookDetails(db),
    projectName,
    scope,
    excluded: getCompileState(db).excluded
  })
  const bodyTitle =
    scope.kind === 'document'
      ? (listNodes(db).find((r) => r.id === scope.id)?.title ?? projectName)
      : projectName
  const units = legacyUnits(book, bodyTitle)
  if (units.length === 0) throw new AppError('VALIDATION', 'Nothing to export.')
  return { units, words: book.words }
}
