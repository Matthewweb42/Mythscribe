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
    return { code: 'INTERNAL', message: err.message }
  }
  return { code: 'INTERNAL', message: String(err) }
}
