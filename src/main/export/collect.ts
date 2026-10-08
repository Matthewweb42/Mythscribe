import type { CompileFormat, CompileOutput, CompileScope } from '@shared/compileFormat'
import { compileBook, type CompiledBook } from '@shared/compileModel'
import { compileSource } from '../document/compileStore'
import { AppError } from '../ipc/errors'
import { getBookDetails, getCompileState } from '../project/settingsStore'
import { listNodes, type TreeDb } from '../tree/treeStore'

/**
 * Refuses a single-document scope whose node is missing (NOT_FOUND) or a folder (VALIDATION),
 * before anything is compiled. Shared by the F-12.1 export and the compile window's run.
 */
export function checkCompileScope(db: TreeDb, scope: CompileScope): void {
  if (scope.kind !== 'document') return
  const row = listNodes(db).find((r) => r.id === scope.id)
  if (row === undefined) throw new AppError('NOT_FOUND', 'Document not found', { id: scope.id })
  if (row.kind !== 'document') {
    throw new AppError('VALIDATION', 'Only a document can be exported on its own', {
      id: scope.id
    })
  }
}

export interface CompileRequest {
  format: CompileFormat
  output: CompileOutput
  scope: CompileScope
  projectName: string
}

/** Whether a compiled book prints anything of the project: text, matter, synopses, or notes. */
export function hasContent(book: CompiledBook): boolean {
  return book.items.some(
    (item) =>
      item.kind === 'text' ||
      item.kind === 'matter' ||
      item.kind === 'synopsis' ||
      item.kind === 'note'
  )
}

/**
 * The project compiled through the model (Compile v2) from the stored documents, Book details,
 * and "Include in compile" exclusions, so the renderer flushes its stores before asking. Nothing
 * to print is VALIDATION.
 */
export function compileProject(db: TreeDb, request: CompileRequest): CompiledBook {
  checkCompileScope(db, request.scope)
  const book = compileBook({
    source: compileSource(db),
    format: request.format,
    output: request.output,
    details: getBookDetails(db),
    projectName: request.projectName,
    scope: request.scope,
    excluded: getCompileState(db).excluded
  })
  if (!hasContent(book)) throw new AppError('VALIDATION', 'Nothing to export.')
  return book
}
