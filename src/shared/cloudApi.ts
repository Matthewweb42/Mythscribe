import { z } from 'zod'

/**
 * The wire contract between the desktop app and the MythScribe Cloud Worker (F-15.2), imported
 * by both sides (`src/main/account/` and `cloud/src/`) so a route's body is defined once.
 * Nothing here carries manuscript text; the auth routes see an email address and opaque tokens.
 */

/** Where the app sends Cloud requests; `MYTHSCRIBE_CLOUD_API_URL` overrides it for dev and e2e. */
export const CLOUD_API_URL = 'https://api.mythscribe.app'

/** RFC 5321 mailbox length; the Worker lower-cases and trims before storing. */
export const EMAIL_MAX = 254
/** A sign-in link is usable for this long after the email is sent. */
export const LOGIN_ATTEMPT_TTL_MS = 15 * 60_000
/** A session lives this long from sign-in; `/auth/me` refreshes `lastSeenAt`, not the expiry. */
export const SESSION_TTL_MS = 90 * 24 * 60 * 60_000
/** How often the app asks whether a pending attempt was approved. */
export const POLL_INTERVAL_MS = 3000
/** `/auth/start` calls allowed per email address within one attempt lifetime. */
export const START_RATE_LIMIT = 3
/** Bytes of randomness in every token (attempt id, poll secret, link token, session token). */
export const TOKEN_BYTES = 32

const trimmedEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX)
  .regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Enter a valid email address')

/** `POST /auth/start` */
export const AuthStartBody = z.object({ email: trimmedEmail })
export type AuthStartBody = z.infer<typeof AuthStartBody>

export const AuthStartResult = z.object({
  attemptId: z.string().min(1),
  pollSecret: z.string().min(1),
  /** ISO timestamp after which the link no longer works. */
  expiresAt: z.string().min(1),
  /** Only when the Worker runs with the `log` mail transport (local dev): the link itself. */
  devLink: z.string().optional()
})
export type AuthStartResult = z.infer<typeof AuthStartResult>

/** What the app keeps after a sign-in; the token is the only secret and never leaves safeStorage. */
export const CloudSession = z.object({
  token: z.string().min(1),
  email: trimmedEmail,
  userId: z.string().min(1)
})
export type CloudSession = z.infer<typeof CloudSession>

/** `POST /auth/poll` */
export const AuthPollBody = z.object({
  attemptId: z.string().min(1),
  pollSecret: z.string().min(1)
})
export type AuthPollBody = z.infer<typeof AuthPollBody>

export const AuthPollResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  /** Handed over exactly once; the Worker wipes the session from the attempt afterwards. */
  z.object({ status: z.literal('ready'), session: CloudSession }),
  z.object({ status: z.literal('expired') })
])
export type AuthPollResult = z.infer<typeof AuthPollResult>

/** `GET /auth/me` with `Authorization: Bearer <token>` */
export const AuthMeResult = z.object({
  email: trimmedEmail,
  userId: z.string().min(1),
  /** ISO timestamp of the sign-in that minted this session. */
  since: z.string().min(1)
})
export type AuthMeResult = z.infer<typeof AuthMeResult>

/** `POST /auth/signout` with the same header; answers 204. */

export const CloudErrorCode = z.enum([
  'INVALID_EMAIL',
  'RATE_LIMITED',
  /** No mail transport is configured on the Worker (the Resend secret is missing). */
  'NOT_CONFIGURED',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'INTERNAL'
])
export type CloudErrorCode = z.infer<typeof CloudErrorCode>

/** Every non-2xx answer from the Worker is this JSON body. */
export const CloudApiError = z.object({ code: CloudErrorCode, message: z.string() })
export type CloudApiError = z.infer<typeof CloudApiError>

/** The HTTP status each error code answers with; one table so the Worker and its tests agree. */
export const CLOUD_ERROR_STATUS: Record<CloudErrorCode, number> = {
  INVALID_EMAIL: 400,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  INTERNAL: 500
}
