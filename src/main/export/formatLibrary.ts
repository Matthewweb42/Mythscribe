import { randomUUID } from 'node:crypto'
import {
  COMPILE_FORMATS_MAX,
  CompileFormat,
  copyName,
  duplicateFormat,
  findCompileFormat,
  formatNameTaken,
  isBuiltinFormatId,
  sortFormats
} from '@shared/compileFormat'
import { AppError } from '../ipc/errors'

/**
 * The author's compile formats ("My formats", Compile v2): pure edits of the app-state list. The
 * handlers own reading and writing app state; these own the rules (built-ins are read-only, names
 * unique ignoring case, the cap) so they are tested without a file. Every function answers the
 * next list (sorted by name) and the format it touched.
 */

type Library = readonly CompileFormat[]

function assertNameFree(library: Library, name: string, exceptId: string | null): void {
  if (formatNameTaken(library, name, exceptId)) {
    throw new AppError('ALREADY_EXISTS', `A format named "${name.trim()}" already exists`, { name })
  }
}

/**
 * Duplicates a built-in or library format into the library under a new id and `name` (default
 * "<name> copy", numbered when taken). NOT_FOUND for an unknown source, VALIDATION at the cap,
 * ALREADY_EXISTS for a taken name.
 */
export function createFormat(
  library: Library,
  fromId: string,
  name: string | undefined,
  id = `my:${randomUUID()}`
): { library: CompileFormat[]; format: CompileFormat } {
  const source = findCompileFormat(library, fromId)
  if (source === null) throw new AppError('NOT_FOUND', 'Format not found', { id: fromId })
  if (library.length >= COMPILE_FORMATS_MAX) {
    throw new AppError('VALIDATION', `You can keep at most ${COMPILE_FORMATS_MAX} formats`)
  }
  const typed = name?.trim() ?? ''
  const chosen = typed.length > 0 ? typed : copyName(library, source.name)
  assertNameFree(library, chosen, null)
  const format = duplicateFormat(source, id, chosen)
  return { library: sortFormats([...library, format]), format }
}

/**
 * Replaces a library format (rename and every setting). VALIDATION for a built-in (duplicate it
 * first), NOT_FOUND for an id not in the library, ALREADY_EXISTS for a name another format has.
 */
export function saveFormat(
  library: Library,
  value: CompileFormat
): { library: CompileFormat[]; format: CompileFormat } {
  if (isBuiltinFormatId(value.id)) {
    throw new AppError('VALIDATION', 'A built-in format cannot be changed; duplicate it first', {
      id: value.id
    })
  }
  if (!library.some((f) => f.id === value.id)) {
    throw new AppError('NOT_FOUND', 'Format not found', { id: value.id })
  }
  const format = CompileFormat.parse(value)
  assertNameFree(library, format.name, format.id)
  return {
    library: sortFormats(library.map((f) => (f.id === format.id ? format : f))),
    format
  }
}

/** Deletes a library format. VALIDATION for a built-in, NOT_FOUND for an unknown id. */
export function deleteFormat(library: Library, id: string): CompileFormat[] {
  if (isBuiltinFormatId(id)) {
    throw new AppError('VALIDATION', 'A built-in format cannot be deleted', { id })
  }
  if (!library.some((f) => f.id === id)) throw new AppError('NOT_FOUND', 'Format not found', { id })
  return library.filter((f) => f.id !== id)
}
