import {
  OPENROUTER_BASE_URL,
  type AiModels,
  type LocalAiSettings,
  type OwnKeyProvider,
  type Tier
} from '@shared/ai'
import type { AiSource } from '@shared/aiSettings'
import type { AiKeyStore } from './keyStore'
import { buildOpenAiProvider } from './providers/openai'
import type { Provider } from './providers/types'

/**
 * How a provider is constructed for a key and the provider it is for (2026-10-07: OpenRouter or
 * OpenAI); `resolveModel` is live, so it is not part of the cache key.
 */
export type BuildProvider = (
  key: string,
  resolveModel: (tier: Tier) => string,
  provider: OwnKeyProvider
) => Provider

/**
 * The own-key adapter: the OpenAI adapter, pointed at OpenRouter's OpenAI-compatible API for an
 * OpenRouter key (AI-BILLING-SPEC A2), or at OpenAI itself.
 */
export const buildOwnKeyProvider: BuildProvider = (key, resolveModel, provider) =>
  provider === 'openrouter'
    ? buildOpenAiProvider(key, {
        resolveModel,
        baseURL: OPENROUTER_BASE_URL,
        id: 'openrouter',
        label: 'OpenRouter',
        openRouter: true
      })
    : buildOpenAiProvider(key, { resolveModel })
/** F-5.15: how the local provider is constructed for a server address. */
export type BuildLocalProvider = (baseUrl: string, resolveModel: (tier: Tier) => string) => Provider

/**
 * The local adapter (F-5.15): the OpenAI adapter pointed at an OpenAI-compatible server on this
 * computer. Ollama and LM Studio need no key, but the SDK insists on one, so a placeholder goes.
 * Every request is free, whatever name the server gives its model, so a local model called
 * like an OpenAI one is never priced as one.
 */
export const buildLocalProvider: BuildLocalProvider = (baseUrl, resolveModel) => ({
  ...buildOpenAiProvider('local', {
    baseURL: baseUrl,
    resolveModel,
    id: 'local',
    label: `the local model server at ${baseUrl}`
  }),
  price: () => ({ costUsd: 0, priced: true })
})

/**
 * Where the live provider instance lives (F-5.1). `get(source)` answers the provider the
 * project's `source` setting names (F-15.4): the author's own key (for OpenRouter or OpenAI,
 * whichever `ownKey` names), the MythScribe Cloud adapter, or the local server. The key path reads the key through the store on every call and rebuilds the client
 * only when the decrypted key changed, so `setKey` and `clearKey` need no invalidation hook; the
 * Cloud adapter is built once and reads the session live, so it never needs rebuilding. The
 * tier → model mapping (F-5.11) is read through the `models` accessor on every request, inside
 * the closure handed to the provider, so a change applies to the next request with no rebuild.
 * `build` is injectable so tests and later adapters can swap the construction without touching
 * the callers.
 */
export class AiProviderRegistry {
  private cached: { key: string; owner: OwnKeyProvider; provider: Provider } | null = null
  private cloudProvider: Provider | null = null
  private localCached: { baseUrl: string; provider: Provider } | null = null

  constructor(
    private readonly keyStore: AiKeyStore,
    private readonly models: () => AiModels,
    private readonly build: BuildProvider = buildOwnKeyProvider,
    /** F-15.4: builds the Cloud adapter on first use; null in a build with no Cloud wiring. */
    private readonly cloud: (() => Provider) | null = null,
    /** F-5.15: the local server's settings, read live; null in a build with no local wiring. */
    private readonly local: (() => LocalAiSettings) | null = null,
    private readonly buildLocal: BuildLocalProvider = buildLocalProvider,
    /** Which provider the own key is for, read live (`effectiveOwnKeyProvider`). */
    private readonly ownKey: () => OwnKeyProvider = () => 'openai'
  ) {}

  /**
   * Which provider an own key is for right now (OpenRouter or OpenAI). The one owner: the key
   * channels store and clear the key of the provider this answers.
   */
  ownKeyProvider(): OwnKeyProvider {
    return this.ownKey()
  }

  /**
   * The provider for `source`, or null when there is none to use (no key, or no Cloud or local
   * wiring). The local provider is rebuilt only when the server address changes.
   */
  get(source: AiSource = 'ownKey'): Provider | null {
    if (source === 'local') {
      if (this.local === null) return null
      const { baseUrl } = this.local()
      if (this.localCached?.baseUrl !== baseUrl) {
        const provider = this.buildLocal(baseUrl, (tier) => this.models().local[tier])
        this.localCached = { baseUrl, provider }
      }
      return this.localCached.provider
    }
    if (source === 'cloud') {
      if (this.cloud === null) return null
      this.cloudProvider ??= this.cloud()
      return this.cloudProvider
    }
    const owner = this.ownKeyProvider()
    const key = this.keyStore.getKey(owner)
    if (key === null) {
      this.cached = null
      return null
    }
    if (this.cached?.key !== key || this.cached.owner !== owner) {
      const provider = this.build(key, (tier) => this.models()[owner][tier], owner)
      this.cached = { key, owner, provider }
    }
    return this.cached.provider
  }
}
