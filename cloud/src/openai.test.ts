import { describe, expect, it } from 'vitest'
import {
  type FetchLike,
  openAiModelId,
  openAiUpstream,
  openRouterUpstream,
  type UpstreamChunk,
  UpstreamError,
  type UpstreamParams
} from './openai'

/**
 * The upstream seam (F-15.4): what the proxy sends OpenAI, how it reads a streamed answer back,
 * and that a provider failure never carries the request or the response body with it.
 */

const KEY = 'sk-operator-key'
const BASE = 'https://api.openai.test/v1'
const PARAMS: UpstreamParams = {
  model: 'gpt-5.4-mini',
  messages: [{ role: 'user', content: 'Why is Mara on the ridge?' }],
  maxTokens: 60
}

interface Sent {
  url: string
  init: RequestInit | undefined
}

/** A fetch that records the call and answers what the test set up. */
function fakeFetch(answer: () => Response): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    fetch: (url, init) => {
      sent.push({ url, init })
      return Promise.resolve(answer())
    }
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** An SSE body delivered in the exact pieces given, so a split payload is exercised. */
function sseResponse(pieces: string[]): Response {
  const encoder = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const piece of pieces) controller.enqueue(encoder.encode(piece))
        controller.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function bodyOf(sent: Sent | undefined): Record<string, unknown> {
  const body = sent?.init?.body
  if (typeof body !== 'string') throw new Error('expected a string body')
  return JSON.parse(body) as Record<string, unknown>
}

async function collect(chunks: AsyncIterable<UpstreamChunk>): Promise<UpstreamChunk[]> {
  const out: UpstreamChunk[] = []
  for await (const chunk of chunks) out.push(chunk)
  return out
}

describe('openAiUpstream.complete', () => {
  it('posts Chat Completions with the key, the caps, and the answer parsed back', async () => {
    const { fetch, sent } = fakeFetch(() =>
      jsonResponse({
        model: 'gpt-5.4-mini-2026-09-01',
        choices: [{ message: { content: 'Because the pass is watched.' } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 }
      })
    )
    const answer = await openAiUpstream(KEY, fetch, BASE).complete({
      ...PARAMS,
      json: true,
      temperature: 0.7
    })
    expect(answer).toEqual({
      text: 'Because the pass is watched.',
      model: 'gpt-5.4-mini-2026-09-01',
      usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }
    })
    expect(sent).toHaveLength(1)
    expect(sent[0]?.url).toBe(`${BASE}/chat/completions`)
    expect(sent[0]?.init?.method).toBe('POST')
    expect(new Headers(sent[0]?.init?.headers).get('authorization')).toBe(`Bearer ${KEY}`)
    expect(bodyOf(sent[0])).toEqual({
      model: 'gpt-5.4-mini',
      messages: PARAMS.messages,
      max_completion_tokens: 60,
      response_format: { type: 'json_object' },
      temperature: 0.7
    })
  })

  it('leaves JSON mode, the temperature, and streaming off when they were not asked for', async () => {
    const { fetch, sent } = fakeFetch(() => jsonResponse({ choices: [], usage: {} }))
    const answer = await openAiUpstream(KEY, fetch, BASE).complete(PARAMS)
    expect(answer).toEqual({
      text: '',
      model: 'gpt-5.4-mini',
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
    })
    expect(bodyOf(sent[0])).toEqual({
      model: 'gpt-5.4-mini',
      messages: PARAMS.messages,
      max_completion_tokens: 60
    })
  })

  it('maps the provider statuses without echoing its body', async () => {
    const cases: [number, string][] = [
      [429, 'rate_limit'],
      [401, 'auth'],
      [404, 'model_unavailable'],
      [500, 'other']
    ]
    for (const [status, kind] of cases) {
      const { fetch } = fakeFetch(() =>
        jsonResponse({ error: { message: 'Why is Mara on the ridge?' } }, status)
      )
      const failure = await openAiUpstream(KEY, fetch, BASE)
        .complete(PARAMS)
        .catch((err: unknown) => err)
      expect(failure).toBeInstanceOf(UpstreamError)
      const error = failure as UpstreamError
      expect(error.kind).toBe(kind)
      expect(error.status).toBe(status)
      expect(error.message).not.toContain('Mara')
    }
  })

  it('reads a refused connection as a network failure', async () => {
    const upstream = openAiUpstream(
      KEY,
      () => Promise.reject(new Error('connect ECONNREFUSED')),
      BASE
    )
    const failure = await upstream.complete(PARAMS).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(UpstreamError)
    expect((failure as UpstreamError).kind).toBe('network')
    expect((failure as UpstreamError).status).toBeNull()
  })
})

describe('openAiUpstream.stream', () => {
  it('asks for usage on the last chunk and yields the deltas, then the usage', async () => {
    const { fetch, sent } = fakeFetch(() =>
      sseResponse([
        'data: {"model":"gpt-5.4-mini","choices":[{"delta":{"content":"The storm "}}]}\n\n',
        'data: {"model":"gpt-5.4-mini","choices":[{"delta":{"content":"broke at dusk."}}]}\n\n',
        'data: {"model":"gpt-5.4-mini","choices":[],"usage":{"prompt_tokens":100,"completion_tokens":20}}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const chunks = await collect(openAiUpstream(KEY, fetch, BASE).stream(PARAMS))
    expect(chunks).toEqual([
      { delta: 'The storm ' },
      { delta: 'broke at dusk.' },
      { usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }, model: 'gpt-5.4-mini' }
    ])
    expect(bodyOf(sent[0])).toMatchObject({
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('reassembles an event split across two reads', async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"The st',
        'orm broke."}}]}\n\ndata: [DONE]\n\n'
      ])
    )
    expect(await collect(openAiUpstream(KEY, fetch, BASE).stream(PARAMS))).toEqual([
      { delta: 'The storm broke.' }
    ])
  })

  it('stops at [DONE] and ignores keep-alive and unreadable lines', async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        ': keep-alive\n\n',
        'data: not json\n\n',
        'data: {"choices":[{"delta":{"content":"One."}}]}\n\n',
        'data: [DONE]\n\n',
        'data: {"choices":[{"delta":{"content":"Never."}}]}\n\n'
      ])
    )
    expect(await collect(openAiUpstream(KEY, fetch, BASE).stream(PARAMS))).toEqual([
      { delta: 'One.' }
    ])
  })

  it('fails before the first chunk when the provider refuses the stream', async () => {
    const { fetch } = fakeFetch(() => jsonResponse({ error: { message: 'slow down' } }, 429))
    const failure = await collect(openAiUpstream(KEY, fetch, BASE).stream(PARAMS)).catch(
      (err: unknown) => err
    )
    expect(failure).toBeInstanceOf(UpstreamError)
    expect((failure as UpstreamError).kind).toBe('rate_limit')
  })
})

describe('openRouterUpstream (A9) and cached tokens (A4, R6)', () => {
  it('posts to OpenRouter with max_tokens, the app attribution, and the id unchanged', async () => {
    const { fetch, sent } = fakeFetch(() =>
      jsonResponse({
        model: 'openai/gpt-5.4-mini',
        choices: [{ message: { content: 'Because of the storm.' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 20,
          prompt_tokens_details: { cached_tokens: 800 }
        }
      })
    )
    const answer = await openRouterUpstream('sk-or-key', fetch).complete({
      ...PARAMS,
      model: 'openai/gpt-5.4-mini'
    })

    expect(answer.usage).toEqual({ inputTokens: 1000, outputTokens: 20, cachedInputTokens: 800 })
    expect(sent[0]?.url).toBe('https://openrouter.ai/api/v1/chat/completions')
    const headers = new Headers(sent[0]?.init?.headers)
    expect(headers.get('authorization')).toBe('Bearer sk-or-key')
    expect(headers.get('x-title')).toBe('MythScribe')
    const body = bodyOf(sent[0])
    expect(body.model).toBe('openai/gpt-5.4-mini')
    expect(body.max_tokens).toBe(60)
    expect(body.max_completion_tokens).toBeUndefined()
  })

  it('reads the cached tokens from the last streamed chunk', async () => {
    const { fetch } = fakeFetch(() =>
      sseResponse([
        'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n',
        'data: {"model":"openai/gpt-5.4","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":40}}}\n\n',
        'data: [DONE]\n\n'
      ])
    )
    const chunks = await collect(openRouterUpstream('k', fetch).stream(PARAMS))
    expect(chunks).toEqual([
      { delta: 'Hi' },
      {
        usage: { inputTokens: 50, outputTokens: 2, cachedInputTokens: 40 },
        model: 'openai/gpt-5.4'
      }
    ])
  })

  it('maps a price table id to OpenAI direct by dropping the gateway prefix', async () => {
    expect(openAiModelId('openai/gpt-5.4')).toBe('gpt-5.4')
    expect(openAiModelId('gpt-5.4')).toBe('gpt-5.4')

    const { fetch, sent } = fakeFetch(() => jsonResponse({ choices: [] }))
    await openAiUpstream(KEY, fetch, { baseUrl: BASE, modelId: openAiModelId }).complete({
      ...PARAMS,
      model: 'openai/gpt-5.4'
    })
    const body = bodyOf(sent[0])
    expect(body.model).toBe('gpt-5.4')
    expect(body.max_completion_tokens).toBe(60)
  })
})
