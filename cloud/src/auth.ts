/**
 * The account routes (F-15.2): start a sign-in, verify the emailed link, hand the session to the
 * app that is polling, report who a session belongs to, and sign out. Every handler is pure over
 * `AuthDeps`, so the tests inject the store, the mailer, the clock, and the randomness.
 *
 * Secrets (poll secret, link token, session token) exist in the clear only in the response that
 * hands them out; the store keeps SHA-256 hashes.
 */
import {
  type AuthMeResult,
  AuthPollBody,
  type AuthPollResult,
  AuthStartBody,
  type AuthStartResult,
  CLOUD_ERROR_STATUS,
  type CloudErrorCode,
  LOGIN_ATTEMPT_TTL_MS,
  SESSION_TTL_MS,
  START_RATE_LIMIT,
  TOKEN_BYTES
} from '../../src/shared/cloudApi'
import { sha256Hex, timingSafeEqualHex } from './crypto'
import { signInEmail, type Mailer } from './email'
import { LINK_EXPIRED_PAGE, pageResponse, SIGNED_IN_PAGE } from './pages'
import type { Store } from './store'

export interface AuthDeps {
  store: Store
  /** Absent when no mail transport is configured: `/auth/start` then answers NOT_CONFIGURED. */
  mailer: Mailer | null
  now: () => Date
  random: (bytes: number) => string
  /** Local `log` transport only: return the link in the `/auth/start` body. */
  revealLink: boolean
  /**
   * The origin sign-in links are built on when the request URL cannot be trusted for it:
   * `wrangler dev` stamps every request with the configured route hostname, so `.dev.vars` sets
   * `PUBLIC_ORIGIN=http://127.0.0.1:8787`. Absent in production, where the request origin is right.
   */
  publicOrigin?: string
}

/** A JSON body with the app's content type; the router adds `no-store`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  })
}

/** Every non-2xx answer is a `CloudApiError`; the status comes from the shared table. */
export function jsonError(code: CloudErrorCode, message: string): Response {
  return jsonResponse({ code, message }, CLOUD_ERROR_STATUS[code])
}

const NOT_FOUND_ATTEMPT = 'That sign-in attempt is no longer available. Send yourself a new link.'
const UNAUTHORIZED_MESSAGE = 'Your MythScribe session has ended. Sign in again to continue.'

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json()
  } catch {
    return null
  }
}

function bearerToken(request: Request): string | null {
  const header = request.headers.get('Authorization')
  if (!header) return null
  const match = /^Bearer (.+)$/.exec(header.trim())
  return match?.[1] ?? null
}

/** `POST /auth/start`: create the attempt and email the link. */
export async function handleStart(request: Request, deps: AuthDeps): Promise<Response> {
  const parsed = AuthStartBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('INVALID_EMAIL', 'Enter a valid email address.')
  const { mailer } = deps
  if (!mailer) {
    return jsonError('NOT_CONFIGURED', 'Sign-in email is not configured on the server yet.')
  }

  const email = parsed.data.email
  const now = deps.now().getTime()
  const recent = await deps.store.countAttemptsSince(email, now - LOGIN_ATTEMPT_TTL_MS)
  if (recent >= START_RATE_LIMIT) {
    return jsonError(
      'RATE_LIMITED',
      'Too many sign-in emails for this address. Wait 15 minutes and try again.'
    )
  }

  const attemptId = deps.random(TOKEN_BYTES)
  const pollSecret = deps.random(TOKEN_BYTES)
  const linkToken = deps.random(TOKEN_BYTES)
  const expiresAt = now + LOGIN_ATTEMPT_TTL_MS
  await deps.store.insertLoginAttempt({
    id: attemptId,
    email,
    pollSecretHash: await sha256Hex(pollSecret),
    linkTokenHash: await sha256Hex(linkToken),
    status: 'pending',
    sessionToken: null,
    userId: null,
    createdAt: now,
    expiresAt
  })

  const origin = deps.publicOrigin ?? new URL(request.url).origin
  const link = `${origin}/auth/verify?t=${encodeURIComponent(linkToken)}`
  await mailer.send(signInEmail(email, link))

  const result: AuthStartResult = {
    attemptId,
    pollSecret,
    expiresAt: new Date(expiresAt).toISOString(),
    ...(deps.revealLink ? { devLink: link } : {})
  }
  return jsonResponse(result)
}

/** `GET /auth/verify?t=`: single-use; approves the attempt and renders a page, never a token. */
export async function handleVerify(request: Request, deps: AuthDeps): Promise<Response> {
  const token = new URL(request.url).searchParams.get('t')
  if (!token) return pageResponse(LINK_EXPIRED_PAGE, 410)

  const now = deps.now().getTime()
  const attempt = await deps.store.findAttemptByLinkHash(await sha256Hex(token))
  if (!attempt) return pageResponse(LINK_EXPIRED_PAGE, 410)
  // Single use: only a pending attempt inside its window approves.
  if (attempt.status !== 'pending' || attempt.expiresAt <= now) {
    return pageResponse(LINK_EXPIRED_PAGE, 410)
  }

  let user = await deps.store.findUserByEmail(attempt.email)
  if (!user) {
    user = { id: deps.random(TOKEN_BYTES), email: attempt.email, createdAt: now }
    await deps.store.insertUser(user)
  }

  const sessionToken = deps.random(TOKEN_BYTES)
  await deps.store.insertSession({
    tokenHash: await sha256Hex(sessionToken),
    userId: user.id,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS,
    lastSeenAt: now,
    revokedAt: null
  })
  await deps.store.approveAttempt(attempt.id, user.id, sessionToken)

  return pageResponse(SIGNED_IN_PAGE, 200)
}

/** `POST /auth/poll`: the app's side of the link; hands the session over exactly once. */
export async function handlePoll(request: Request, deps: AuthDeps): Promise<Response> {
  const parsed = AuthPollBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('NOT_FOUND', NOT_FOUND_ATTEMPT)

  const attempt = await deps.store.findAttemptById(parsed.data.attemptId)
  // A wrong secret answers exactly like an unknown id, so attempt ids cannot be probed.
  if (!attempt) return jsonError('NOT_FOUND', NOT_FOUND_ATTEMPT)
  const offered = await sha256Hex(parsed.data.pollSecret)
  if (!timingSafeEqualHex(offered, attempt.pollSecretHash)) {
    return jsonError('NOT_FOUND', NOT_FOUND_ATTEMPT)
  }

  const now = deps.now().getTime()
  if (attempt.expiresAt <= now || attempt.status === 'claimed') {
    return jsonResponse({ status: 'expired' } satisfies AuthPollResult)
  }
  if (attempt.status === 'approved' && attempt.sessionToken && attempt.userId) {
    await deps.store.claimAttempt(attempt.id)
    return jsonResponse({
      status: 'ready',
      session: { token: attempt.sessionToken, email: attempt.email, userId: attempt.userId }
    } satisfies AuthPollResult)
  }
  return jsonResponse({ status: 'pending' } satisfies AuthPollResult)
}

/** `GET /auth/me`: who this session belongs to; also refreshes `last_seen_at`. */
export async function handleMe(request: Request, deps: AuthDeps): Promise<Response> {
  const token = bearerToken(request)
  if (!token) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const tokenHash = await sha256Hex(token)
  const now = deps.now().getTime()
  const session = await deps.store.findSessionByHash(tokenHash)
  if (!session) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)
  if (session.revokedAt !== null || session.expiresAt <= now) {
    return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)
  }
  const user = await deps.store.findUserById(session.userId)
  if (!user) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  await deps.store.touchSession(tokenHash, now)
  return jsonResponse({
    email: user.email,
    userId: user.id,
    since: new Date(session.createdAt).toISOString()
  } satisfies AuthMeResult)
}

/** `POST /auth/signout`: revoke server-side; 204 whether or not the token was known. */
export async function handleSignOut(request: Request, deps: AuthDeps): Promise<Response> {
  const token = bearerToken(request)
  if (token) {
    await deps.store.revokeSession(await sha256Hex(token), deps.now().getTime())
  }
  return new Response(null, { status: 204 })
}
