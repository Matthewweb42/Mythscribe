import type { z } from 'zod'
import {
  AuthMeResult,
  AuthPollBody,
  AuthPollResult,
  AuthStartBody,
  AuthStartResult,
  CloudApiError,
  type CloudErrorCode
} from '@shared/cloudApi'
// The `fetch` shape is already defined once for the provider adapter; a type-only import, so
// nothing of the OpenAI SDK reaches this module graph.
import type { FetchLike } from '../ai/providers/openai'

/**
 * The typed client for the four MythScribe Cloud auth routes (F-15.2). It owns the wire: every
 * 2xx body is parsed with the shared zod schemas, every other answer is parsed as `CloudApiError`,
 * and both failure paths leave as an `AccountError` carrying author-facing copy. It knows nothing
 * about state: `AccountService` owns the session and the poll timer.
 */

/** Everything that can go wrong for the author, whether the Worker said so or the network did. */
export type AccountErrorCode = CloudErrorCode | 'NETWORK' | 'PROTOCOL'

/** Fixed copy per failure; the Worker's own message is used only where it knows more (below). */
const MESSAGES: Record<AccountErrorCode, string> = {
  INVALID_EMAIL: 'Enter a valid email address.',
  RATE_LIMITED: 'Too many sign-in links were requested for this address.',
  NOT_CONFIGURED: 'MythScribe Cloud cannot send sign-in emails right now.',
  UNAUTHORIZED: 'This MythScribe Cloud sign-in is no longer valid.',
  NOT_FOUND: 'MythScribe Cloud does not know this sign-in attempt.',
  INTERNAL: 'MythScribe Cloud had a problem with the request.',
  NETWORK: 'Could not reach MythScribe Cloud.',
  PROTOCOL: 'MythScribe Cloud sent an answer MythScribe could not read.'
}

const NEXT_STEPS: Record<AccountErrorCode, string> = {
  INVALID_EMAIL: 'Check the address and try again.',
  RATE_LIMITED: 'Open the last email, or wait 15 minutes.',
  NOT_CONFIGURED: 'Try again later.',
  UNAUTHORIZED: 'Sign in again.',
  NOT_FOUND: 'Ask for a new sign-in link.',
  INTERNAL: 'Try again in a moment.',
  NETWORK: 'Check your connection and try again.',
  PROTOCOL: 'Try again; if it keeps happening, update MythScribe.'
}

/** Codes whose server message says more than fixed copy can (the 503 names what is missing). */
const PASS_THROUGH: ReadonlySet<CloudErrorCode> = new Set<CloudErrorCode>([
  'INVALID_EMAIL',
  'NOT_CONFIGURED'
])

const TIMEOUT_MESSAGE = 'MythScribe Cloud did not answer in time.'

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
  /** Who this session belongs to; UNAUTHORIZED means it was revoked or expired. */
  me(token: string): Promise<AuthMeResult>
  /** Revokes the session server-side; answers 204 with no body. */
  signOut(token: string): Promise<void>
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
  const send = async (path: string, init: RequestInit): Promise<string> => {
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
    if (!response.ok) throw failureOf(text)
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
    async me(token) {
      return parseBody(
        AuthMeResult,
        await send('/auth/me', { method: 'GET', headers: bearer(token) })
      )
    },
    async signOut(token) {
      await send('/auth/signout', { method: 'POST', headers: bearer(token) })
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

/** Maps a non-2xx body to the failure the author sees; an unreadable one is PROTOCOL. */
function failureOf(text: string): AccountError {
  const parsed = CloudApiError.safeParse(parseJson(text))
  if (!parsed.success) return accountError('PROTOCOL', parsed.error)
  const { code, message } = parsed.data
  const passed = PASS_THROUGH.has(code) && message.trim() !== ''
  return new AccountError(code, passed ? message.trim() : MESSAGES[code], NEXT_STEPS[code])
}
