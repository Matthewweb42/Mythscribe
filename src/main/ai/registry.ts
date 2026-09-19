import type { AiModels, Tier } from '@shared/ai'
import type { AiSource } from '@shared/aiSettings'
import type { AiKeyStore } from './keyStore'
import { buildOpenAiProvider } from './providers/openai'
import type { Provider } from './providers/types'

/** How a provider is constructed for a key; `resolveModel` is live, so it is not part of the cache key. */
export type BuildProvider = (key: string, resolveModel: (tier: Tier) => string) => Provider

/**
 * Where the live provider instance lives (F-5.1). `get(source)` answers the provider the
 * project's `source` setting names (F-15.4): the author's own key, or the MythScribe Cloud
 * adapter. The key path reads the key through the store on every call and rebuilds the client
 * only when the decrypted key changed, so `setKey` and `clearKey` need no invalidation hook; the
 * Cloud adapter is built once and reads the session live, so it never needs rebuilding. The
 * tier → model mapping (F-5.11) is read through the `models` accessor on every request, inside
 * the closure handed to the provider, so a change applies to the next request with no rebuild.
 * `build` is injectable so tests and later adapters can swap the construction without touching
 * the callers.
 */
export class AiProviderRegistry {
  private cached: { key: string; provider: Provider } | null = null
  private cloudProvider: Provider | null = null

  constructor(
    private readonly keyStore: AiKeyStore,
    private readonly models: () => AiModels,
    private readonly build: BuildProvider = (key, resolveModel) =>
      buildOpenAiProvider(key, { resolveModel }),
    /** F-15.4: builds the Cloud adapter on first use; null in a build with no Cloud wiring. */
    private readonly cloud: (() => Provider) | null = null
  ) {}

  /** The provider for `source`, or null when there is none to use (no key, or no Cloud adapter). */
  get(source: AiSource = 'ownKey'): Provider | null {
    if (source === 'cloud') {
      if (this.cloud === null) return null
      this.cloudProvider ??= this.cloud()
      return this.cloudProvider
    }
    const key = this.keyStore.getKey('openai')
    if (key === null) {
      this.cached = null
      return null
    }
    if (this.cached?.key !== key) {
      const provider = this.build(key, (tier) => this.models().openai[tier])
      this.cached = { key, provider }
    }
    return this.cached.provider
  }
}
