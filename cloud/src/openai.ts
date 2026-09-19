/**
 * The upstream seam of the AI proxy (F-15.4): what the Worker sends to OpenAI on the operator's
 * key, over plain `fetch` and Chat Completions. No SDK: the Worker bundle has no dependencies
 * and this is a POST plus an SSE reader. `ai.ts` talks to the `Upstream` interface only, so its
 * tests never touch the network and a second provider is another implementation of it.
 *
 * Nothing from a request or an answer is ever put in an error message or a log line: the
 * messages are the author's manuscript.
 */

export interface UpstreamMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface UpstreamUsage {
  inputTokens: number
  outputTokens: number
}

export interface UpstreamParams {
  model: string
  messages: UpstreamMessage[]
  maxTokens: number
  json?: boolean
  temperature?: number
}

export interface UpstreamAnswer {
  text: string
  /** What the provider says answered; it may be a dated snapshot of the requested model. */
  model: string
  usage: UpstreamUsage
}

/** A piece of a streamed answer, or the final chunk carrying the whole request's usage. */
export type UpstreamChunk = { delta: string } | { usage: UpstreamUsage; model: string }

export interface Upstream {
  complete(params: UpstreamParams, signal?: AbortSignal): Promise<UpstreamAnswer>
  stream(params: UpstreamParams, signal?: AbortSignal): AsyncIterable<UpstreamChunk>
}

/** Why the upstream call failed, in the terms the proxy answers with (429 vs 502). */
export type UpstreamErrorKind = 'rate_limit' | 'auth' | 'network' | 'other'

export class UpstreamError extends Error {
  constructor(
    readonly status: number | null,
    readonly kind: UpstreamErrorKind,
    cause?: unknown
  ) {
    super(`The AI provider failed (${kind}${status === null ? '' : ` ${status}`})`, {
      cause
    })
    this.name = 'UpstreamError'
  }
}

/** The `fetch` shape, injectable so the tests answer requests without a network. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

const DEFAULT_BASE_URL = 'https://api.openai.com/v1'

function kindFor(status: number): UpstreamErrorKind {
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  return 'other'
}

function body(params: UpstreamParams, stream: boolean): string {
  return JSON.stringify({
    model: params.model,
    messages: params.messages,
    max_completion_tokens: params.maxTokens,
    ...(params.json ? { response_format: { type: 'json_object' } } : {}),
    ...(params.temperature === undefined ? {} : { temperature: params.temperature }),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {})
  })
}

/** The shape of a Chat Completions answer this module reads; everything else is ignored. */
interface ChatCompletion {
  model?: string
  choices?: { message?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number }
}

/** One SSE chunk of a streamed Chat Completions answer. */
interface ChatCompletionChunk {
  model?: string
  choices?: { delta?: { content?: string | null } }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function usageOf(usage: { prompt_tokens?: number; completion_tokens?: number }): UpstreamUsage {
  return {
    inputTokens: usage.prompt_tokens ?? 0,
    outputTokens: usage.completion_tokens ?? 0
  }
}

/** The OpenAI implementation of `Upstream`; the key is used here and nowhere else. */
export function openAiUpstream(
  key: string,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  baseUrl: string = DEFAULT_BASE_URL
): Upstream {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`

  const send = async (
    params: UpstreamParams,
    stream: boolean,
    signal?: AbortSignal
  ): Promise<Response> => {
    let response: Response
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json'
        },
        body: body(params, stream),
        ...(signal === undefined ? {} : { signal })
      })
    } catch (err) {
      throw new UpstreamError(null, 'network', err)
    }
    if (!response.ok) {
      // The body may echo the request, so it is read and dropped, never carried into the error.
      await response.text().catch(() => '')
      throw new UpstreamError(response.status, kindFor(response.status))
    }
    return response
  }

  return {
    async complete(params, signal) {
      const response = await send(params, false, signal)
      const parsed = parseJson(await response.text().catch(() => '')) as ChatCompletion | null
      if (parsed === null || typeof parsed !== 'object') {
        throw new UpstreamError(response.status, 'other')
      }
      return {
        text: parsed.choices?.[0]?.message?.content ?? '',
        model: parsed.model ?? params.model,
        usage: usageOf(parsed.usage ?? {})
      }
    },

    async *stream(params, signal) {
      const response = await send(params, true, signal)
      const stream = response.body
      if (stream === null) throw new UpstreamError(response.status, 'other')
      for await (const line of sseLines(stream)) {
        if (line === '[DONE]') return
        const chunk = parseJson(line) as ChatCompletionChunk | null
        if (chunk === null || typeof chunk !== 'object') continue
        const delta = chunk.choices?.[0]?.delta?.content
        if (delta) yield { delta }
        // `include_usage` puts the whole request's usage on one final chunk with no choices.
        if (chunk.usage) yield { usage: usageOf(chunk.usage), model: chunk.model ?? params.model }
      }
    }
  }
}

/**
 * The part of `Response.body` this module uses. The generated Worker types declare it as
 * `ReadableStream<any>`, which no typed code may take as bytes; this names the two methods the
 * reader below calls and keeps the chunks typed.
 */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array }>
    releaseLock(): void
  }
}

/**
 * The `data:` payloads of an SSE body, one at a time. Events are separated by blank lines and a
 * payload may arrive split across reads, so the tail of every read is kept until its newline.
 */
export async function* sseLines(stream: ByteStream): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line.startsWith('data:')) yield line.slice('data:'.length).trim()
        newline = buffer.indexOf('\n')
      }
    }
    const last = buffer.trim()
    if (last.startsWith('data:')) yield last.slice('data:'.length).trim()
  } finally {
    reader.releaseLock()
  }
}
