import { APIUserAbortError } from 'openai'
import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODELS, type Tier } from '@shared/ai'
import { buildOpenAiProvider, mapOpenAiError, type FetchLike } from './openai'
import { AiProviderError, type CompletionRequest, type StreamChunk } from './types'

interface Call {
  url: string
  init: RequestInit | undefined
}

/** A `fetch` that answers every request the same way and records what was asked. */
function answering(respond: () => Response | Promise<Response>): {
  fetch: FetchLike
  calls: Call[]
} {
  const calls: Call[] = []
  const fetch: FetchLike = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    calls.push({ url, init })
    return respond()
  }
  return { fetch, calls }
}

/** The JSON body the SDK sent with a recorded call. */
function bodyOf(call: Call | undefined): Record<string, unknown> {
  const body = call?.init?.body
  if (typeof body !== 'string') throw new Error('expected a string body')
  return JSON.parse(body) as Record<string, unknown>
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

const apiError = (status: number, code: string | null, message = 'nope'): Response =>
  json(status, { error: { message, type: 'error', code, param: null } })

const sse = (events: unknown[]): Response =>
  new Response(
    [...events.map((e) => `data: ${JSON.stringify(e)}`), 'data: [DONE]', ''].join('\n\n'),
    {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    }
  )

/** What a spec-compliant fetch rejects with once its `signal` aborts. */
const abortError = (): Error => new DOMException('The operation was aborted.', 'AbortError')

/** Rejects like a real fetch when the SDK's request signal aborts. */
const whenAborted = (init: RequestInit | undefined): Promise<never> =>
  new Promise((_, reject) => {
    const signal = init?.signal
    if (!signal) throw new Error('expected the SDK to pass a signal')
    if (signal.aborted) reject(abortError())
    signal.addEventListener('abort', () => reject(abortError()), { once: true })
  })

const KEY = 'sk-test-secret-1234abcd'

const request: CompletionRequest = {
  tier: 'fast',
  messages: [{ role: 'user', content: 'Say hi' }],
  maxTokens: 20
}

const completion = {
  id: 'chatcmpl-1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-5.4-mini-2026-03-17',
  choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
}

async function failure(fetch: FetchLike): Promise<AiProviderError> {
  try {
    await buildOpenAiProvider(KEY, { fetch }).complete(request)
  } catch (err) {
    if (err instanceof AiProviderError) return err
    throw err
  }
  throw new Error('complete() did not throw')
}

describe('buildOpenAiProvider.complete (F-5.1)', () => {
  it('sends the tier model, the cap, and the key, and parses text and usage', async () => {
    const { fetch, calls } = answering(() => json(200, completion))
    const result = await buildOpenAiProvider(KEY, { fetch }).complete(request)
    expect(result).toEqual({
      text: 'hi',
      model: 'gpt-5.4-mini-2026-03-17',
      usage: { inputTokens: 7, outputTokens: 2 }
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toMatch(/\/chat\/completions$/)
    const body = bodyOf(calls[0])
    expect(body.model).toBe(DEFAULT_MODELS.fast)
    expect(body.max_completion_tokens).toBe(20)
    expect(body.response_format).toBeUndefined()
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${KEY}`)
  })

  it('forwards the temperature when given and leaves the field out otherwise (F-5.3)', async () => {
    const { fetch, calls } = answering(() => json(200, completion))
    const provider = buildOpenAiProvider(KEY, { fetch })
    await provider.complete({ ...request, temperature: 0.9 })
    expect(bodyOf(calls[0]).temperature).toBe(0.9)
    await provider.complete({ ...request, temperature: 0 })
    expect(bodyOf(calls[1]).temperature).toBe(0)
    await provider.complete(request)
    expect('temperature' in bodyOf(calls[2])).toBe(false)
  })

  it('uses the strong model and JSON mode when asked', async () => {
    const { fetch, calls } = answering(() => json(200, completion))
    await buildOpenAiProvider(KEY, { fetch }).complete({ ...request, tier: 'strong', json: true })
    const body = bodyOf(calls[0])
    expect(body.model).toBe(DEFAULT_MODELS.strong)
    expect(body.response_format).toEqual({ type: 'json_object' })
  })

  it('asks resolveModel for the tier model on every request (F-5.11)', async () => {
    const { fetch, calls } = answering(() => json(200, completion))
    let fast = 'gpt-5.4-nano'
    const resolveModel = vi.fn((tier: Tier) => (tier === 'fast' ? fast : 'gpt-5.4-pro'))
    const provider = buildOpenAiProvider(KEY, { fetch, resolveModel })
    await provider.complete(request)
    expect(bodyOf(calls[0]).model).toBe('gpt-5.4-nano')
    await provider.complete({ ...request, tier: 'strong' })
    expect(bodyOf(calls[1]).model).toBe('gpt-5.4-pro')
    fast = 'gpt-5.4-micro'
    await provider.complete(request)
    expect(bodyOf(calls[2]).model).toBe('gpt-5.4-micro')
    expect(provider.resolveModel('fast')).toBe('gpt-5.4-micro')
    expect(resolveModel.mock.calls.map(([tier]) => tier)).toEqual([
      'fast',
      'strong',
      'fast',
      'fast'
    ])
  })

  it('maps a 401 to INVALID_KEY without echoing the key', async () => {
    const err = await failure(answering(() => apiError(401, 'invalid_api_key', `bad ${KEY}`)).fetch)
    expect(err.code).toBe('INVALID_KEY')
    expect(err.message).not.toContain(KEY)
    expect(err.message).toMatch(/rejected/)
  })

  it('maps a 429 with insufficient_quota to QUOTA', async () => {
    const err = await failure(answering(() => apiError(429, 'insufficient_quota')).fetch)
    expect(err.code).toBe('QUOTA')
  })

  it('maps any other 429 to RATE_LIMIT', async () => {
    const err = await failure(answering(() => apiError(429, 'rate_limit_exceeded')).fetch)
    expect(err.code).toBe('RATE_LIMIT')
  })

  it('maps a failed fetch to NETWORK', async () => {
    const err = await failure(answering(() => Promise.reject(new Error('ECONNREFUSED'))).fetch)
    expect(err.code).toBe('NETWORK')
  })

  it('maps any other API error to PROVIDER with the status', async () => {
    const err = await failure(answering(() => apiError(500, null, 'server exploded')).fetch)
    expect(err.code).toBe('PROVIDER')
    expect(err.message).toBe('OpenAI reported a problem (HTTP 500).')
  })

  it('does not retry, so a rate limit answers at once with one request', async () => {
    const { fetch, calls } = answering(() => apiError(429, 'rate_limit_exceeded'))
    await failure(fetch)
    expect(calls).toHaveLength(1)
  })

  it('aborting the request signal mid-flight rejects with CANCELLED (F-5.10)', async () => {
    const fetch: FetchLike = (_input, init) => whenAborted(init)
    const controller = new AbortController()
    const pending = buildOpenAiProvider(KEY, { fetch }).complete({
      ...request,
      signal: controller.signal
    })
    let settled = false
    const mark = (): void => void (settled = true)
    void pending.then(mark, mark)
    await new Promise((r) => setTimeout(r, 10))
    expect(settled).toBe(false)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('an already aborted signal rejects with CANCELLED before any request leaves', async () => {
    const { fetch, calls } = answering(() => json(200, completion))
    const controller = new AbortController()
    controller.abort()
    await expect(
      buildOpenAiProvider(KEY, { fetch }).complete({ ...request, signal: controller.signal })
    ).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(calls).toHaveLength(0)
  })
})

describe('buildOpenAiProvider.stream', () => {
  const chunk = (content: string | null): unknown => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-5.4-mini',
    choices: [{ index: 0, delta: { content }, finish_reason: null }]
  })
  /** The final chunk `stream_options.include_usage` adds: no choices, the whole request's usage. */
  const usageChunk = {
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'gpt-5.4-mini',
    choices: [],
    usage: { prompt_tokens: 7, completion_tokens: 2, total_tokens: 9 }
  }

  it('yields the content deltas and skips empty ones', async () => {
    const { fetch, calls } = answering(() => sse([chunk('Hel'), chunk(null), chunk('lo')]))
    const seen: string[] = []
    for await (const { delta } of buildOpenAiProvider(KEY, { fetch }).stream(request)) {
      seen.push(delta)
    }
    expect(seen).toEqual(['Hel', 'lo'])
    const body = bodyOf(calls[0])
    expect(body.stream).toBe(true)
  })

  it('asks for the usage and yields it on the final chunk (F-5.4)', async () => {
    const { fetch, calls } = answering(() => sse([chunk('Hel'), chunk('lo'), usageChunk]))
    const seen: StreamChunk[] = []
    for await (const c of buildOpenAiProvider(KEY, { fetch }).stream(request)) seen.push(c)
    expect(seen).toEqual([
      { delta: 'Hel' },
      { delta: 'lo' },
      { delta: '', usage: { inputTokens: 7, outputTokens: 2 } }
    ])
    expect(bodyOf(calls[0]).stream_options).toEqual({ include_usage: true })
  })

  it('throws the mapped error from the first pull', async () => {
    const { fetch } = answering(() => apiError(401, 'invalid_api_key'))
    const iterator = buildOpenAiProvider(KEY, { fetch }).stream(request)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toMatchObject({ code: 'INVALID_KEY' })
  })

  it('aborting the signal mid-stream yields what arrived, then throws CANCELLED instead of ending quietly (F-5.10)', async () => {
    // An SSE body that sends one chunk, then stalls until the SDK's request signal aborts.
    const fetch: FetchLike = (_input, init) =>
      Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(body) {
              body.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk('Hel'))}\n\n`))
              init?.signal?.addEventListener('abort', () => body.error(abortError()), {
                once: true
              })
            }
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } }
        )
      )
    const controller = new AbortController()
    const seen: string[] = []
    const run = async (): Promise<void> => {
      for await (const { delta } of buildOpenAiProvider(KEY, { fetch }).stream({
        ...request,
        signal: controller.signal
      })) {
        seen.push(delta)
        controller.abort()
      }
    }
    await expect(run()).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(seen).toEqual(['Hel'])
  })
})

describe('buildOpenAiProvider.testConnection', () => {
  it('retrieves the fast model with a GET and resolves with its id', async () => {
    const { fetch, calls } = answering(() =>
      json(200, { id: 'gpt-5.4-mini', object: 'model', created: 0, owned_by: 'system' })
    )
    await expect(buildOpenAiProvider(KEY, { fetch }).testConnection()).resolves.toEqual({
      model: 'gpt-5.4-mini'
    })
    expect(calls[0]?.url).toMatch(new RegExp(`/models/${DEFAULT_MODELS.fast}$`))
    expect(calls[0]?.init?.method).toBe('GET')
  })

  it('retrieves the configured fast model (F-5.11)', async () => {
    const { fetch, calls } = answering(() =>
      json(200, { id: 'gpt-5.4-nano', object: 'model', created: 0, owned_by: 'system' })
    )
    const resolveModel = (tier: Tier): string => (tier === 'fast' ? 'gpt-5.4-nano' : 'gpt-5.4')
    await expect(
      buildOpenAiProvider(KEY, { fetch, resolveModel }).testConnection()
    ).resolves.toEqual({ model: 'gpt-5.4-nano' })
    expect(calls[0]?.url).toMatch(/\/models\/gpt-5\.4-nano$/)
  })

  it.each([
    [401, 'invalid_api_key', 'INVALID_KEY'],
    [429, 'insufficient_quota', 'QUOTA'],
    [429, 'rate_limit_exceeded', 'RATE_LIMIT'],
    [503, null, 'PROVIDER']
  ])('maps a %s %s to %s', async (status, code, expected) => {
    const { fetch } = answering(() => apiError(status, code))
    await expect(buildOpenAiProvider(KEY, { fetch }).testConnection()).rejects.toMatchObject({
      code: expected
    })
  })
})

describe('mapOpenAiError', () => {
  it('passes an already mapped error through and wraps anything unknown as PROVIDER', () => {
    const mapped = mapOpenAiError(new TypeError('odd'))
    expect(mapped.code).toBe('PROVIDER')
    expect(mapped.cause).toBeInstanceOf(TypeError)
    expect(mapOpenAiError(mapped)).toBe(mapped)
  })

  it("maps the SDK's user abort and any AbortError-named error to CANCELLED, ahead of the APIError fallback (F-5.10)", () => {
    const sdk = mapOpenAiError(new APIUserAbortError())
    expect(sdk.code).toBe('CANCELLED')
    expect(sdk.message).toBe('The request was stopped.')
    expect(sdk.cause).toBeInstanceOf(APIUserAbortError)
    expect(mapOpenAiError(abortError()).code).toBe('CANCELLED')
  })
})
