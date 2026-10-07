import { CloudPricing } from '@shared/aiRouting'
import type { AppStateStore } from '../appState/appStateStore'
import type { FetchLike } from '../ai/providers/openai'

/**
 * The MythScribe Cloud price and routing table (AI-BILLING-SPEC P1, P5, R4): fetched from
 * `GET /pricing` while signed in, cached in app state, and read by the Cloud adapter's price and
 * the request path's Auto table. A failed fetch (offline, or a Worker without the route yet)
 * keeps the cached copy; with none, the bundled table stands in. Never throws: pricing is never
 * worth an error toast.
 */

/** A cached table younger than this is not fetched again unless forced. */
export const CLOUD_PRICING_MAX_AGE_MS = 60 * 60 * 1000
export const CLOUD_PRICING_TIMEOUT_MS = 15_000

export interface CloudPricingServiceOptions {
  /** The Cloud API root, from `cloudApiUrl(process.env)`; a trailing slash is tolerated. */
  baseUrl: string
  fetch: FetchLike
  appState: AppStateStore
  now?: () => number
  timeoutMs?: number
}

export class CloudPricingService {
  private inflight: Promise<CloudPricing | null> | null = null
  private readonly root: string
  private readonly now: () => number
  private readonly timeoutMs: number

  constructor(private readonly options: CloudPricingServiceOptions) {
    this.root = options.baseUrl.replace(/\/+$/, '')
    this.now = options.now ?? Date.now
    this.timeoutMs = options.timeoutMs ?? CLOUD_PRICING_TIMEOUT_MS
  }

  /** The cached table, or null before the first successful fetch. */
  current(): CloudPricing | null {
    return this.options.appState.get().cloudPricing?.pricing ?? null
  }

  /**
   * Fetches the table when the cache is older than `CLOUD_PRICING_MAX_AGE_MS` (or `force`), and
   * answers what is cached afterwards. Concurrent calls share one request.
   */
  refresh(force = false): Promise<CloudPricing | null> {
    const cached = this.options.appState.get().cloudPricing
    const age = cached === null ? Infinity : this.now() - Date.parse(cached.fetchedAt)
    if (!force && age < CLOUD_PRICING_MAX_AGE_MS) return Promise.resolve(cached?.pricing ?? null)
    this.inflight ??= this.fetchOnce().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async fetchOnce(): Promise<CloudPricing | null> {
    const pricing = await this.download()
    if (pricing === null) return this.current()
    const fetchedAt = new Date(this.now()).toISOString()
    this.options.appState.update((s) => ({ ...s, cloudPricing: { fetchedAt, pricing } }))
    return pricing
  }

  private async download(): Promise<CloudPricing | null> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    try {
      const response = await this.options.fetch(`${this.root}/pricing`, {
        method: 'GET',
        signal: controller.signal
      })
      if (!response.ok) return null
      const parsed = CloudPricing.safeParse(JSON.parse(await response.text()))
      if (!parsed.success) {
        console.warn('MythScribe Cloud sent a price table this version cannot read')
        return null
      }
      return parsed.data
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
