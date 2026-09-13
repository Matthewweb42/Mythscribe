import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FEATURE_BUDGETS, inputBudget, priceFor } from '@shared/ai'
import { AppStateStore } from '../appState/appStateStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getCached, type CacheEntry, type CachedResponse } from './cacheStore'
import { dayOf, defaultAiUsageState, type AiUsageState } from './dailyCap'
import {
  AiRateLimitError,
  type CompletionRequest,
  type CompletionResult,
  type Provider
} from './providers/types'
import {
  buildAiRequestDeps,
  cacheKey,
  runAiRequest,
  type AiRequestDeps,
  type AiRequestInput
} from './request'
import { listUsage, type UsageEntry } from './usageStore'

const NOW = new Date(2026, 8, 12, 10, 0, 0)
const TODAY = dayOf(NOW)

const input: AiRequestInput = {
  feature: 'tags',
  tier: 'fast',
  messages: [
    { role: 'system', content: 'Tag the scene.' },
    { role: 'user', content: 'The storm broke at dusk over the dark forest.' }
  ],
  maxTokens: 120,
  json: true,
  contextHash: 'ctx-1'
}

type Complete = (request: CompletionRequest) => Promise<CompletionResult>

interface Fakes {
  deps: AiRequestDeps
  complete: ReturnType<typeof vi.fn<Complete>>
  ledger: UsageEntry[]
  cache: Map<string, CacheEntry>
  day: AiUsageState
  spends: { costUsd: number; tokens: number }[]
  provider: Provider | null
}

function fakes(over: Partial<AiUsageState> = {}): Fakes {
  const complete = vi.fn<Complete>(() =>
    Promise.resolve({
      text: '{"tags":["dark-forest"]}',
      model: 'gpt-5.4-mini-2026-01-01',
      usage: { inputTokens: 40, outputTokens: 10 }
    })
  )
  const f: Fakes = {
    complete,
    ledger: [],
    cache: new Map(),
    day: { ...defaultAiUsageState(), spentDate: TODAY, ...over },
    spends: [],
    provider: {
      id: 'openai',
      resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
      complete,
      stream: async function* () {},
      testConnection: () => Promise.resolve({ model: 'gpt-5.4-mini' })
    },
    deps: {
      providers: { get: () => f.provider },
      ledger: { insert: (entry) => void f.ledger.push(entry) },
      cache: {
        get: (key): CachedResponse | undefined => {
          const hit = f.cache.get(key)
          return hit ? { text: hit.text, usage: hit.usage } : undefined
        },
        put: (entry) => void f.cache.set(entry.key, entry)
      },
      dailyCap: {
        get: () => f.day,
        spend: (amount) => {
          f.spends.push(amount)
          f.day = {
            ...f.day,
            spentTodayUsd: f.day.spentTodayUsd + amount.costUsd,
            requestsToday: f.day.requestsToday + 1,
            tokensToday: f.day.tokensToday + amount.tokens
          }
        }
      },
      now: () => NOW,
      price: priceFor
    }
  }
  return f
}

describe('runAiRequest (F-5.14)', () => {
  it('calls the provider with the clamped cap, prices the real usage, logs, caches, and tallies', async () => {
    const f = fakes()
    const result = await runAiRequest(f.deps, input)
    const expected = priceFor('gpt-5.4-mini', 40, 10)
    expect(result).toEqual({
      text: '{"tags":["dark-forest"]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 40, outputTokens: 10 },
      costUsd: expected.costUsd,
      cached: false,
      priced: true
    })
    expect(f.complete).toHaveBeenCalledWith({
      tier: 'fast',
      messages: input.messages,
      maxTokens: 120,
      json: true
    })
    expect(f.ledger).toEqual([
      {
        feature: 'tags',
        tier: 'fast',
        model: 'gpt-5.4-mini',
        provider: 'openai',
        promptVersion: null,
        contextHash: 'ctx-1',
        at: NOW.toISOString(),
        promptTokens: 40,
        completionTokens: 10,
        cachedTokens: null,
        costUsd: expected.costUsd,
        cached: false
      }
    ])
    expect([...f.cache.values()]).toEqual([
      {
        key: cacheKey(input, 'gpt-5.4-mini'),
        feature: 'tags',
        promptVersion: null,
        model: 'gpt-5.4-mini',
        text: '{"tags":["dark-forest"]}',
        usage: { inputTokens: 40, outputTokens: 10 },
        createdAt: NOW.toISOString()
      }
    ])
    expect(f.spends).toEqual([{ costUsd: expected.costUsd, tokens: 50 }])
  })

  it('forwards the temperature to the provider and leaves it out when absent (F-5.3)', async () => {
    const f = fakes()
    await runAiRequest(f.deps, { ...input, temperature: 0.7 })
    expect(f.complete.mock.calls[0]?.[0].temperature).toBe(0.7)
    await runAiRequest(f.deps, { ...input, contextHash: 'ctx-2' })
    expect('temperature' in (f.complete.mock.calls[1]?.[0] ?? {})).toBe(false)
  })

  it('clamps maxTokens to the feature budget instead of refusing', async () => {
    const f = fakes()
    await runAiRequest(f.deps, { ...input, maxTokens: 10_000 })
    expect(f.complete.mock.calls[0]?.[0].maxTokens).toBe(FEATURE_BUDGETS.tags)
  })

  it('refuses without a provider (no key) and spends nothing', async () => {
    const f = fakes()
    f.provider = null
    await expect(runAiRequest(f.deps, input)).rejects.toMatchObject({ code: 'NO_KEY' })
    expect(f.ledger).toEqual([])
  })

  it('refuses a prompt over the feature input budget with BUDGET before calling anything', async () => {
    const f = fakes()
    const huge = 'x'.repeat((inputBudget('tags') + 1) * 4)
    await expect(
      runAiRequest(f.deps, { ...input, messages: [{ role: 'user', content: huge }] })
    ).rejects.toMatchObject({ code: 'BUDGET', message: /over the tags budget/ })
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.ledger).toEqual([])
    expect(f.cache.size).toBe(0)
    expect(f.spends).toEqual([])
  })

  it('refuses with BUDGET when the estimate would take the day over the cap', async () => {
    const f = fakes({ dailyCapUsd: 1, spentTodayUsd: 1 })
    await expect(runAiRequest(f.deps, input)).rejects.toMatchObject({
      code: 'BUDGET',
      message: /over the 1.00 USD cap/
    })
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.ledger).toEqual([])
    expect(f.spends).toEqual([])
  })

  it('a cap of 0 pauses every priced request for the day', async () => {
    const f = fakes({ dailyCapUsd: 0 })
    await expect(runAiRequest(f.deps, input)).rejects.toMatchObject({ code: 'BUDGET' })
    expect(f.complete).not.toHaveBeenCalled()
  })

  it('answers an identical request from the cache: no provider call, a cached zero-cost row', async () => {
    const f = fakes()
    const first = await runAiRequest(f.deps, input)
    const second = await runAiRequest(f.deps, input)
    expect(f.complete).toHaveBeenCalledTimes(1)
    expect(second).toEqual({ ...first, costUsd: 0, cached: true })
    expect(f.ledger).toHaveLength(2)
    expect(f.ledger[1]).toMatchObject({
      cached: true,
      costUsd: 0,
      promptTokens: 0,
      completionTokens: 0,
      model: 'gpt-5.4-mini'
    })
    expect(f.spends[1]).toEqual({ costUsd: 0, tokens: 0 })
    expect(f.day.requestsToday).toBe(2)
    expect(f.day.spentTodayUsd).toBe(first.costUsd)
  })

  it('misses the cache when the context, the messages, the model, the version, or the mode differ', async () => {
    const f = fakes()
    await runAiRequest(f.deps, input)
    await runAiRequest(f.deps, { ...input, contextHash: 'ctx-2' })
    await runAiRequest(f.deps, { ...input, messages: [{ role: 'user', content: 'Other.' }] })
    await runAiRequest(f.deps, { ...input, tier: 'strong' })
    await runAiRequest(f.deps, { ...input, promptVersion: 'tags.v2' })
    await runAiRequest(f.deps, { ...input, json: false })
    expect(f.complete).toHaveBeenCalledTimes(6)
    expect(f.cache.size).toBe(6)
    expect(f.ledger.filter((r) => r.cached)).toEqual([])
  })

  it('lets a provider error propagate, caching and logging nothing', async () => {
    const f = fakes()
    f.complete.mockRejectedValueOnce(new AiRateLimitError('OpenAI is rate-limiting this key.'))
    await expect(runAiRequest(f.deps, input)).rejects.toMatchObject({ code: 'RATE_LIMIT' })
    expect(f.ledger).toEqual([])
    expect(f.cache.size).toBe(0)
    expect(f.spends).toEqual([])
  })

  it('logs an unknown model at cost 0 and reports it as unpriced', async () => {
    const f = fakes()
    const base = f.provider
    if (!base) throw new Error('expected a provider')
    f.provider = { ...base, resolveModel: () => 'gpt-mystery' }
    const result = await runAiRequest(f.deps, input)
    expect(result).toMatchObject({ model: 'gpt-mystery', costUsd: 0, priced: false })
    expect(f.ledger[0]).toMatchObject({ model: 'gpt-mystery', costUsd: 0 })
    expect(f.spends).toEqual([{ costUsd: 0, tokens: 50 }])
  })

  it('carries the prompt version into the ledger and the cache row', async () => {
    const f = fakes()
    await runAiRequest(f.deps, { ...input, promptVersion: 'tags.v1' })
    expect(f.ledger[0]?.promptVersion).toBe('tags.v1')
    expect([...f.cache.values()][0]?.promptVersion).toBe('tags.v1')
  })
})

describe('cacheKey', () => {
  it('is a stable sha256 hex over the feature, version, model, context, messages, and mode', () => {
    const key = cacheKey(input, 'gpt-5.4-mini')
    expect(key).toMatch(/^[0-9a-f]{64}$/)
    expect(cacheKey({ ...input }, 'gpt-5.4-mini')).toBe(key)
    expect(cacheKey(input, 'gpt-5.4')).not.toBe(key)
    expect(cacheKey({ ...input, feature: 'summary' }, 'gpt-5.4-mini')).not.toBe(key)
  })
})

describe('buildAiRequestDeps (the production binding)', () => {
  let tmp: string
  let session: ProjectSession
  let appState: AppStateStore

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-request-'))
    session = createProject(projectFolderFor(tmp, 'Req'), 'Req', 'novel')
    appState = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
  })
  afterEach(() => {
    session.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('writes the ledger row and the cache row to the project and the tally to app state', async () => {
    const f = fakes()
    const deps = buildAiRequestDeps({
      db: session.connection.orm,
      providers: { get: () => f.provider },
      appState,
      now: () => NOW
    })
    const result = await runAiRequest(deps, input)
    expect(listUsage(session.connection.orm)).toHaveLength(1)
    expect(listUsage(session.connection.orm)[0]).toMatchObject({
      feature: 'tags',
      model: 'gpt-5.4-mini',
      costUsd: result.costUsd,
      cached: false
    })
    expect(getCached(session.connection.orm, cacheKey(input, 'gpt-5.4-mini'))).toEqual({
      text: result.text,
      usage: result.usage
    })
    expect(appState.get().aiUsage).toEqual({
      dailyCapUsd: 2,
      spentDate: TODAY,
      spentTodayUsd: result.costUsd,
      requestsToday: 1,
      tokensToday: 50
    })
    // The second run hits the cache in the real store and adds a free request to the day.
    await runAiRequest(deps, input)
    expect(f.complete).toHaveBeenCalledTimes(1)
    expect(listUsage(session.connection.orm).map((r) => r.cached)).toEqual([false, true])
    expect(appState.get().aiUsage.requestsToday).toBe(2)
  })

  it('rolls the tally to a new day before checking the cap', async () => {
    const f = fakes()
    appState.update((s) => ({
      ...s,
      aiUsage: { ...s.aiUsage, dailyCapUsd: 1, spentDate: 'yesterday', spentTodayUsd: 1 }
    }))
    const deps = buildAiRequestDeps({
      db: session.connection.orm,
      providers: { get: () => f.provider },
      appState,
      now: () => NOW
    })
    await expect(runAiRequest(deps, input)).resolves.toMatchObject({ cached: false })
    expect(appState.get().aiUsage).toMatchObject({ spentDate: TODAY, requestsToday: 1 })
  })
})
