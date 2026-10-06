import { describe, expect, it } from 'vitest'
import { AppError, toIpcError } from './errors'

function withCode(message: string, code: string): Error {
  return Object.assign(new Error(message), { code })
}

describe('toIpcError', () => {
  it('reports a SQLite disk failure as IO with its extended code', () => {
    expect(toIpcError(withCode('disk I/O error', 'SQLITE_IOERR_SHMMAP'))).toEqual({
      code: 'IO',
      message: 'disk I/O error (SQLITE_IOERR_SHMMAP)',
      details: { sqliteCode: 'SQLITE_IOERR_SHMMAP' }
    })
    expect(toIpcError(withCode('database is locked', 'SQLITE_BUSY')).code).toBe('IO')
  })

  it('keeps bad SQL and constraints INTERNAL, and maps the file-system codes', () => {
    expect(toIpcError(withCode('UNIQUE constraint failed', 'SQLITE_CONSTRAINT_UNIQUE')).code).toBe(
      'INTERNAL'
    )
    expect(toIpcError(withCode('gone', 'ENOENT')).code).toBe('NOT_FOUND')
    expect(toIpcError(new AppError('NO_PROJECT', 'No project is open')).code).toBe('NO_PROJECT')
  })
})
