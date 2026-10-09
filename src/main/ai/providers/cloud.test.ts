import { describe, expect, it, vi } from 'vitest'
import { AI_NEXT_STEP, DEFAULT_MODELS, type Tier } from '@shared/ai'
import {
  AI_STREAM_CONTENT_TYPE,
  CLOUD_AI_AVAILABLE,
  type AiStreamEvent,
  type CloudErrorCode,
  type CreditsResult,
  IDEMPOTENCY_KEY_HEADER
} from '@shared/cloudApi'
import { bundledPricing, hostedPriceFor } from '@shared/hostedPricing'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import { AccountError } from '../../account/cloudAuthClient'
import { buildCloudProvider, type CloudProviderOptions } from './cloud'
import type { FetchLike } from './openai'
import {
  AiCancelledError,
  AiCloudUnavailableError,
  AiFallbackError,
  AiModelUnavailableError,
  AiNetworkError,
  AiNoCreditError,
  AiRateLimitError,
  AiSignedOutError,
  AiTooLargeError,
  type CompletionRequest,
  type StreamChunk
} from './types'

/**
 * The Cloud adapter (F-15.4): what it puts on the wire, how it reads a JSON answer and an
 * NDJSON stream back, and that every Cloud failure becomes the right error with the right next
 * step. No test touches a network; `fetch` is a fake.
 */

const BASE = 'https://api.mythscribe.test'
const TOKEN = 'session-token'
const REQUEST: CompletionRequest = {
  tier: 'fast',
  feature: 'chat',
  messages: [{ role: 'user', content: 'Why is Mara on the ridge?' }],
  maxTokens: 200
}

interface Call {
  url: string
  init: RequestInit | undefined
}

function answering(respond: (call: Call) => Response | Promise<Response>): {
  fetch: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const call = { url, init }
    calls.push(call)
    return Promise.resolve(respond(call))
  }
  return { fetch, calls }
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const failure = (status: number, code: CloudErrorCode): Response =>
  json(status, { code, message: 'the Worker said so' })

const answer = (overrides: Record<string, unknown> = {}): Response =>
  json(200, {
    text: 'Because the pass is watched.',
    model: 'gpt-5.4-mini',
    usage: { inputTokens: 100, outputTokens: 20 },
    chargeMicros: 130,
    balanceMicros: 2_499_870,
    ...overrides
  })

/** An NDJSON body delivered in the exact pieces given, so a split line is exercised. */
const ndjson = (pieces: string[]): Response => {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': AI_STREAM_CONTENT_TYPE } }
  )
}

const line = (event: AiStreamEvent): string => `${JSON.stringify(event)}\n`

const credits = (balanceMicros: number): CreditsResult => ({
  balanceMicros,
  spend: [],
  periodDays: USAGE_PERIOD_DAYS,
  periodSpend: [],
  periodFirstChargeAt: null,
  packs: [],
  starter: null,
  refunds: []
})

function build(
  overrides: Partial<CloudProviderOptions> = {}
): ReturnType<typeof buildCloudProvider> {
  return buildCloudProvider({
    baseUrl: BASE,
    fetch: answering(() => answer()).fetch,
    token: () => TOKEN,
    onSessionEnded: () => undefined,
    resolveModel: (tier: Tier) => DEFAULT_MODELS[tier],
    credits: () => Promise.resolve(credits(2_500_000)),
    // The wire behavior is tested as it will run once Cloud serves AI; the gate has its own tests.
    available: true,
    ...overrides
  })
}

function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body
  if (typeof body !== 'string') throw new Error('expected a string body')
  return JSON.parse(body) as Record<string, unknown>
}

async function collect(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('buildCloudProvider.complete', () => {
  it('posts the resolved model and the bearer, and answers the proxy result', async () => {
    const { fetch, calls } = answering(() => answer())
    const result = await build({ fetch }).complete({
      ...REQUEST,
      json: true,
      temperature: 0.7
    })
    expect(result).toEqual({
      text: 'Because the pass is watched.',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 100, outputTokens: 20 }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}/ai/complete`)
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(bodyOf(calls[0])).toEqual({
      feature: 'chat',
      model: DEFAULT_MODELS.fast,
      messages: REQUEST.messages,
      maxTokens: 200,
      json: true,
      temperature: 0.7,
      stream: false
    })
  })

  it('sends a fresh Idempotency-Key with every request (L8)', async () => {
    const { fetch, calls } = answering(() => answer())
    const keys = ['key-00000001', 'key-00000002']
    const provider = build({ fetch, idempotencyKey: () => keys.shift() ?? 'spare-key' })
    await provider.complete(REQUEST)
    await provider.complete(REQUEST)
    expect(
      calls.map((call) => new Headers(call.init?.headers).get(IDEMPOTENCY_KEY_HEADER))
    ).toEqual(['key-00000001', 'key-00000002'])
    // Unpinned, it is a random UUID the Worker accepts.
    const { fetch: plain, calls: plainCalls } = answering(() => answer())
    await build({ fetch: plain }).complete(REQUEST)
    expect(new Headers(plainCalls[0]?.init?.headers).get(IDEMPOTENCY_KEY_HEADER)).toMatch(
      /^[A-Za-z0-9._:-]{8,128}$/
    )
  })

  it('sends an access token, not the session token (A5, S6)', async () => {
    const { fetch, calls } = answering(() => answer())
    const bearer = vi.fn(() => Promise.resolve('access-1'))
    await build({ fetch, bearer }).complete(REQUEST)
    expect(bearer).toHaveBeenCalledWith(TOKEN)
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer access-1')
  })

  it('replaces a refused access token once, with the same Idempotency-Key', async () => {
    const onSessionEnded = vi.fn()
    const invalidateBearer = vi.fn()
    const tokens = ['access-stale', 'access-fresh']
    const { fetch, calls } = answering((call) =>
      new Headers(call.init?.headers).get('authorization') === 'Bearer access-stale'
        ? failure(401, 'UNAUTHORIZED')
        : answer()
    )
    const result = await build({
      fetch,
      onSessionEnded,
      invalidateBearer,
      bearer: () => Promise.resolve(tokens.shift() ?? 'access-spare'),
      idempotencyKey: () => 'retry-key-1'
    }).complete(REQUEST)
    expect(result.text).toBe('Because the pass is watched.')
    expect(calls).toHaveLength(2)
    expect(invalidateBearer).toHaveBeenCalledOnce()
    expect(onSessionEnded).not.toHaveBeenCalled()
    const keys = calls.map((call) => new Headers(call.init?.headers).get(IDEMPOTENCY_KEY_HEADER))
    expect(keys).toEqual(['retry-key-1', 'retry-key-1'])
  })

  it('ends the session when the refresh token itself is refused', async () => {
    const onSessionEnded = vi.fn()
    const { fetch, calls } = answering(() => answer())
    const failed = await build({
      fetch,
      onSessionEnded,
      bearer: () => Promise.reject(new AccountError('UNAUTHORIZED', 'gone', 'Sign in again.'))
    })
      .complete(REQUEST)
      .catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(AiSignedOutError)
    expect(onSessionEnded).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(0)
  })

  it('refuses to send anything while signed out', async () => {
    const { fetch, calls } = answering(() => answer())
    await expect(build({ fetch, token: () => null }).complete(REQUEST)).rejects.toBeInstanceOf(
      AiSignedOutError
    )
    expect(calls).toHaveLength(0)
  })

  it('forgets the session and reports it once for a 401', async () => {
    const onSessionEnded = vi.fn()
    const { fetch } = answering(() => failure(401, 'UNAUTHORIZED'))
    const failed = await build({ fetch, onSessionEnded })
      .complete(REQUEST)
      .catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(AiSignedOutError)
    expect(onSessionEnded).toHaveBeenCalledOnce()
  })

  it('maps an empty balance, a busy proxy, and everything else', async () => {
    const cases: [CloudErrorCode, number, unknown][] = [
      ['INSUFFICIENT_CREDITS', 402, AiNoCreditError],
      ['RATE_LIMITED', 429, AiRateLimitError],
      ['REQUEST_TOO_LARGE', 413, AiTooLargeError],
      ['MODEL_UNAVAILABLE', 422, AiModelUnavailableError],
      ['DUPLICATE_REQUEST', 409, AiFallbackError],
      ['UPSTREAM', 502, AiFallbackError],
      ['NOT_CONFIGURED', 503, AiFallbackError],
      ['BAD_REQUEST', 400, AiFallbackError]
    ]
    for (const [code, status, expected] of cases) {
      const { fetch } = answering(() => failure(status, code))
      const failed = await build({ fetch })
        .complete(REQUEST)
        .catch((err: unknown) => err)
      expect(failed).toBeInstanceOf(expected as never)
      expect((failed as Error).message).not.toContain('the Worker said so')
    }
  })

  it('turns a refusal for the balance into the offer it carries (2026-10-08)', async () => {
    const refused = async (offer: unknown): Promise<Error> => {
      const { fetch } = answering(() =>
        json(402, { code: 'INSUFFICIENT_CREDITS', message: 'the Worker said so', offer })
      )
      return (await build({ fetch })
        .complete(REQUEST)
        .catch((err: unknown) => err)) as Error
    }
    const starter = await refused({
      kind: 'starter',
      variantId: '777',
      priceCents: 500,
      refundWindowDays: 30
    })
    expect(starter).toBeInstanceOf(AiNoCreditError)
    expect(starter.message).toBe('Try the AI for $5. Any unused balance is refundable for 30 days.')
    expect((await refused({ kind: 'packs', negative: true })).message).toContain('below zero')
    expect((await refused({ kind: 'packs', negative: false })).message).toBe(
      'Your MythScribe Cloud balance is too low for this request.'
    )
    // An older Worker sends no offer.
    expect((await refused(undefined)).message).toBe(
      'Your MythScribe Cloud balance is too low for this request.'
    )
  })

  it('reads an unreachable Worker as a network failure and a timeout as one too', async () => {
    const offline = build({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) })
    await expect(offline.complete(REQUEST)).rejects.toBeInstanceOf(AiNetworkError)

    const hang = build({
      timeoutMs: 5,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
        })
    })
    const timedOut = await hang.complete(REQUEST).catch((err: unknown) => err)
    expect(timedOut).toBeInstanceOf(AiNetworkError)
    expect((timedOut as Error).message).toContain('in time')
  })

  it('reads a cancelled request as CANCELLED, not as a network failure', async () => {
    const controller = new AbortController()
    const provider = build({
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true
          })
          controller.abort()
        })
    })
    await expect(
      provider.complete({ ...REQUEST, signal: controller.signal })
    ).rejects.toBeInstanceOf(AiCancelledError)
  })

  it('refuses a 2xx body it cannot read', async () => {
    const { fetch } = answering(() => json(200, { text: 'no usage here' }))
    await expect(build({ fetch }).complete(REQUEST)).rejects.toBeInstanceOf(AiFallbackError)
  })

  it('reports the balance the proxy answered with, and none for a refusal (F-15.5)', async () => {
    const onBalance = vi.fn()
    const { fetch } = answering(() => answer())
    await build({ fetch, onBalance }).complete(REQUEST)
    expect(onBalance.mock.calls).toEqual([[2_499_870]])

    onBalance.mockClear()
    const refused = answering(() => failure(402, 'INSUFFICIENT_CREDITS'))
    await build({ fetch: refused.fetch, onBalance })
      .complete(REQUEST)
      .catch(() => undefined)
    expect(onBalance).not.toHaveBeenCalled()
  })
})

describe('buildCloudProvider.stream', () => {
  it('yields the deltas and the usage on the final chunk', async () => {
    const { fetch, calls } = answering(() =>
      ndjson([
        line({ type: 'delta', delta: 'The storm ' }),
        line({ type: 'delta', delta: 'broke at dusk.' }),
        line({
          type: 'done',
          model: 'gpt-5.4-mini',
          usage: { inputTokens: 100, outputTokens: 20 },
          chargeMicros: 130,
          balanceMicros: 2_499_870
        })
      ])
    )
    expect(await collect(build({ fetch }).stream(REQUEST))).toEqual([
      { delta: 'The storm ' },
      { delta: 'broke at dusk.' },
      { delta: '', usage: { inputTokens: 100, outputTokens: 20 } }
    ])
    expect(bodyOf(calls[0])).toMatchObject({ stream: true })
  })

  it('reassembles a line split across two reads', async () => {
    const whole =
      line({ type: 'delta', delta: 'The storm broke.' }) +
      line({
        type: 'done',
        model: 'gpt-5.4-mini',
        usage: { inputTokens: 10, outputTokens: 4 },
        chargeMicros: 6,
        balanceMicros: 1_000
      })
    const split = whole.indexOf('broke') + 2
    const { fetch } = answering(() => ndjson([whole.slice(0, split), whole.slice(split)]))
    expect(await collect(build({ fetch }).stream(REQUEST))).toEqual([
      { delta: 'The storm broke.' },
      { delta: '', usage: { inputTokens: 10, outputTokens: 4 } }
    ])
  })

  it('throws the mapped failure for an error event mid-stream', async () => {
    const { fetch } = answering(() =>
      ndjson([
        line({ type: 'delta', delta: 'The storm ' }),
        line({ type: 'error', code: 'UPSTREAM', message: 'the provider gave up' })
      ])
    )
    const chunks: StreamChunk[] = []
    const failed = await (async () => {
      try {
        for await (const chunk of build({ fetch }).stream(REQUEST)) chunks.push(chunk)
        return null
      } catch (err) {
        return err
      }
    })()
    expect(chunks).toEqual([{ delta: 'The storm ' }])
    expect(failed).toBeInstanceOf(AiFallbackError)
  })

  it('stops a cancelled stream with CANCELLED and closes the body', async () => {
    const controller = new AbortController()
    const { fetch } = answering(() =>
      ndjson([
        line({ type: 'delta', delta: 'The storm ' }),
        line({ type: 'delta', delta: 'broke at dusk.' })
      ])
    )
    const provider = build({ fetch })
    const failed = await (async () => {
      try {
        for await (const chunk of provider.stream({ ...REQUEST, signal: controller.signal })) {
          expect(chunk.delta).toBe('The storm ')
          controller.abort()
        }
        return null
      } catch (err) {
        return err
      }
    })()
    expect(failed).toBeInstanceOf(AiCancelledError)
  })

  it('reports the balance from the done event, once (F-15.5)', async () => {
    const onBalance = vi.fn()
    const { fetch } = answering(() =>
      ndjson([
        line({ type: 'delta', delta: 'The storm ' }),
        line({
          type: 'done',
          model: 'gpt-5.4-mini',
          usage: { inputTokens: 100, outputTokens: 20 },
          chargeMicros: 130,
          balanceMicros: 2_499_870
        })
      ])
    )
    await collect(build({ fetch, onBalance }).stream(REQUEST))
    expect(onBalance.mock.calls).toEqual([[2_499_870]])
  })

  it('reports no balance for a stream that failed mid-flight (F-15.5)', async () => {
    const onBalance = vi.fn()
    const { fetch } = answering(() =>
      ndjson([line({ type: 'error', code: 'UPSTREAM', message: 'the provider gave up' })])
    )
    await collect(build({ fetch, onBalance }).stream(REQUEST)).catch(() => undefined)
    expect(onBalance).not.toHaveBeenCalled()
  })

  it('reads a proxy failure before the first byte like a completion', async () => {
    const { fetch } = answering(() => failure(402, 'INSUFFICIENT_CREDITS'))
    await expect(collect(build({ fetch }).stream(REQUEST))).rejects.toBeInstanceOf(AiNoCreditError)
  })
})

describe('buildCloudProvider while Cloud does not serve AI (CLOUD_AI_AVAILABLE)', () => {
  it('defaults to the shared flag, which is off until Cloud launches', async () => {
    expect(CLOUD_AI_AVAILABLE).toBe(false)
    const { fetch, calls } = answering(() => answer())
    const provider = buildCloudProvider({
      baseUrl: BASE,
      fetch,
      token: () => TOKEN,
      onSessionEnded: () => undefined,
      resolveModel: (tier: Tier) => DEFAULT_MODELS[tier],
      credits: () => Promise.resolve(credits(2_500_000))
    })
    await expect(provider.complete(REQUEST)).rejects.toBeInstanceOf(AiCloudUnavailableError)
    expect(calls).toHaveLength(0)
  })

  it('refuses every call before sending anything, with the way out as the next step', async () => {
    const { fetch, calls } = answering(() => answer())
    const creditsCall = vi.fn(() => Promise.resolve(credits(2_500_000)))
    const provider = build({ fetch, available: false, credits: creditsCall })
    const failed = await provider.complete(REQUEST).catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(AiCloudUnavailableError)
    expect((failed as AiCloudUnavailableError).message).toBe(
      'MythScribe Cloud isn\u2019t available yet.'
    )
    expect(AI_NEXT_STEP[(failed as AiCloudUnavailableError).code]).toBe(
      'Switch to My own key or Local model in Settings › AI.'
    )
    await expect(collect(provider.stream(REQUEST))).rejects.toBeInstanceOf(AiCloudUnavailableError)
    await expect(provider.testConnection()).rejects.toBeInstanceOf(AiCloudUnavailableError)
    expect(calls).toHaveLength(0)
    expect(creditsCall).not.toHaveBeenCalled()
  })

  it('reads a NOT_FOUND from /ai/complete as Cloud not serving AI yet, not as a raw code', async () => {
    const { fetch } = answering(() => failure(404, 'NOT_FOUND'))
    const failed = await build({ fetch })
      .complete(REQUEST)
      .catch((err: unknown) => err)
    expect(failed).toBeInstanceOf(AiCloudUnavailableError)
    expect((failed as Error).message).toBe('MythScribe Cloud isn\u2019t reachable for AI yet.')
    expect((failed as Error).message).not.toContain('NOT_FOUND')
  })
})

describe('buildCloudProvider.testConnection and price', () => {
  it('answers the fast model while there is credit', async () => {
    await expect(build().testConnection()).resolves.toEqual({ model: DEFAULT_MODELS.fast })
  })

  it('refuses an empty balance and a signed-out account', async () => {
    await expect(
      build({ credits: () => Promise.resolve(credits(0)) }).testConnection()
    ).rejects.toBeInstanceOf(AiNoCreditError)
    // While the starter pack is on offer, the empty balance offers it.
    await expect(
      build({
        credits: () =>
          Promise.resolve({ ...credits(0), starter: { variantId: '777', priceCents: 500 } })
      }).testConnection()
    ).rejects.toThrow('Try the AI for $5. Any unused balance is refundable for 30 days.')
    await expect(build({ token: () => null }).testConnection()).rejects.toBeInstanceOf(
      AiSignedOutError
    )
  })

  it('maps an account-client failure like a completion failure', async () => {
    const onSessionEnded = vi.fn()
    const unauthorized = build({
      onSessionEnded,
      credits: () => Promise.reject(new AccountError('UNAUTHORIZED', 'gone', 'Sign in again.'))
    })
    await expect(unauthorized.testConnection()).rejects.toBeInstanceOf(AiSignedOutError)
    expect(onSessionEnded).toHaveBeenCalledOnce()

    const offline = build({
      credits: () => Promise.reject(new AccountError('NETWORK', 'offline', 'Try again.'))
    })
    await expect(offline.testConnection()).rejects.toBeInstanceOf(AiNetworkError)
  })

  it('prices at the Worker defaults until the server table is known (P5)', () => {
    const provider = build()
    const bundled = bundledPricing()
    const id = bundled.routing.tiers.fast
    expect(provider.price?.(id, 1_000, 100, 500)).toEqual(
      hostedPriceFor(bundled, id, 1_000, 100, 500)
    )
    expect(provider.price?.(id, 1_000, 100)?.priced).toBe(true)
    expect(provider.id).toBe('cloud')
  })

  it('prices at the server table once fetched, and an unlisted model as unpriced', () => {
    const table = {
      ...bundledPricing(),
      models: [
        {
          id: 'cheap/fast',
          label: 'Cheap',
          inputUsdPerM: 1,
          outputUsdPerM: 2,
          cachedInputUsdPerM: 0.1,
          displayMultiplier: 1
        }
      ]
    }
    const provider = build({ pricing: () => table })
    expect(provider.price?.('cheap/fast', 1_000, 100, 500)).toEqual(
      hostedPriceFor(table, 'cheap/fast', 1_000, 100, 500)
    )
    expect(provider.price?.('gpt-5.4', 100, 20)).toEqual({ costUsd: 0, priced: false })
  })
})
