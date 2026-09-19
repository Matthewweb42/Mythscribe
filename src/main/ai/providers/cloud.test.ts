import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODELS, type Tier } from '@shared/ai'
import {
  AI_STREAM_CONTENT_TYPE,
  type AiStreamEvent,
  type CloudErrorCode,
  type CreditsResult
} from '@shared/cloudApi'
import { cloudPriceFor } from '@shared/cloudRates'
import { AccountError } from '../../account/cloudAuthClient'
import { buildCloudProvider, type CloudProviderOptions } from './cloud'
import type { FetchLike } from './openai'
import {
  AiCancelledError,
  AiFallbackError,
  AiNetworkError,
  AiNoCreditError,
  AiRateLimitError,
  AiSignedOutError,
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
  packs: []
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

  it('reads a proxy failure before the first byte like a completion', async () => {
    const { fetch } = answering(() => failure(402, 'INSUFFICIENT_CREDITS'))
    await expect(collect(build({ fetch }).stream(REQUEST))).rejects.toBeInstanceOf(AiNoCreditError)
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

  it('prices at the Cloud rate, not the provider rate', () => {
    const provider = build()
    expect(provider.price?.('gpt-5.4-mini', 100, 20)).toEqual(
      cloudPriceFor('gpt-5.4-mini', 100, 20)
    )
    expect(provider.id).toBe('cloud')
  })
})
