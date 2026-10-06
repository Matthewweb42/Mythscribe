import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultAiModels, type AiModels, type Tier } from '@shared/ai'
import { AiKeyStore } from './keyStore'
import { fakeSafeStorage } from './keyStoreFixture'
import type { Provider } from './providers/types'
import { AiProviderRegistry, buildLocalProvider, type BuildProvider } from './registry'

/** A provider whose `testConnection` answers with what `resolveModel` says for the fast tier. */
function fakeProvider(key: string, resolveModel: (tier: Tier) => string): Provider {
  return {
    id: 'openai',
    resolveModel,
    complete: (request) =>
      Promise.resolve({
        text: key,
        model: resolveModel(request.tier),
        usage: { inputTokens: 0, outputTokens: 0 }
      }),
    stream: async function* () {},
    testConnection: () => Promise.resolve({ model: resolveModel('fast') })
  }
}

let tmp: string
let keyStore: AiKeyStore
let models: AiModels
let build: ReturnType<typeof vi.fn<BuildProvider>>
let registry: AiProviderRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-registry-'))
  keyStore = new AiKeyStore(path.join(tmp, 'ai-keys.json'), fakeSafeStorage())
  models = defaultAiModels()
  build = vi.fn<BuildProvider>(fakeProvider)
  registry = new AiProviderRegistry(keyStore, () => models, build)
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
    expect(build).toHaveBeenCalledWith('sk-first-key-1234abcd', expect.any(Function))
  })

  it('rebuilds after the key changes and drops the provider after a clear', () => {
    keyStore.setKey('openai', 'sk-first-key-1234abcd')
    const first = registry.get()
    keyStore.setKey('openai', 'sk-second-key-9999wxyz')
    const second = registry.get()
    expect(second).not.toBe(first)
    expect(build).toHaveBeenLastCalledWith('sk-second-key-9999wxyz', expect.any(Function))
    keyStore.clearKey('openai')
    expect(registry.get()).toBeNull()
    // Saving the same key again builds a fresh client; the old one was dropped with the key.
    keyStore.setKey('openai', 'sk-second-key-9999wxyz')
    expect(registry.get()).not.toBe(second)
    expect(build).toHaveBeenCalledTimes(3)
  })

  it('resolves the model live from the accessor, so a change applies without a rebuild (F-5.11)', async () => {
    keyStore.setKey('openai', 'sk-first-key-1234abcd')
    const provider = registry.get()
    if (!provider) throw new Error('expected a provider')
    await expect(provider.testConnection()).resolves.toEqual({ model: 'gpt-5.4-mini' })
    models = { ...models, openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4-pro' } }
    await expect(provider.testConnection()).resolves.toEqual({ model: 'gpt-5.4-nano' })
    const request = { tier: 'strong' as const, messages: [], maxTokens: 1 }
    await expect(provider.complete(request)).resolves.toMatchObject({ model: 'gpt-5.4-pro' })
    expect(provider.resolveModel('strong')).toBe('gpt-5.4-pro')
    expect(registry.get()).toBe(provider)
    expect(build).toHaveBeenCalledTimes(1)
  })
})

describe('AiProviderRegistry with a Cloud source (F-15.4)', () => {
  it('answers the Cloud provider whatever the key is, and builds it once', () => {
    const buildCloud = vi.fn<() => Provider>(() =>
      fakeProvider('cloud', (tier) => models.cloud[tier])
    )
    const withCloud = new AiProviderRegistry(keyStore, () => models, build, buildCloud)
    const provider = withCloud.get('cloud')
    expect(provider).not.toBeNull()
    expect(withCloud.get('cloud')).toBe(provider)
    expect(buildCloud).toHaveBeenCalledOnce()
    expect(build).not.toHaveBeenCalled()
    // The key path is untouched by the Cloud one.
    expect(withCloud.get('ownKey')).toBeNull()
    keyStore.setKey('openai', 'sk-first-key-1234abcd')
    expect(withCloud.get('ownKey')).not.toBe(provider)
    expect(withCloud.get()).not.toBe(provider)
    expect(withCloud.get('cloud')).toBe(provider)
  })

  it('has no Cloud provider when none was wired in', () => {
    expect(registry.get('cloud')).toBeNull()
  })
})

describe('the local provider (F-5.15)', () => {
  it('is null without local wiring, builds for the address, and rebuilds only when it changes', () => {
    expect(registry.get('local')).toBeNull()
    let baseUrl = 'http://localhost:11434/v1'
    const buildLocal = vi.fn((_url: string, resolveModel: (tier: Tier) => string) =>
      fakeProvider('local', resolveModel)
    )
    const withLocal = new AiProviderRegistry(
      keyStore,
      () => models,
      build,
      null,
      () => ({ baseUrl }),
      buildLocal
    )
    const first = withLocal.get('local')
    expect(withLocal.get('local')).toBe(first)
    expect(buildLocal).toHaveBeenCalledWith('http://localhost:11434/v1', expect.any(Function))
    // The local map, read live: no key is needed and none is read.
    models = { ...models, local: { fast: 'qwen2.5', strong: 'llama3.1:70b' } }
    expect(first?.resolveModel('strong')).toBe('llama3.1:70b')
    baseUrl = 'http://localhost:1234/v1'
    expect(withLocal.get('local')).not.toBe(first)
    expect(buildLocal).toHaveBeenCalledTimes(2)
    expect(build).not.toHaveBeenCalled()
  })

  it('prices every local request at zero, even for a model named like an OpenAI one', () => {
    const provider = buildLocalProvider('http://localhost:11434/v1', () => 'gpt-5.4')
    expect(provider.id).toBe('local')
    expect(provider.price?.('gpt-5.4', 10_000, 2_000)).toEqual({ costUsd: 0, priced: true })
  })
})
