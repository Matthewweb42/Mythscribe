import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppStateStore } from '../appState/appStateStore'
import type { FetchLike } from '../ai/providers/openai'
import { CLOUD_PRICING_MAX_AGE_MS, CloudPricingService } from './cloudPricing'

const TABLE = {
  markup: 0.2,
  models: [{ model: 'openai/gpt-5.4-mini', inUsdPerM: 0.75, outUsdPerM: 4.5 }],
  routing: { summary: 'fast' },
  aFieldFromANewerWorker: true
}

let tmp: string
let appState: AppStateStore
let now: number

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-pricing-'))
  appState = new AppStateStore(path.join(tmp, 'app-state.json'))
  now = Date.UTC(2026, 9, 7, 12)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const service = (fetch: FetchLike): CloudPricingService =>
  new CloudPricingService({
    baseUrl: 'https://api.example.test/',
    fetch,
    appState,
    now: () => now
  })

describe('CloudPricingService (AI-BILLING-SPEC P5)', () => {
  it('fetches GET /pricing, caches the table in app state, and answers it', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(JSON.stringify(TABLE))))
    const pricing = service(fetch)
    expect(pricing.current()).toBeNull()
    const table = await pricing.refresh()
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/pricing', expect.anything())
    expect(table).toMatchObject({ markup: 0.2, routing: { summary: 'fast' } })
    expect(pricing.current()).toEqual(table)
    expect(new AppStateStore(path.join(tmp, 'app-state.json')).get().cloudPricing).toEqual({
      fetchedAt: new Date(now).toISOString(),
      pricing: table
    })
  })

  it('does not fetch again while the cache is fresh, and does once it is old or forced', async () => {
    const fetch = vi.fn<FetchLike>(() => Promise.resolve(new Response(JSON.stringify(TABLE))))
    const pricing = service(fetch)
    await pricing.refresh()
    await pricing.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
    await pricing.refresh(true)
    expect(fetch).toHaveBeenCalledTimes(2)
    now += CLOUD_PRICING_MAX_AGE_MS + 1
    await pricing.refresh()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('shares one request between concurrent refreshes', async () => {
    let answer: (response: Response) => void = () => {}
    const fetch = vi.fn<FetchLike>(
      () =>
        new Promise<Response>((resolve) => {
          answer = resolve
        })
    )
    const pricing = service(fetch)
    const both = Promise.all([pricing.refresh(), pricing.refresh()])
    answer(new Response(JSON.stringify(TABLE)))
    const [first, second] = await both
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(first).toEqual(second)
  })

  it('keeps the cached table when the Worker has no route, is unreachable, or sends junk', async () => {
    await service(() => Promise.resolve(new Response(JSON.stringify(TABLE)))).refresh()
    const cached = appState.get().cloudPricing
    for (const fetch of [
      () => Promise.resolve(new Response('{"code":"NOT_FOUND"}', { status: 404 })),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(new Response('{"markup":"lots"}'))
    ] satisfies FetchLike[]) {
      await expect(service(fetch).refresh(true)).resolves.toEqual(cached?.pricing)
      expect(appState.get().cloudPricing).toEqual(cached)
    }
  })

  it('answers null with nothing cached and nothing fetched', async () => {
    await expect(
      service(() => Promise.reject(new TypeError('offline'))).refresh()
    ).resolves.toBeNull()
  })
})
