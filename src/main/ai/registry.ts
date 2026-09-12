import type { AiKeyStore } from './keyStore'
import { buildOpenAiProvider } from './providers/openai'
import type { Provider } from './providers/types'

/**
 * Where the live provider instance lives (F-5.1). `get()` reads the key through the store on
 * every call and rebuilds the client only when the decrypted key changed, so `setKey` and
 * `clearKey` need no invalidation hook. `build` is injectable so tests and later adapters
 * (Cloud, F-15.1) can swap the construction without touching the callers.
 */
export class AiProviderRegistry {
  private cached: { key: string; provider: Provider } | null = null

  constructor(
    private readonly keyStore: AiKeyStore,
    private readonly build: (key: string) => Provider = (key) => buildOpenAiProvider(key)
  ) {}

  /** The provider for the saved key, or null when there is no usable key. */
  get(): Provider | null {
    const key = this.keyStore.getKey('openai')
    if (key === null) {
      this.cached = null
      return null
    }
    if (this.cached?.key !== key) this.cached = { key, provider: this.build(key) }
    return this.cached.provider
  }
}
