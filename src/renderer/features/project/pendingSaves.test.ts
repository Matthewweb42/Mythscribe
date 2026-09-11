import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPendingSaves, registerPendingSave, resetPendingSaves } from './pendingSaves'

beforeEach(() => {
  resetPendingSaves()
})

describe('pendingSaves', () => {
  it('resolves with no flushers registered', async () => {
    await expect(flushPendingSaves()).resolves.toBeUndefined()
  })

  it('does not call a flusher after it unsubscribes', async () => {
    const flush = vi.fn(async () => {})
    const unsubscribe = registerPendingSave(flush)
    unsubscribe()
    await flushPendingSaves()
    expect(flush).not.toHaveBeenCalled()
  })

  it('runs every flusher even when one rejects, then rethrows the first reason', async () => {
    const failing = vi.fn(async () => {
      throw new Error('disk full')
    })
    const ok = vi.fn(async () => {})
    registerPendingSave(failing)
    registerPendingSave(ok)
    await expect(flushPendingSaves()).rejects.toThrow('disk full')
    expect(failing).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(1)
  })
})
