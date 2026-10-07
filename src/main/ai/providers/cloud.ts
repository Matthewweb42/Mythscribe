import { randomUUID } from 'node:crypto'
import type { Tier } from '@shared/ai'
import {
  type AiCompleteBody,
  AiCompleteResult,
  AiStreamEvent,
  CLOUD_AI_AVAILABLE,
  CloudApiError,
  type CloudErrorCode,
  type CreditsResult,
  IDEMPOTENCY_KEY_HEADER,
  type PricingResult
} from '@shared/cloudApi'
import { bundledPricing, hostedPriceFor } from '@shared/hostedPricing'
import { AccountError } from '../../account/cloudAuthClient'
import type { FetchLike } from './openai'
import {
  AiCancelledError,
  AiCloudUnavailableError,
  AiFallbackError,
  AiModelUnavailableError,
  AiNetworkError,
  AiNoCreditError,
  AiProviderError,
  AiRateLimitError,
  AiSignedOutError,
  AiTooLargeError,
  type CompletionRequest,
  type CompletionResult,
  type Provider,
  type StreamChunk
} from './types'

/**
 * The MythScribe Cloud adapter (F-15.4): the same `Provider` interface, pointed at our Worker
 * instead of at OpenAI. It sends an access token and the resolved model to `POST /ai/complete`
 * and reads back either one JSON answer or the NDJSON stream; the proxy charges the account's
 * balance, so `price` reports the server's price (cost + markup) and the cost line under every
 * proposal is what the author actually paid.
 *
 * The session token never leaves main: it is read live through `token()` on every request and
 * traded for a short-lived access token (`bearer`, AI-BILLING-SPEC A5/S6) that is the one sent. A
 * 401 mints a fresh access token and tries once more; a session the Worker refuses outright tells
 * `AccountService` to forget it (`onSessionEnded`) exactly as `refresh()` does. Every request
 * carries an `Idempotency-Key` (L8), the same on that one retry, so it is charged at most once.
 */

export interface CloudProviderOptions {
  /** The Cloud API root, from `cloudApiUrl(process.env)`; a trailing slash is tolerated. */
  baseUrl: string
  fetch: FetchLike
  /** The current session token, or null when signed out; read on every request, never cached. */
  token: () => string | null
  /**
   * The bearer for the session token: a short-lived access token (`CloudAccessTokens.bearer`).
   * Throws the refresh's `AccountError`. Absent (tests, older wiring), the session token is sent.
   */
  bearer?: (sessionToken: string) => Promise<string>
  /** Forgets the cached access token after the proxy refused it, so the retry mints a new one. */
  invalidateBearer?: () => void
  /** A fresh `Idempotency-Key` per request; `randomUUID` unless a test pins it. */
  idempotencyKey?: () => string
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
  /**
   * Whether Cloud serves AI yet; defaults to `CLOUD_AI_AVAILABLE`. While false every call fails
   * with `AiCloudUnavailableError` before anything is sent.
   */
  available?: boolean
  /**
   * The server's price table (`GET /pricing`, AI-BILLING-SPEC P5), read live: every answer is
   * priced at its rate and markup with the Worker's own integer math. Absent or null (never
   * fetched yet), the Worker's defaults stand in (`bundledPricing`); the app keeps no rate of its
   * own.
   */
  pricing?: () => PricingResult | null
}

const SIGNED_OUT = 'Sign in to MythScribe Cloud to use it for this project.'
const SESSION_ENDED = 'Your MythScribe Cloud session has ended.'
const NO_CREDIT = 'Your MythScribe Cloud balance is too low for this request.'
const BUSY = 'MythScribe Cloud is busy, or this account sent too many requests in the last minute.'
const TOO_LARGE = 'This request is longer than MythScribe Cloud accepts.'
const MODEL_UNAVAILABLE = 'MythScribe Cloud does not offer the model this request asked for.'
const UPSTREAM = 'The AI model behind MythScribe Cloud did not answer. Nothing was charged.'
const DUPLICATE = 'MythScribe Cloud is still working on this request.'
const UNREACHABLE = 'Could not reach MythScribe Cloud.'
const TIMED_OUT = 'MythScribe Cloud did not answer in time.'
const UNREADABLE = 'MythScribe Cloud sent an answer MythScribe could not read.'
const CANCELLED = 'The request was stopped.'
const NO_FEATURE = 'MythScribe Cloud needs to know which feature is asking.'
const NOT_AVAILABLE = 'MythScribe Cloud isn\u2019t available yet.'
const NOT_REACHABLE = 'MythScribe Cloud isn\u2019t reachable for AI yet.'

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
  const available = options.available ?? CLOUD_AI_AVAILABLE

  /** The one mapping from a Cloud error code to the app's taxonomy. */
  const failureOf = (code: CloudErrorCode): AiProviderError => {
    if (code === 'UNAUTHORIZED') {
      options.onSessionEnded()
      return new AiSignedOutError(SESSION_ENDED)
    }
    if (code === 'INSUFFICIENT_CREDITS') return new AiNoCreditError(NO_CREDIT)
    if (code === 'RATE_LIMITED') return new AiRateLimitError(BUSY)
    if (code === 'REQUEST_TOO_LARGE') return new AiTooLargeError(TOO_LARGE)
    if (code === 'MODEL_UNAVAILABLE') return new AiModelUnavailableError(MODEL_UNAVAILABLE)
    if (code === 'UPSTREAM') return new AiFallbackError(UPSTREAM)
    if (code === 'DUPLICATE_REQUEST') return new AiFallbackError(DUPLICATE)
    // A Worker deployed without `/ai/complete` (or without its secrets) answers NOT_FOUND.
    if (code === 'NOT_FOUND') return new AiCloudUnavailableError(NOT_REACHABLE)
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

  /** The access token for the session; a refresh failure leaves in the provider taxonomy. */
  const bearerFor = async (sessionToken: string): Promise<string> => {
    if (options.bearer === undefined) return sessionToken
    try {
      return await options.bearer(sessionToken)
    } catch (err) {
      throw accountFailure(err, failureOf)
    }
  }

  /** One POST of the body with this bearer and idempotency key. */
  const post = async (
    request: CompletionRequest,
    body: AiCompleteBody,
    bearer: string,
    key: string
  ): Promise<Response> => {
    const bounds = deadline(request.signal, timeoutMs)
    try {
      return await options.fetch(`${root}/ai/complete`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearer}`,
          [IDEMPOTENCY_KEY_HEADER]: key
        },
        body: JSON.stringify(body),
        signal: bounds.signal
      })
    } catch (err) {
      if (request.signal?.aborted) throw new AiCancelledError(CANCELLED, err)
      throw new AiNetworkError(bounds.timedOut() ? TIMED_OUT : UNREACHABLE, err)
    } finally {
      bounds.release()
    }
  }

  /**
   * Sends one `/ai/complete` request; every expected failure leaves as an `AiProviderError`. An
   * access token the proxy refuses (expired between the check and the call) is replaced once,
   * with the same idempotency key, so the retry can never be charged twice.
   */
  const send = async (request: CompletionRequest, stream: boolean): Promise<Response> => {
    if (!available) throw new AiCloudUnavailableError(NOT_AVAILABLE)
    const token = options.token()
    if (token === null) throw new AiSignedOutError(SIGNED_OUT)
    const body = bodyFor(request, stream)
    const key = (options.idempotencyKey ?? randomUUID)()
    const bearer = await bearerFor(token)
    let response = await post(request, body, bearer, key)
    if (response.status === 401 && bearer !== token) {
      await response.text().catch(() => '')
      options.invalidateBearer?.()
      response = await post(request, body, await bearerFor(token), key)
    }
    if (!response.ok) throw failureBody(await response.text().catch(() => ''))
    return response
  }

  return {
    id: 'cloud',
    resolveModel: options.resolveModel,
    price: (model, inTok, outTok, cachedTok) =>
      hostedPriceFor(options.pricing?.() ?? bundledPricing(), model, inTok, outTok, cachedTok),

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
      if (!available) throw new AiCloudUnavailableError(NOT_AVAILABLE)
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
