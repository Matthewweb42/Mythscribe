import type { z } from 'zod'
import {
  AuthMeResult,
  AuthPollBody,
  AuthPollResult,
  AuthRefreshBody,
  AuthRefreshResult,
  AuthStartBody,
  AuthStartResult,
  CheckoutBody,
  CheckoutResult,
  CloudApiError,
  CreditsResult,
  LicenseResult,
  RefundBody,
  RefundResult,
  UsageResult,
  type CloudErrorCode
} from '@shared/cloudApi'
// The `fetch` shape is already defined once for the provider adapter; a type-only import, so
// nothing of the OpenAI SDK reaches this module graph.
import type { FetchLike } from '../ai/providers/openai'

/**
 * The typed client for the MythScribe Cloud routes the app calls: the auth routes (F-15.2, with
 * `/auth/refresh` since AI-BILLING-SPEC A5), the credit routes (F-15.3), and `/usage` (E7). It
 * owns the wire: every 2xx body is parsed with the shared zod schemas, every other answer is
 * parsed as `CloudApiError`, and both failure paths leave as an `AccountError` carrying
 * author-facing copy. It knows nothing about state: `AccountService` owns the session and the
 * poll timer, and `withAccessTokens` (`accessTokens.ts`) swaps the bearer for an access token.
 */

/** Everything that can go wrong for the author, whether the Worker said so or the network did. */
export type AccountErrorCode = CloudErrorCode | 'NETWORK' | 'PROTOCOL'

/** Fixed copy per failure; the Worker's own message is used only where it knows more (below). */
const MESSAGES: Record<AccountErrorCode, string> = {
  INVALID_EMAIL: 'Enter a valid email address.',
  BAD_REQUEST: 'MythScribe Cloud refused the request.',
  RATE_LIMITED: 'Too many sign-in links were requested for this address.',
  REQUEST_TOO_LARGE: 'The request is longer than MythScribe Cloud accepts.',
  MODEL_UNAVAILABLE: 'That model is not available on MythScribe Cloud.',
  DUPLICATE_REQUEST: 'MythScribe Cloud already received this request.',
  STALE_WEBHOOK: 'MythScribe Cloud refused an outdated purchase notice.',
  NOT_CONFIGURED: 'MythScribe Cloud cannot send sign-in emails right now.',
  UNAUTHORIZED: 'This MythScribe Cloud sign-in is no longer valid.',
  NOT_FOUND: 'MythScribe Cloud does not know this sign-in attempt.',
  BAD_SIGNATURE: "MythScribe Cloud refused the request's signature.",
  INSUFFICIENT_CREDITS: 'Your MythScribe Cloud balance is used up.',
  NOT_ELIGIBLE: 'This account cannot do that.',
  UPSTREAM: 'The AI provider behind MythScribe Cloud did not answer.',
  INTERNAL: 'MythScribe Cloud had a problem with the request.',
  NETWORK: 'Could not reach MythScribe Cloud.',
  PROTOCOL: 'MythScribe Cloud sent an answer MythScribe could not read.'
}

const NEXT_STEPS: Record<AccountErrorCode, string> = {
  INVALID_EMAIL: 'Check the address and try again.',
  BAD_REQUEST: 'Try again; if it keeps happening, update MythScribe.',
  RATE_LIMITED: 'Open the last email, or wait 15 minutes.',
  REQUEST_TOO_LARGE: 'Send less text and try again.',
  MODEL_UNAVAILABLE: 'Choose another model in Settings › AI.',
  DUPLICATE_REQUEST: 'Try again in a moment.',
  STALE_WEBHOOK: 'Try again; if it keeps happening, update MythScribe.',
  NOT_CONFIGURED: 'Try again later.',
  UNAUTHORIZED: 'Sign in again.',
  NOT_FOUND: 'Ask for a new sign-in link.',
  BAD_SIGNATURE: 'Try again; if it keeps happening, update MythScribe.',
  INSUFFICIENT_CREDITS: 'Add to your balance in Settings › Account.',
  NOT_ELIGIBLE: 'Refresh the Account tab to see what is available.',
  UPSTREAM: 'Try again in a moment.',
  INTERNAL: 'Try again in a moment.',
  NETWORK: 'Check your connection and try again.',
  PROTOCOL: 'Try again; if it keeps happening, update MythScribe.'
}

/** Codes whose server message says more than fixed copy can (the 503 names what is missing). */
const PASS_THROUGH: ReadonlySet<CloudErrorCode> = new Set<CloudErrorCode>([
  'INVALID_EMAIL',
  'NOT_CONFIGURED',
  // 2026-10-08: the starter pack and refund refusals name exactly why (used, unverified, window).
  'NOT_ELIGIBLE'
])

const TIMEOUT_MESSAGE = 'MythScribe Cloud did not answer in time.'

/**
 * `NOT_FOUND` from `/billing/checkout` is about the pack, not a sign-in attempt (F-15.3), so the
 * shared copy for the code would misname it; the checkout call re-throws with these instead.
 */
const UNKNOWN_PACK_MESSAGE = 'That pack is no longer on sale.'
const UNKNOWN_PACK_NEXT_STEP = 'Refresh the packs and pick another.'

/** An expected failure of a Cloud call. `nextStep` is shown after `message`, never instead of it. */
export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
    readonly nextStep: string,
    cause?: unknown
  ) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AccountError'
  }
}

export function accountError(code: AccountErrorCode, cause?: unknown): AccountError {
  return new AccountError(code, MESSAGES[code], NEXT_STEPS[code], cause)
}

export interface CloudAuthClient {
  /** Asks the Worker to email a sign-in link; the answer carries the attempt and its poll secret. */
  start(email: string): Promise<AuthStartResult>
  /** Asks whether the attempt was approved yet; `ready` hands the session over exactly once. */
  poll(body: AuthPollBody): Promise<AuthPollResult>
  /**
   * A fresh short-lived access token for the session (AI-BILLING-SPEC A5, S6); `refreshToken` is
   * the session token. UNAUTHORIZED means the session was revoked or expired.
   */
  refresh(refreshToken: string): Promise<AuthRefreshResult>
  /** Who this session belongs to; UNAUTHORIZED means it was revoked or expired. */
  me(token: string): Promise<AuthMeResult>
  /** Revokes the session server-side; answers 204 with no body. */
  signOut(token: string): Promise<void>
  /** The account's credits (F-15.3): balance in micro-USD, spend per feature, packs on sale. */
  credits(token: string): Promise<CreditsResult>
  /** The Lemon Squeezy checkout URL for one pack (F-15.3); the Worker builds it, never the app. */
  checkout(token: string, variantId: string): Promise<CheckoutResult>
  /**
   * The account's Supporter license (F-15.9): a freshly signed token, or null when the account has
   * none, plus the product on sale. The signature is checked by `licenseVerifier.ts`, not here.
   */
  license(token: string): Promise<LicenseResult>
  /** One page of the account's ledger, newest first (AI-BILLING-SPEC E7, `GET /usage`). */
  usage(token: string, cursor: string | null): Promise<UsageResult>
  /**
   * Refund the unused balance of one purchase (2026-10-08, `POST /billing/refund`). Every refusal
   * of this route is about the refund, so the Worker's own message is shown for it.
   */
  refund(token: string, orderId: string): Promise<RefundResult>
}

/** No Cloud call may hang: the author is waiting on the Account tab for every one of them. */
export const CLOUD_REQUEST_TIMEOUT_MS = 15_000

export interface CloudAuthClientOptions {
  /** The Cloud API root, from `cloudApiUrl(process.env)`; a trailing slash is tolerated. */
  baseUrl: string
  fetch: FetchLike
  timeoutMs?: number
}

export function createCloudAuthClient({
  baseUrl,
  fetch,
  timeoutMs = CLOUD_REQUEST_TIMEOUT_MS
}: CloudAuthClientOptions): CloudAuthClient {
  const root = baseUrl.replace(/\/+$/, '')

  /** Sends one request and answers its body text, or throws the mapped `AccountError`. */
  const send = async (path: string, init: RequestInit, serverCopy = false): Promise<string> => {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    let response: Response
    try {
      response = await fetch(`${root}${path}`, { ...init, signal: controller.signal })
    } catch (err) {
      throw new AccountError(
        'NETWORK',
        timedOut ? TIMEOUT_MESSAGE : MESSAGES.NETWORK,
        NEXT_STEPS.NETWORK,
        err
      )
    } finally {
      clearTimeout(timer)
    }
    const text = await response.text().catch(() => '')
    if (!response.ok) throw failureOf(text, serverCopy)
    return text
  }

  const postJson = (path: string, body: unknown): Promise<string> =>
    send(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })

  const bearer = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` })

  return {
    async start(email) {
      // The address is checked here, so a typo costs no round trip and reads as INVALID_EMAIL.
      const body = AuthStartBody.safeParse({ email })
      if (!body.success) throw accountError('INVALID_EMAIL', body.error)
      return parseBody(AuthStartResult, await postJson('/auth/start', body.data))
    },
    async poll(body) {
      return parseBody(AuthPollResult, await postJson('/auth/poll', AuthPollBody.parse(body)))
    },
    async refresh(refreshToken) {
      return parseBody(
        AuthRefreshResult,
        await postJson('/auth/refresh', AuthRefreshBody.parse({ refreshToken }))
      )
    },
    async me(token) {
      return parseBody(
        AuthMeResult,
        await send('/auth/me', { method: 'GET', headers: bearer(token) })
      )
    },
    async signOut(token) {
      await send('/auth/signout', { method: 'POST', headers: bearer(token) })
    },
    async credits(token) {
      return parseBody(
        CreditsResult,
        await send('/credits', { method: 'GET', headers: bearer(token) })
      )
    },
    async checkout(token, variantId) {
      const body = CheckoutBody.parse({ variantId })
      try {
        return parseBody(
          CheckoutResult,
          await send('/billing/checkout', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...bearer(token) },
            body: JSON.stringify(body)
          })
        )
      } catch (err) {
        if (err instanceof AccountError && err.code === 'NOT_FOUND') {
          throw new AccountError('NOT_FOUND', UNKNOWN_PACK_MESSAGE, UNKNOWN_PACK_NEXT_STEP, err)
        }
        throw err
      }
    },
    async license(token) {
      return parseBody(
        LicenseResult,
        await send('/license', { method: 'GET', headers: bearer(token) })
      )
    },
    async usage(token, cursor) {
      const query = cursor === null ? '' : `?cursor=${encodeURIComponent(cursor)}`
      return parseBody(
        UsageResult,
        await send(`/usage${query}`, { method: 'GET', headers: bearer(token) })
      )
    },
    async refund(token, orderId) {
      const body = RefundBody.parse({ orderId })
      return parseBody(
        RefundResult,
        await send(
          '/billing/refund',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...bearer(token) },
            body: JSON.stringify(body)
          },
          true
        )
      )
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

/** A 2xx body that does not match its schema is a protocol failure, never silently accepted. */
function parseBody<S extends z.ZodType>(schema: S, text: string): z.output<S> {
  const parsed = schema.safeParse(parseJson(text))
  if (!parsed.success) throw accountError('PROTOCOL', parsed.error)
  return parsed.data
}

/**
 * Maps a non-2xx body to the failure the author sees; an unreadable one is PROTOCOL. `serverCopy`
 * shows the Worker's message for every code but UNAUTHORIZED (a route whose refusals are all its own).
 */
function failureOf(text: string, serverCopy = false): AccountError {
  const parsed = CloudApiError.safeParse(parseJson(text))
  if (!parsed.success) return accountError('PROTOCOL', parsed.error)
  const { code, message } = parsed.data
  const own = PASS_THROUGH.has(code) || (serverCopy && code !== 'UNAUTHORIZED')
  const passed = own && message.trim() !== ''
  return new AccountError(code, passed ? message.trim() : MESSAGES[code], NEXT_STEPS[code])
}
