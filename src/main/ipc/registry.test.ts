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

  it('rejects recents:remove without a path', async () => {
    const fn = vi.fn()
    const handler = createHandler('recents:remove', fn)
    const result = await handler({})
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

describe('the story-memory gate (F-16.4)', () => {
  it('refuses a channel of the other memory with VALIDATION before the handler runs', async () => {
    const fn = vi.fn(() => [])
    const v1Project = createHandler('record:list', fn, undefined, () => 'v1')
    const result = await v1Project(undefined)
    expect(result).toEqual({
      ok: false,
      error: {
        code: 'VALIDATION',
        message: 'This project uses the other story memory',
        details: { channel: 'record:list', memory: 'v1' }
      }
    })
    expect(fn).not.toHaveBeenCalled()
    const tagFn = vi.fn()
    const v2Tag = createHandler('tag:create', tagFn, undefined, () => 'v2')
    const refused = await v2Tag({ name: 'x', category: 'custom' })
    expect(refused.ok === false && refused.error.message).toBe(
      'This project uses the other story memory'
    )
    expect(tagFn).not.toHaveBeenCalled()
  })

  it('runs the handler in its own memory, for a channel of both, and with no project open', async () => {
    const fn = vi.fn(() => [])
    expect((await createHandler('record:list', fn, undefined, () => 'v2')(undefined)).ok).toBe(true)
    expect((await createHandler('record:list', fn, undefined, () => null)(undefined)).ok).toBe(true)
    const both = createHandler(
      'app:info',
      async () => ({ version: '1', platform: 'linux' }),
      undefined,
      () => 'v1'
    )
    expect((await both(undefined)).ok).toBe(true)
    expect(fn).toHaveBeenCalledTimes(2)
  })
})
