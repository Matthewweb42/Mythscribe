import type { IpcError, IpcErrorCode } from '@shared/ipc/contract'

/** Throw this from handlers to return a typed error to the renderer. */
export class AppError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
    readonly details?: unknown
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/** SQLite failures of the disk or the file, as opposed to bad SQL or a constraint. */
const SQLITE_IO = /^SQLITE_(IOERR|BUSY|LOCKED|CANTOPEN|FULL|READONLY|CORRUPT|NOTADB)/

export function toIpcError(err: unknown): IpcError {
  if (err instanceof AppError) {
    return { code: err.code, message: err.message, details: err.details }
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { code: 'NOT_FOUND', message: err.message }
    if (code === 'EEXIST') return { code: 'ALREADY_EXISTS', message: err.message }
    if (code === 'EACCES' || code === 'EPERM' || code === 'EBUSY') {
      return { code: 'IO', message: err.message }
    }
    // SQLite's extended code (SQLITE_IOERR_WRITE, SQLITE_IOERR_SHMMAP, …) says which file
    // operation failed, so it travels in the message: "disk I/O error" alone cannot be diagnosed.
    if (typeof code === 'string' && SQLITE_IO.test(code)) {
      return { code: 'IO', message: `${err.message} (${code})`, details: { sqliteCode: code } }
    }
    return { code: 'INTERNAL', message: err.message }
  }
  return { code: 'INTERNAL', message: String(err) }
}
