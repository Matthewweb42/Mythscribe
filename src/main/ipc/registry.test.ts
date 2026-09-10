import { describe, expect, it, vi } from 'vitest'
import { createHandler } from './registry'
import { AppError } from './errors'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))

describe('createHandler', () => {
  it('validates input against the contract and returns VALIDATION errors', async () => {
    const fn = vi.fn()
    const handler = createHandler('project:create', fn)
    const result = await handler({ name: '', format: 'novel' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('VALIDATION')
    expect(fn).not.toHaveBeenCalled()
  })

  it('passes parsed input to the handler and wraps the result', async () => {
    const handler = createHandler('app:info', async () => ({ version: '1.0.0', platform: 'linux' }))
    const result = await handler(undefined)
    expect(result).toEqual({ ok: true, data: { version: '1.0.0', platform: 'linux' } })
  })

  it('converts AppError into a typed error envelope', async () => {
    const handler = createHandler('project:open', () => {
      throw new AppError('NOT_FOUND', 'no such project', { path: '/x' })
    })
    const result = await handler({ path: '/x' })
    expect(result).toEqual({
      ok: false,
      error: { code: 'NOT_FOUND', message: 'no such project', details: { path: '/x' } }
    })
  })

  it('converts unknown errors into INTERNAL', async () => {
    const handler = createHandler('project:close', () => {
      throw new Error('boom')
    })
    const result = await handler(undefined)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe('INTERNAL')
  })
})
