import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AiKeyStore } from './keyStore'
import { fakeSafeStorage } from './keyStoreFixture'
import type { Provider } from './providers/types'
import { AiProviderRegistry } from './registry'

function fakeProvider(key: string): Provider {
  return {
    id: 'openai',
    complete: () =>
      Promise.resolve({ text: key, model: 'fake', usage: { inputTokens: 0, outputTokens: 0 } }),
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: 'fake' })
  }
}

let tmp: string
let keyStore: AiKeyStore
let build: ReturnType<typeof vi.fn<(key: string) => Provider>>
let registry: AiProviderRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-registry-'))
  keyStore = new AiKeyStore(path.join(tmp, 'ai-keys.json'), fakeSafeStorage())
  build = vi.fn<(key: string) => Provider>(fakeProvider)
  registry = new AiProviderRegistry(keyStore, build)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AiProviderRegistry (F-5.1)', () => {
  it('has no provider without a key and builds nothing', () => {
    expect(registry.get()).toBeNull()
    expect(build).not.toHaveBeenCalled()
  })

  it('builds once per key and reuses the instance', () => {
    keyStore.setKey('openai', 'sk-first-key-1234abcd')
    const first = registry.get()
    expect(first).not.toBeNull()
    expect(registry.get()).toBe(first)
    expect(build).toHaveBeenCalledTimes(1)
    expect(build).toHaveBeenCalledWith('sk-first-key-1234abcd')
  })

  it('rebuilds after the key changes and drops the provider after a clear', () => {
    keyStore.setKey('openai', 'sk-first-key-1234abcd')
    const first = registry.get()
    keyStore.setKey('openai', 'sk-second-key-9999wxyz')
    const second = registry.get()
    expect(second).not.toBe(first)
    expect(build).toHaveBeenLastCalledWith('sk-second-key-9999wxyz')
    keyStore.clearKey('openai')
    expect(registry.get()).toBeNull()
    // Saving the same key again builds a fresh client; the old one was dropped with the key.
    keyStore.setKey('openai', 'sk-second-key-9999wxyz')
    expect(registry.get()).not.toBe(second)
    expect(build).toHaveBeenCalledTimes(3)
  })
})
