import type { AiModels, Tier } from '@shared/ai'
import type { AiKeyStore } from './keyStore'
import { buildOpenAiProvider } from './providers/openai'
import type { Provider } from './providers/types'

/** How a provider is constructed for a key; `resolveModel` is live, so it is not part of the cache key. */
export type BuildProvider = (key: string, resolveModel: (tier: Tier) => string) => Provider

/**
 * Where the live provider instance lives (F-5.1). `get()` reads the key through the store on
 * every call and rebuilds the client only when the decrypted key changed, so `setKey` and
 * `clearKey` need no invalidation hook. The tier → model mapping (F-5.11) is read through the
 * `models` accessor on every request, inside the closure handed to the provider, so a change
 * applies to the next request with no rebuild. `build` is injectable so tests and later
 * adapters (Cloud, F-15.1) can swap the construction without touching the callers.
 */
export class AiProviderRegistry {
  private cached: { key: string; provider: Provider } | null = null

  constructor(
    private readonly keyStore: AiKeyStore,
    private readonly models: () => AiModels,
    private readonly build: BuildProvider = (key, resolveModel) =>
      buildOpenAiProvider(key, { resolveModel })
  ) {}

  /** The provider for the saved key, or null when there is no usable key. */
  get(): Provider | null {
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
