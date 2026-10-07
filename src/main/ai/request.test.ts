import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { estimateTokens, FEATURE_BUDGETS, inputBudget, priceFor } from '@shared/ai'
import { autoTable, defaultAiRouting } from '@shared/aiRouting'
import { bundledPricing } from '@shared/hostedPricing'
import { AppStateStore } from '../appState/appStateStore'
import { createProject, projectFolderFor, type ProjectSession } from '../project/projectStore'
import { getCached, type CacheEntry, type CachedResponse } from './cacheStore'
import { dayOf, defaultAiUsageState, type AiUsageState } from './dailyCap'
import { cancelInflight, inflightCount, resetInflight } from './inflight'
import {
  AiCancelledError,
  AiRateLimitError,
  NoKeyError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type StreamChunk
} from './providers/types'
import {
  buildAiRequestDeps,
  cacheKey,
  runAiRequest,
  runAiStream,
  type AiRequestDeps,
  type AiRequestInput,
  type AiRequestObserver,
  type AiRequestTrace
} from './request'
import { createSessionUsage, type SessionUsage } from './sessionUsage'
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
  contextHash: 'ctx-1',
  promptVersion: 'tags.v1'
}

type Complete = (request: CompletionRequest) => Promise<CompletionResult>

interface Fakes {
  deps: AiRequestDeps
  complete: ReturnType<typeof vi.fn<Complete>>
  ledger: UsageEntry[]
  cache: Map<string, CacheEntry>
  day: AiUsageState
  spends: { costUsd: number; tokens: number }[]
  /** The session tally the deps spend against (F-5.9). */
  session: SessionUsage
  provider: Provider | null
  /** What `stream` yields, in order; a thrown value in the list is thrown from that pull. */
  chunks: (StreamChunk | Error)[]
  stream: ReturnType<typeof vi.fn<(request: CompletionRequest) => AsyncIterable<StreamChunk>>>
}

function fakes(over: Partial<AiUsageState> = {}): Fakes {
  const complete = vi.fn<Complete>(() =>
    Promise.resolve({
      text: '{"tags":["dark-forest"]}',
      model: 'gpt-5.4-mini-2026-01-01',
      usage: { inputTokens: 40, outputTokens: 10 }
    })
  )
  const stream = vi.fn<(request: CompletionRequest) => AsyncIterable<StreamChunk>>(
    async function* () {
      for (const chunk of f.chunks) {
        if (chunk instanceof Error) throw chunk
        yield chunk
      }
    }
  )
  const f: Fakes = {
    complete,
    ledger: [],
    cache: new Map(),
    day: { ...defaultAiUsageState(), spentDate: TODAY, ...over },
    spends: [],
    session: createSessionUsage(),
    chunks: [{ delta: '{"tags":' }, { delta: '["dark-forest"]}' }],
    stream,
    provider: {
      id: 'openai',
      resolveModel: (tier) => (tier === 'fast' ? 'gpt-5.4-mini' : 'gpt-5.4'),
      complete,
      stream,
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
      session: { spend: (amount) => f.session.spend(amount) },
      now: () => NOW,
      price: priceFor
    }
  }
  return f
}

beforeEach(() => resetInflight())

/** Settles like the adapter once its `signal` aborts: rejects with CANCELLED. */
const untilCancelled = (request: CompletionRequest): Promise<never> =>
  new Promise((_, reject) => {
    request.signal?.addEventListener(
      'abort',
      () => reject(new AiCancelledError('The request was stopped.')),
      { once: true }
    )
  })

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
      // F-15.4: the Cloud proxy meters per feature, so every request names one.
      feature: 'tags',
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
        promptVersion: 'tags.v1',
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
        promptVersion: 'tags.v1',
        model: 'gpt-5.4-mini',
        text: '{"tags":["dark-forest"]}',
        usage: { inputTokens: 40, outputTokens: 10 },
        createdAt: NOW.toISOString()
      }
    ])
    expect(f.spends).toEqual([{ costUsd: expected.costUsd, tokens: 50 }])
    expect(f.session.totals()).toEqual({ requests: 1, tokens: 50, costUsd: expected.costUsd })
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
    // The session counts the cache hit as a free request, exactly as the day does (F-5.9).
    expect(f.session.totals()).toEqual({ requests: 2, tokens: 50, costUsd: first.costUsd })
  })

  it('misses the cache when the context, the messages, the model, the version, or the mode differ', async () => {
    const f = fakes()
    await runAiRequest(f.deps, input)
    await runAiRequest(f.deps, { ...input, contextHash: 'ctx-2' })
    await runAiRequest(f.deps, { ...input, messages: [{ role: 'user', content: 'Other.' }] })
    await runAiRequest(f.deps, { ...input, tier: 'strong' })
    await runAiRequest(f.deps, { ...input, promptVersion: 'tagsRegen.v1' })
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
    expect(f.session.totals()).toEqual({ requests: 0, tokens: 0, costUsd: 0 })
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
    await runAiRequest(f.deps, { ...input, promptVersion: 'tagsRegen.v1' })
    expect(f.ledger[0]?.promptVersion).toBe('tagsRegen.v1')
    expect([...f.cache.values()][0]?.promptVersion).toBe('tagsRegen.v1')
  })
})

describe('runAiStream (F-5.4)', () => {
  const deltas = (): { seen: string[]; onDelta: (delta: string) => void } => {
    const seen: string[] = []
    return { seen, onDelta: (delta) => void seen.push(delta) }
  }

  it('hands every delta over as it arrives, then prices the final chunk usage, logs, caches, and tallies like runAiRequest', async () => {
    const f = fakes()
    f.chunks.push({ delta: '', usage: { inputTokens: 40, outputTokens: 10 } })
    const { seen, onDelta } = deltas()
    const result = await runAiStream(f.deps, input, onDelta)
    expect(seen).toEqual(['{"tags":', '["dark-forest"]}'])
    expect(result).toEqual({
      text: '{"tags":["dark-forest"]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 40, outputTokens: 10 },
      costUsd: priceFor('gpt-5.4-mini', 40, 10).costUsd,
      cached: false,
      priced: true
    })
    expect(f.stream).toHaveBeenCalledWith({
      tier: 'fast',
      // F-15.4: the Cloud proxy meters per feature, so every request names one.
      feature: 'tags',
      messages: input.messages,
      maxTokens: 120,
      json: true
    })
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.ledger).toHaveLength(1)
    expect(f.ledger[0]).toMatchObject({
      feature: 'tags',
      promptVersion: 'tags.v1',
      promptTokens: 40,
      completionTokens: 10,
      cached: false
    })
    expect([...f.cache.values()][0]).toMatchObject({
      key: cacheKey(input, 'gpt-5.4-mini'),
      text: '{"tags":["dark-forest"]}',
      usage: { inputTokens: 40, outputTokens: 10 }
    })
    expect(f.spends).toEqual([{ costUsd: result.costUsd, tokens: 50 }])
  })

  it('falls back to the local estimate when the stream carries no usage', async () => {
    const f = fakes()
    const result = await runAiStream(f.deps, input, () => {})
    const prompt = input.messages.map((m) => m.content).join('\n')
    expect(result.usage).toEqual({
      inputTokens: estimateTokens(prompt),
      outputTokens: estimateTokens('{"tags":["dark-forest"]}')
    })
    expect(f.ledger[0]).toMatchObject({
      promptTokens: result.usage.inputTokens,
      completionTokens: result.usage.outputTokens
    })
  })

  it('answers a cache hit as one delta with the stored text and a cached zero-cost row', async () => {
    const f = fakes()
    await runAiRequest(f.deps, input)
    const { seen, onDelta } = deltas()
    const second = await runAiStream(f.deps, input, onDelta)
    expect(f.stream).not.toHaveBeenCalled()
    expect(seen).toEqual(['{"tags":["dark-forest"]}'])
    expect(second).toMatchObject({ text: '{"tags":["dark-forest"]}', cached: true, costUsd: 0 })
    expect(f.ledger[1]).toMatchObject({ cached: true, costUsd: 0 })
    expect(f.spends[1]).toEqual({ costUsd: 0, tokens: 0 })
  })

  it('lets a mid-stream provider error propagate after the deltas already shown, caching and logging nothing', async () => {
    const f = fakes()
    f.chunks = [{ delta: 'Half' }, new AiRateLimitError('OpenAI is rate-limiting this key.')]
    const { seen, onDelta } = deltas()
    await expect(runAiStream(f.deps, input, onDelta)).rejects.toMatchObject({
      code: 'RATE_LIMIT'
    })
    expect(seen).toEqual(['Half'])
    expect(f.ledger).toEqual([])
    expect(f.cache.size).toBe(0)
    expect(f.spends).toEqual([])
  })

  it('shares the pre-checks: no key, the input budget, and the daily cap refuse before pulling', async () => {
    const noKey = fakes()
    noKey.provider = null
    await expect(runAiStream(noKey.deps, input, () => {})).rejects.toMatchObject({
      code: 'NO_KEY'
    })
    const over = fakes()
    const huge = 'x'.repeat((inputBudget('tags') + 1) * 4)
    await expect(
      runAiStream(over.deps, { ...input, messages: [{ role: 'user', content: huge }] }, () => {})
    ).rejects.toMatchObject({ code: 'BUDGET' })
    const capped = fakes({ dailyCapUsd: 0 })
    await expect(runAiStream(capped.deps, input, () => {})).rejects.toMatchObject({
      code: 'BUDGET'
    })
    for (const f of [over, capped]) {
      expect(f.stream).not.toHaveBeenCalled()
      expect(f.ledger).toEqual([])
    }
  })
})

describe('cancel (F-5.10)', () => {
  it('hands the registered signal to the provider under the requestId and releases it after the answer', async () => {
    const f = fakes()
    f.complete.mockImplementationOnce(async (request) => {
      expect(request.signal).toBeInstanceOf(AbortSignal)
      expect(request.signal?.aborted).toBe(false)
      expect(inflightCount()).toBe(1)
      return { text: 'ok', model: 'gpt-5.4-mini', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    await runAiRequest(f.deps, { ...input, requestId: 'req-1' })
    expect(f.complete).toHaveBeenCalledTimes(1)
    expect(inflightCount()).toBe(0)
    expect(cancelInflight('req-1')).toBe(false)
  })

  it('a cancel mid-flight rejects runAiRequest with CANCELLED, logging, caching, and spending nothing', async () => {
    const f = fakes()
    f.complete.mockImplementationOnce(untilCancelled)
    const pending = runAiRequest(f.deps, { ...input, requestId: 'req-1' })
    expect(cancelInflight('req-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(f.ledger).toEqual([])
    expect(f.cache.size).toBe(0)
    expect(f.spends).toEqual([])
    expect(inflightCount()).toBe(0)
  })

  it('a cancel mid-stream rejects runAiStream after the deltas already shown, recording nothing', async () => {
    const f = fakes()
    f.stream.mockImplementationOnce(async function* (request) {
      yield { delta: 'Half' }
      await untilCancelled(request)
    })
    const seen: string[] = []
    const pending = runAiStream(f.deps, { ...input, requestId: 'req-1' }, (d) => void seen.push(d))
    await new Promise((r) => setTimeout(r, 0))
    expect(f.stream.mock.calls[0]?.[0].signal).toBeInstanceOf(AbortSignal)
    expect(cancelInflight('req-1')).toBe(true)
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(seen).toEqual(['Half'])
    expect(f.ledger).toEqual([])
    expect(f.cache.size).toBe(0)
    expect(inflightCount()).toBe(0)
  })

  it('refuses a duplicate requestId with VALIDATION while the first is in flight, and the first still answers', async () => {
    const f = fakes()
    let answer: (() => void) | undefined
    f.complete.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          answer = (): void =>
            resolve({
              text: 'ok',
              model: 'gpt-5.4-mini',
              usage: { inputTokens: 1, outputTokens: 1 }
            })
        })
    )
    const first = runAiRequest(f.deps, { ...input, requestId: 'req-1' })
    await expect(
      runAiRequest(f.deps, { ...input, contextHash: 'ctx-2', requestId: 'req-1' })
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(inflightCount()).toBe(1)
    if (!answer) throw new Error('the provider was not called')
    answer()
    await expect(first).resolves.toMatchObject({ text: 'ok' })
    expect(f.complete).toHaveBeenCalledTimes(1)
    expect(inflightCount()).toBe(0)
  })

  it('registers and releases around a cache hit and a budget refusal too, so cancel is never left dangling', async () => {
    const f = fakes()
    await runAiRequest(f.deps, input)
    await expect(runAiRequest(f.deps, { ...input, requestId: 'hit' })).resolves.toMatchObject({
      cached: true
    })
    expect(inflightCount()).toBe(0)
    const capped = fakes({ dailyCapUsd: 0 })
    await expect(
      runAiRequest(capped.deps, { ...input, requestId: 'refused' })
    ).rejects.toMatchObject({ code: 'BUDGET' })
    await expect(
      runAiStream(capped.deps, { ...input, requestId: 'refused' }, () => {})
    ).rejects.toMatchObject({ code: 'BUDGET' })
    expect(inflightCount()).toBe(0)
    expect(cancelInflight('refused')).toBe(false)
  })

  it('sends no signal at all without a requestId', async () => {
    const f = fakes()
    await runAiRequest(f.deps, input)
    expect('signal' in (f.complete.mock.calls[0]?.[0] ?? {})).toBe(false)
    await runAiStream(f.deps, { ...input, contextHash: 'ctx-2' }, () => {})
    expect('signal' in (f.stream.mock.calls[0]?.[0] ?? {})).toBe(false)
    expect(inflightCount()).toBe(0)
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
      session: f.session,
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
      session: f.session,
      now: () => NOW
    })
    await expect(runAiRequest(deps, input)).resolves.toMatchObject({ cached: false })
    expect(appState.get().aiUsage).toMatchObject({ spentDate: TODAY, requestsToday: 1 })
  })
})

describe('a provider that prices its own requests (F-15.4)', () => {
  /** The Cloud adapter charges the MythScribe rate; here, twice what `priceFor` says. */
  const doubled = (
    model: string,
    inTok: number,
    outTok: number
  ): { costUsd: number; priced: boolean } => {
    const own = priceFor(model, inTok, outTok)
    return { costUsd: own.costUsd * 2, priced: own.priced }
  }

  it('prices the ledger row and the result with the provider price, not the default', async () => {
    const f = fakes()
    f.provider = { ...f.provider!, id: 'cloud', price: doubled }
    const result = await runAiRequest(f.deps, input)
    const expected = doubled('gpt-5.4-mini', 40, 10)
    expect(result.costUsd).toBe(expected.costUsd)
    expect(result.costUsd).toBe(priceFor('gpt-5.4-mini', 40, 10).costUsd * 2)
    expect(f.ledger[0]).toMatchObject({ provider: 'cloud', costUsd: expected.costUsd })
    expect(f.spends).toEqual([{ costUsd: expected.costUsd, tokens: 50 }])
  })

  it('checks the daily cap against the provider price too', async () => {
    const own = priceFor(
      'gpt-5.4-mini',
      estimateTokens(input.messages.map((m) => m.content).join('\n')),
      120
    )
    // A cap that the provider's own price fits under, but twice that price does not.
    const f = fakes({ dailyCapUsd: own.costUsd * 1.5, spentTodayUsd: 0 })
    f.provider = { ...f.provider!, id: 'cloud', price: doubled }
    await expect(runAiRequest(f.deps, input)).rejects.toThrow(/cap/)
    expect(f.complete).not.toHaveBeenCalled()
    expect(f.ledger).toEqual([])
  })
})

describe('model choice and cached input (AI-BILLING-SPEC M8, R4, A4, R6)', () => {
  it('sends the routed tier, resolves its model, and records both in the ledger', async () => {
    const f = fakes()
    f.deps.routing = () => ({
      routing: { all: null, features: { tags: 'strong' } },
      table: autoTable(null)
    })
    const result = await runAiRequest(f.deps, input)
    expect(f.complete.mock.calls[0]?.[0]).toMatchObject({ tier: 'strong' })
    expect(result.model).toBe('gpt-5.4')
    expect(f.ledger[0]).toMatchObject({ tier: 'strong', model: 'gpt-5.4' })
  })

  it('leaves the requested tier alone under Auto', async () => {
    const f = fakes()
    f.deps.routing = () => ({ routing: defaultAiRouting(), table: autoTable(null) })
    await runAiRequest(f.deps, input)
    expect(f.complete.mock.calls[0]?.[0]).toMatchObject({ tier: 'fast' })
    expect(f.ledger[0]).toMatchObject({ tier: 'fast', model: 'gpt-5.4-mini' })
  })

  it('records the cached prompt tokens and prices them at the cached rate', async () => {
    const f = fakes()
    f.complete.mockResolvedValueOnce({
      text: '{"tags":[]}',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 4_000, outputTokens: 100, cachedInputTokens: 3_000 }
    })
    const result = await runAiRequest(f.deps, input)
    expect(result.costUsd).toBeCloseTo(priceFor('gpt-5.4-mini', 4_000, 100, 3_000).costUsd)
    expect(result.costUsd).toBeLessThan(priceFor('gpt-5.4-mini', 4_000, 100).costUsd)
    expect(f.ledger[0]).toMatchObject({ cachedTokens: 3_000, costUsd: result.costUsd })
  })

  it('records null cached tokens when the provider does not report them', async () => {
    const f = fakes()
    await runAiRequest(f.deps, input)
    expect(f.ledger[0]?.cachedTokens).toBeNull()
  })

  it('binds the overrides from app state, and the Cloud table only for Cloud', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-route-'))
    const appState = new AppStateStore(path.join(tmp, 'app-state.json'))
    appState.update((s) => ({
      ...s,
      routing: { all: null, features: { chat: 'strong' } },
      cloudPricing: {
        fetchedAt: NOW.toISOString(),
        pricing: {
          ...bundledPricing(),
          routing: { ...bundledPricing().routing, features: { tags: 'strong' } }
        }
      }
    }))
    const f = fakes()
    const project = createProject(projectFolderFor(tmp, 'Route'), 'Route', 'novel')
    try {
      const deps = buildAiRequestDeps({
        db: project.connection.orm,
        providers: { get: () => f.provider },
        appState,
        session: f.session,
        now: () => NOW
      })
      expect(deps.routing?.('openai')).toEqual({
        routing: { all: null, features: { chat: 'strong' } },
        table: autoTable(null)
      })
      expect(deps.routing?.('cloud').table.tags).toBe('strong')
    } finally {
      project.close()
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})

describe('the developer tools observer (2026-10-07)', () => {
  /** A recording observer: every call in order, as `[step, detail]`. */
  function recorder(): { observe: AiRequestObserver; calls: [string, unknown][] } {
    const calls: [string, unknown][] = []
    const trace: AiRequestTrace = {
      prepared: (info) => void calls.push(['prepared', info]),
      sent: () => void calls.push(['sent', null]),
      firstToken: () => void calls.push(['firstToken', null]),
      done: (info) => void calls.push(['done', info]),
      failed: (err) => void calls.push(['failed', err instanceof Error ? err.message : err])
    }
    return {
      calls,
      observe: {
        start: (info) => {
          calls.push([
            'start',
            { feature: info.feature, streamed: info.streamed, requestId: info.requestId }
          ])
          return trace
        }
      }
    }
  }

  it('traces a request from start to done, then a cache hit without a provider call', async () => {
    const f = fakes()
    f.complete.mockResolvedValueOnce({
      text: '',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 40, outputTokens: 10, reasoningTokens: 10 },
      finishReason: 'length'
    })
    const { observe, calls } = recorder()
    await runAiRequest({ ...f.deps, observe }, { ...input, requestId: 'r-1' })
    expect(calls.map(([step]) => step)).toEqual(['start', 'prepared', 'sent', 'done'])
    expect(calls[0]![1]).toEqual({ feature: 'tags', streamed: false, requestId: 'r-1' })
    expect(calls[1]![1]).toEqual({
      provider: 'openai',
      model: 'gpt-5.4-mini',
      tier: 'fast',
      maxTokens: 120
    })
    expect(calls[3]![1]).toMatchObject({ text: '', cached: false, finishReason: 'length' })

    calls.length = 0
    await runAiRequest({ ...f.deps, observe }, input)
    expect(calls.map(([step]) => step)).toEqual(['start', 'prepared', 'done'])
    expect(calls[2]![1]).toMatchObject({ cached: true, costUsd: 0 })
  })

  it('traces the first streamed piece and the finish reason, and a refusal as failed', async () => {
    const f = fakes()
    f.chunks = [{ delta: '{"tags":' }, { delta: '[]}', finishReason: 'stop' }]
    const { observe, calls } = recorder()
    await runAiStream({ ...f.deps, observe }, input, () => undefined)
    expect(calls.map(([step]) => step)).toEqual(['start', 'prepared', 'sent', 'firstToken', 'done'])
    expect(calls.at(-1)![1]).toMatchObject({ finishReason: 'stop', text: '{"tags":[]}' })

    calls.length = 0
    f.provider = null
    await expect(runAiRequest({ ...f.deps, observe }, input)).rejects.toThrow(NoKeyError)
    expect(calls.map(([step]) => step)).toEqual(['start', 'failed'])
  })
})
