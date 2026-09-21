import type { Tier } from '@shared/ai'
import {
  type AiCompleteBody,
  AiCompleteResult,
  AiStreamEvent,
  CloudApiError,
  type CloudErrorCode,
  type CreditsResult
} from '@shared/cloudApi'
import { cloudPriceFor } from '@shared/cloudRates'
import { AccountError } from '../../account/cloudAuthClient'
import type { FetchLike } from './openai'
import {
  AiCancelledError,
  AiFallbackError,
  AiNetworkError,
  AiNoCreditError,
  AiProviderError,
  AiRateLimitError,
  AiSignedOutError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type StreamChunk
} from './types'

/**
 * The MythScribe Cloud adapter (F-15.4): the same `Provider` interface, pointed at our Worker
 * instead of at OpenAI. It sends the session bearer and the resolved model to `POST /ai/complete`
 * and reads back either one JSON answer or the NDJSON stream; the proxy charges the account's
 * credits, so `price` reports the Cloud rate and the cost line under every proposal is what the
 * author actually paid.
 *
 * The session token never leaves main: it is read live through `token()` on every request, and a
 * 401 tells `AccountService` to forget the session (`onSessionEnded`) exactly as `refresh()` does.
 */

export interface CloudProviderOptions {
  /** The Cloud API root, from `cloudApiUrl(process.env)`; a trailing slash is tolerated. */
  baseUrl: string
  fetch: FetchLike
  /** The current session token, or null when signed out; read on every request, never cached. */
  token: () => string | null
  /** Called when the proxy refuses the session, so the account forgets it and the tab updates. */
  onSessionEnded: () => void
  /** The tier → model mapping (F-5.11), asked on every request like the OpenAI adapter's. */
  resolveModel: (tier: Tier) => string
  /** The account's credits, for "Test connection"; built from the one `CloudAuthClient`. */
  credits: (token: string) => Promise<CreditsResult>
  /**
   * The balance the proxy reported with an answered request (F-15.5), so the app's meter follows
   * a charge without asking `/credits` again. Called once per answer, after the charge.
   */
  onBalance?: (balanceMicros: number) => void
  /** The non-streamed call's overall timeout; a stream is bounded by its signal alone. */
  timeoutMs?: number
}

const SIGNED_OUT = 'Sign in to MythScribe Cloud to use it for this project.'
const SESSION_ENDED = 'Your MythScribe Cloud session has ended.'
const NO_CREDIT = 'Your MythScribe Cloud balance is used up.'
const BUSY = 'MythScribe Cloud is busy right now.'
const UNREACHABLE = 'Could not reach MythScribe Cloud.'
const TIMED_OUT = 'MythScribe Cloud did not answer in time.'
const UNREADABLE = 'MythScribe Cloud sent an answer MythScribe could not read.'
const CANCELLED = 'The request was stopped.'
const NO_FEATURE = 'MythScribe Cloud needs to know which feature is asking.'

/** The default overall timeout for a non-streamed proxy call; the same 15 s the account calls use. */
export const CLOUD_COMPLETE_TIMEOUT_MS = 15_000

/** One signal for the caller's cancel and this call's timeout, without needing `AbortSignal.any`. */
function deadline(
  signal: AbortSignal | undefined,
  timeoutMs: number
): { signal: AbortSignal; timedOut: () => boolean; release: () => void } {
  const controller = new AbortController()
  let expired = false
  const timer = setTimeout(() => {
    expired = true
    controller.abort()
  }, timeoutMs)
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  const onAbort = (): void => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    timedOut: () => expired,
    release: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    }
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

export function buildCloudProvider(options: CloudProviderOptions): Provider {
  const root = options.baseUrl.replace(/\/+$/, '')
  const timeoutMs = options.timeoutMs ?? CLOUD_COMPLETE_TIMEOUT_MS

  /** The one mapping from a Cloud error code to the app's taxonomy. */
  const failureOf = (code: CloudErrorCode): AiProviderError => {
    if (code === 'UNAUTHORIZED') {
      options.onSessionEnded()
      return new AiSignedOutError(SESSION_ENDED)
    }
    if (code === 'INSUFFICIENT_CREDITS') return new AiNoCreditError(NO_CREDIT)
    if (code === 'RATE_LIMITED') return new AiRateLimitError(BUSY)
    return new AiFallbackError(`MythScribe Cloud reported a problem (${code}).`)
  }

  /** A non-2xx answer, or an unreadable one; the Worker's own copy is never shown as-is. */
  const failureBody = (text: string): AiProviderError => {
    const parsed = CloudApiError.safeParse(parseJson(text))
    if (!parsed.success) return new AiFallbackError(UNREADABLE)
    return failureOf(parsed.data.code)
  }

  const bodyFor = (request: CompletionRequest, stream: boolean): AiCompleteBody => {
    if (request.feature === undefined) throw new AiFallbackError(NO_FEATURE)
    return {
      feature: request.feature,
      model: options.resolveModel(request.tier),
      messages: request.messages,
      maxTokens: request.maxTokens,
      ...(request.json === undefined ? {} : { json: request.json }),
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      stream
    }
  }

  /** Sends one `/ai/complete` request; every expected failure leaves as an `AiProviderError`. */
  const send = async (request: CompletionRequest, stream: boolean): Promise<Response> => {
    const token = options.token()
    if (token === null) throw new AiSignedOutError(SIGNED_OUT)
    const body = bodyFor(request, stream)
    const bounds = deadline(request.signal, timeoutMs)
    let response: Response
    try {
      response = await options.fetch(`${root}/ai/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
        signal: bounds.signal
      })
    } catch (err) {
      if (request.signal?.aborted) throw new AiCancelledError(CANCELLED, err)
      throw new AiNetworkError(bounds.timedOut() ? TIMED_OUT : UNREACHABLE, err)
    } finally {
      bounds.release()
    }
    if (!response.ok) throw failureBody(await response.text().catch(() => ''))
    return response
  }

  return {
    id: 'cloud',
    resolveModel: options.resolveModel,
    price: cloudPriceFor,

    async complete(request): Promise<CompletionResult> {
      const response = await send(request, false)
      const parsed = AiCompleteResult.safeParse(parseJson(await response.text().catch(() => '')))
      if (!parsed.success) throw new AiFallbackError(UNREADABLE)
      const { text, model, usage } = parsed.data
      options.onBalance?.(parsed.data.balanceMicros)
      return { text, model, usage }
    },

    async *stream(request): AsyncGenerator<StreamChunk> {
      const response = await send(request, true)
      const body = response.body
      if (body === null) throw new AiFallbackError(UNREADABLE)
      for await (const line of ndjsonLines(body)) {
        if (request.signal?.aborted) throw new AiCancelledError(CANCELLED)
        const event = AiStreamEvent.safeParse(parseJson(line))
        if (!event.success) throw new AiFallbackError(UNREADABLE)
        if (event.data.type === 'delta') {
          yield { delta: event.data.delta }
          continue
        }
        if (event.data.type === 'error') throw failureOf(event.data.code)
        // `done` carries the whole request's usage, like the OpenAI adapter's final chunk.
        options.onBalance?.(event.data.balanceMicros)
        yield { delta: '', usage: event.data.usage }
        return
      }
      // The stream ended without a terminal event: the proxy or the connection gave up.
      if (request.signal?.aborted) throw new AiCancelledError(CANCELLED)
      throw new AiNetworkError(UNREACHABLE)
    },

    async testConnection(): Promise<{ model: string }> {
      const token = options.token()
      if (token === null) throw new AiSignedOutError(SIGNED_OUT)
      let credits: CreditsResult
      try {
        credits = await options.credits(token)
      } catch (err) {
        throw accountFailure(err, failureOf)
      }
      if (credits.balanceMicros <= 0) throw new AiNoCreditError(NO_CREDIT)
      return { model: options.resolveModel('fast') }
    }
  }
}

/** A `CloudAuthClient` failure in the provider taxonomy; its own two codes have no Cloud twin. */
function accountFailure(
  err: unknown,
  failureOf: (code: CloudErrorCode) => AiProviderError
): AiProviderError {
  if (err instanceof AiProviderError) return err
  if (!(err instanceof AccountError)) {
    return new AiFallbackError(UNREACHABLE, err)
  }
  if (err.code === 'NETWORK') return new AiNetworkError(UNREACHABLE, err)
  if (err.code === 'PROTOCOL') return new AiFallbackError(UNREADABLE, err)
  return failureOf(err.code)
}

/**
 * The lines of an NDJSON body, one at a time. `fetch` in main is undici, so the body is a web
 * `ReadableStream`: a reader plus a streaming decoder, with the tail of every read kept until
 * its newline arrives.
 */
export async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') yield line
        newline = buffer.indexOf('\n')
      }
    }
    const last = buffer.trim()
    if (last !== '') yield last
  } finally {
    // A caller that stops reading (F-5.10's cancel) must close the connection, so the proxy
    // sees the client go and aborts the provider call; on a finished stream this is a no-op.
    await reader.cancel().catch(() => undefined)
  }
}
