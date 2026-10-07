/**
 * The account routes (F-15.2): start a sign-in, verify the emailed link or code, hand the session
 * to the app that is polling, refresh an access token, report who a session belongs to, and sign
 * out. Every handler is pure over `AuthDeps`, so the tests inject the store, the mailer, the
 * clock, and the randomness.
 *
 * Tokens (AI-BILLING-SPEC A5, S6): the session token is the long-lived, revocable refresh token;
 * `POST /auth/refresh` trades it for a short-lived access token (`ACCESS_TOKEN_TTL_MS`), and a
 * completed sign-in hands the first one over with the session. Revoking the session ends every
 * access token minted from it at once. Until the app switches to access tokens, a session token
 * is still accepted as the bearer itself.
 *
 * Secrets (poll secret, link token, code, session and access tokens) exist in the clear only in
 * the response or email that hands them out; the store keeps SHA-256 hashes.
 */
import {
  type AccessToken,
  ACCESS_TOKEN_TTL_MS,
  AuthCodeBody,
  type AuthMeResult,
  AuthPollBody,
  type AuthPollResult,
  AuthRefreshBody,
  type AuthRefreshResult,
  AuthStartBody,
  type AuthStartResult,
  CLOUD_ERROR_STATUS,
  type CloudErrorCode,
  LOGIN_ATTEMPT_TTL_MS,
  LOGIN_CODE_DIGITS,
  LOGIN_CODE_MAX_FAILURES,
  SESSION_TTL_MS,
  START_RATE_LIMIT,
  TOKEN_BYTES
} from '../../src/shared/cloudApi'
import { usdToMicros } from '../../src/shared/cloudBilling'
import { loadBillingConfig } from './config'
import { sha256Hex, timingSafeEqualHex } from './crypto'
import { signInEmail, type Mailer } from './email'
import { LINK_EXPIRED_PAGE, pageResponse, SIGNED_IN_PAGE } from './pages'
import {
  type LoginAttemptRow,
  plainEntry,
  type SessionRow,
  type Store,
  type UserRow
} from './store'

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
const WRONG_CODE = 'That code is not the one in the email. Check it and try again.'
/** The one answer for a missing, unknown, expired, or revoked session; shared by every bearer route. */
export const UNAUTHORIZED_MESSAGE = 'Your MythScribe session has ended. Sign in again to continue.'

export async function readJson(request: Request): Promise<unknown> {
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

/**
 * A `LOGIN_CODE_DIGITS`-digit code from fresh randomness. Derived through a digest so the tests'
 * deterministic `random` still yields digits; the modulo bias over 48 bits is negligible.
 */
async function loginCode(deps: AuthDeps): Promise<string> {
  const digest = await sha256Hex(deps.random(TOKEN_BYTES))
  const n = parseInt(digest.slice(0, 12), 16) % 10 ** LOGIN_CODE_DIGITS
  return String(n).padStart(LOGIN_CODE_DIGITS, '0')
}

/** `POST /auth/start`: create the attempt and email the link and the code. */
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
  const code = await loginCode(deps)
  const expiresAt = now + LOGIN_ATTEMPT_TTL_MS
  await deps.store.insertLoginAttempt({
    id: attemptId,
    email,
    pollSecretHash: await sha256Hex(pollSecret),
    linkTokenHash: await sha256Hex(linkToken),
    codeHash: await sha256Hex(code),
    codeFailures: 0,
    status: 'pending',
    sessionToken: null,
    userId: null,
    createdAt: now,
    expiresAt
  })

  const origin = deps.publicOrigin ?? new URL(request.url).origin
  const link = `${origin}/auth/verify?t=${encodeURIComponent(linkToken)}`
  await mailer.send(signInEmail(email, link, code))

  const result: AuthStartResult = {
    attemptId,
    pollSecret,
    expiresAt: new Date(expiresAt).toISOString(),
    ...(deps.revealLink ? { devLink: link } : {})
  }
  return jsonResponse(result)
}

/**
 * The trial grant (AI-BILLING-SPEC M7): once per verified email address, keyed by the address's
 * digest so a deleted and re-created account cannot claim it twice. Every verified sign-in asks;
 * the ledger's unique key makes every ask after the first a no-op.
 */
async function grantTrial(deps: AuthDeps, user: UserRow, now: number): Promise<void> {
  const config = await loadBillingConfig(deps.store)
  const amountMicros = usdToMicros(config.trialGrantUsd)
  if (amountMicros <= 0) return
  await deps.store.appendLedgerEntry(
    plainEntry({
      id: deps.random(TOKEN_BYTES),
      userId: user.id,
      type: 'trial_grant',
      amountMicros,
      idempotencyKey: `trial_grant:${await sha256Hex(user.email)}`,
      createdAt: now
    })
  )
}

/** A verified sign-in, by link or by code: the account (created on first sign-in) and a session. */
async function completeSignIn(
  attempt: LoginAttemptRow,
  deps: AuthDeps,
  now: number
): Promise<{ user: UserRow; sessionToken: string }> {
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
  await grantTrial(deps, user, now)
  return { user, sessionToken }
}

/** A fresh short-lived access token for the session whose hash is `sessionHash`. */
async function mintAccess(
  deps: AuthDeps,
  sessionHash: string,
  userId: string,
  now: number
): Promise<AccessToken> {
  const token = deps.random(TOKEN_BYTES)
  const expiresAt = now + ACCESS_TOKEN_TTL_MS
  await deps.store.insertAccessToken({
    tokenHash: await sha256Hex(token),
    sessionHash,
    userId,
    createdAt: now,
    expiresAt
  })
  return { token, expiresAt: new Date(expiresAt).toISOString() }
}

/** The `ready` answer: the session (the refresh token) and its first access token. */
async function readyResult(
  deps: AuthDeps,
  attempt: LoginAttemptRow,
  userId: string,
  sessionToken: string,
  now: number
): Promise<AuthPollResult> {
  return {
    status: 'ready',
    session: { token: sessionToken, email: attempt.email, userId },
    access: await mintAccess(deps, await sha256Hex(sessionToken), userId, now)
  }
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

  const { user, sessionToken } = await completeSignIn(attempt, deps, now)
  await deps.store.approveAttempt(attempt.id, user.id, sessionToken)

  return pageResponse(SIGNED_IN_PAGE, 200)
}

/** The attempt behind an attempt id and poll secret; null for either being wrong. */
async function ownAttempt(
  deps: AuthDeps,
  body: { attemptId: string; pollSecret: string }
): Promise<LoginAttemptRow | null> {
  const attempt = await deps.store.findAttemptById(body.attemptId)
  if (!attempt) return null
  const offered = await sha256Hex(body.pollSecret)
  return timingSafeEqualHex(offered, attempt.pollSecretHash) ? attempt : null
}

/** `POST /auth/poll`: the app's side of the link; hands the session over exactly once. */
export async function handlePoll(request: Request, deps: AuthDeps): Promise<Response> {
  const parsed = AuthPollBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('NOT_FOUND', NOT_FOUND_ATTEMPT)

  // A wrong secret answers exactly like an unknown id, so attempt ids cannot be probed.
  const attempt = await ownAttempt(deps, parsed.data)
  if (!attempt) return jsonError('NOT_FOUND', NOT_FOUND_ATTEMPT)

  const now = deps.now().getTime()
  if (attempt.expiresAt <= now || attempt.status === 'claimed') {
    return jsonResponse({ status: 'expired' } satisfies AuthPollResult)
  }
  if (attempt.status === 'approved' && attempt.sessionToken && attempt.userId) {
    await deps.store.claimAttempt(attempt.id)
    return jsonResponse(await readyResult(deps, attempt, attempt.userId, attempt.sessionToken, now))
  }
  return jsonResponse({ status: 'pending' } satisfies AuthPollResult)
}

/**
 * `POST /auth/verify` (A5): the code from the email instead of the link. Only the app that
 * started the attempt (it holds the poll secret) can spend it; `LOGIN_CODE_MAX_FAILURES` wrong
 * codes spend the attempt. A right code signs in and hands the session over at once.
 */
export async function handleVerifyCode(request: Request, deps: AuthDeps): Promise<Response> {
  const parsed = AuthCodeBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('BAD_REQUEST', WRONG_CODE)

  const attempt = await ownAttempt(deps, parsed.data)
  if (!attempt) return jsonError('NOT_FOUND', NOT_FOUND_ATTEMPT)

  const now = deps.now().getTime()
  const { codeHash } = attempt
  const spent =
    attempt.expiresAt <= now ||
    attempt.status === 'claimed' ||
    attempt.codeFailures >= LOGIN_CODE_MAX_FAILURES
  if (spent || codeHash === null)
    return jsonResponse({ status: 'expired' } satisfies AuthPollResult)

  if (!timingSafeEqualHex(await sha256Hex(parsed.data.code), codeHash)) {
    const failures = await deps.store.recordCodeFailure(attempt.id)
    if (failures >= LOGIN_CODE_MAX_FAILURES) {
      return jsonResponse({ status: 'expired' } satisfies AuthPollResult)
    }
    return jsonError('BAD_REQUEST', WRONG_CODE)
  }

  // The link may have been opened already; its session is the one to hand over then.
  if (attempt.status === 'approved' && attempt.sessionToken && attempt.userId) {
    await deps.store.claimAttempt(attempt.id)
    return jsonResponse(await readyResult(deps, attempt, attempt.userId, attempt.sessionToken, now))
  }
  const { user, sessionToken } = await completeSignIn(attempt, deps, now)
  await deps.store.claimAttempt(attempt.id)
  return jsonResponse(await readyResult(deps, attempt, user.id, sessionToken, now))
}

/** A session that may still be used: not revoked, not expired. */
function isLive(session: SessionRow | null, now: number): session is SessionRow {
  return session !== null && session.revokedAt === null && session.expiresAt > now
}

/** `POST /auth/refresh` (A5, S6): a new access token for a live session. */
export async function handleRefresh(request: Request, deps: AuthDeps): Promise<Response> {
  const parsed = AuthRefreshBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const now = deps.now().getTime()
  const sessionHash = await sha256Hex(parsed.data.refreshToken)
  const session = await deps.store.findSessionByHash(sessionHash)
  if (!isLive(session, now)) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  await deps.store.touchSession(sessionHash, now)
  return jsonResponse({
    access: await mintAccess(deps, sessionHash, session.userId, now)
  } satisfies AuthRefreshResult)
}

/** Who a `Authorization: Bearer` request is; `null` for every reason a caller must not tell apart. */
export interface Caller {
  session: SessionRow
  user: UserRow
  /** The hash of the session (refresh token) behind the bearer. */
  tokenHash: string
}

/**
 * The session a bearer belongs to: an access token's parent session (the access token must not
 * have expired), or — until the app switches to access tokens — the session token itself.
 */
async function sessionHashFor(deps: AuthDeps, token: string, now: number): Promise<string | null> {
  const tokenHash = await sha256Hex(token)
  const access = await deps.store.findAccessTokenByHash(tokenHash)
  if (access === null) return tokenHash
  return access.expiresAt > now ? access.sessionHash : null
}

/**
 * The bearer check every signed-in route shares (F-15.3 added `/credits` and the checkout):
 * resolve the token to its user and refresh `last_seen_at`. `null` means answer UNAUTHORIZED —
 * missing, unknown, expired, and revoked are deliberately indistinguishable.
 */
export async function authenticate(request: Request, deps: AuthDeps): Promise<Caller | null> {
  const token = bearerToken(request)
  if (!token) return null

  const now = deps.now().getTime()
  const tokenHash = await sessionHashFor(deps, token, now)
  if (tokenHash === null) return null
  const session = await deps.store.findSessionByHash(tokenHash)
  if (!isLive(session, now)) return null
  const user = await deps.store.findUserById(session.userId)
  if (!user) return null

  await deps.store.touchSession(tokenHash, now)
  return { session, user, tokenHash }
}

/** `GET /auth/me`: who this session belongs to; also refreshes `last_seen_at`. */
export async function handleMe(request: Request, deps: AuthDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  return jsonResponse({
    email: caller.user.email,
    userId: caller.user.id,
    since: new Date(caller.session.createdAt).toISOString()
  } satisfies AuthMeResult)
}

/**
 * `POST /auth/signout`: revoke the session server-side — the bearer's own, or the one an access
 * token was minted from, which ends all its access tokens too; 204 whether or not it was known.
 */
export async function handleSignOut(request: Request, deps: AuthDeps): Promise<Response> {
  const token = bearerToken(request)
  if (token) {
    const tokenHash = await sha256Hex(token)
    const access = await deps.store.findAccessTokenByHash(tokenHash)
    await deps.store.revokeSession(access?.sessionHash ?? tokenHash, deps.now().getTime())
  }
  return new Response(null, { status: 204 })
}
