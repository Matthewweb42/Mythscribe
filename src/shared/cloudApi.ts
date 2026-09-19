import { z } from 'zod'
import { AiFeatureId, ModelName } from './ai'

/**
 * The wire contract between the desktop app and the MythScribe Cloud Worker (F-15.2), imported
 * by both sides (`src/main/account/` and `cloud/src/`) so a route's body is defined once.
 * Nothing here carries manuscript text; the auth routes see an email address and opaque tokens,
 * the credit routes (F-15.3) amounts and feature ids.
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

/**
 * Credits (F-15.3). Every amount is an integer in micro-USD (1e-6 USD, `MICROS_PER_USD` in
 * `cloudRates.ts`); a $5 pack is 5_000_000. The app shows dollars.
 */

/** A pack on sale: one Lemon Squeezy variant, `priceCents` paid = the same amount of credit. */
export const CreditPack = z.object({
  variantId: z.string().min(1),
  priceCents: z.number().int().positive()
})
export type CreditPack = z.infer<typeof CreditPack>

/** Spend on one AI feature (`AiFeatureId`, kept as a string on the wire) since the account was created. */
export const CreditSpendRow = z.object({
  feature: z.string().min(1),
  micros: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative()
})
export type CreditSpendRow = z.infer<typeof CreditSpendRow>

/** `GET /credits` with `Authorization: Bearer <token>` */
export const CreditsResult = z.object({
  /** May be slightly negative: the last request is charged after it was answered. */
  balanceMicros: z.number().int(),
  spend: z.array(CreditSpendRow),
  /** Empty until the operator configures the packs on the Worker. */
  packs: z.array(CreditPack)
})
export type CreditsResult = z.infer<typeof CreditsResult>

/** `POST /billing/checkout` with the same header */
export const CheckoutBody = z.object({ variantId: z.string().min(1) })
export type CheckoutBody = z.infer<typeof CheckoutBody>

export const CheckoutResult = z.object({ url: z.string().url() })
export type CheckoutResult = z.infer<typeof CheckoutResult>

/** Where a checkout may send the author: Lemon Squeezy's hosted checkout over https, nothing else. */
export const CHECKOUT_HOST_SUFFIX = '.lemonsqueezy.com'

export function isCheckoutUrl(url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  return parsed.protocol === 'https:' && parsed.hostname.endsWith(CHECKOUT_HOST_SUFFIX)
}

/** `POST /billing/lemonsqueezy`: the Lemon Squeezy webhook; signed with `X-Signature`, no bearer. */

export const CloudErrorCode = z.enum([
  'INVALID_EMAIL',
  /** The proxy could not read the body, or it asks for a model or a size the proxy refuses (F-15.4). */
  'BAD_REQUEST',
  'RATE_LIMITED',
  /** No mail transport is configured on the Worker (the Resend secret is missing). */
  'NOT_CONFIGURED',
  'UNAUTHORIZED',
  'NOT_FOUND',
  /** The webhook body was not signed with the Worker's Lemon Squeezy secret (F-15.3). */
  'BAD_SIGNATURE',
  /** The balance is at or below zero (F-15.3); the proxy refuses the request (F-15.4). */
  'INSUFFICIENT_CREDITS',
  /** The model provider behind the proxy failed (F-15.4); the message never echoes the request. */
  'UPSTREAM',
  'INTERNAL'
])
export type CloudErrorCode = z.infer<typeof CloudErrorCode>

/** Every non-2xx answer from the Worker is this JSON body. */
export const CloudApiError = z.object({ code: CloudErrorCode, message: z.string() })
export type CloudApiError = z.infer<typeof CloudApiError>

/** The HTTP status each error code answers with; one table so the Worker and its tests agree. */
export const CLOUD_ERROR_STATUS: Record<CloudErrorCode, number> = {
  INVALID_EMAIL: 400,
  BAD_REQUEST: 400,
  RATE_LIMITED: 429,
  NOT_CONFIGURED: 503,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  BAD_SIGNATURE: 401,
  INSUFFICIENT_CREDITS: 402,
  UPSTREAM: 502,
  INTERNAL: 500
}

/**
 * The AI proxy (F-15.4). One route, `POST /ai/complete`, with `Authorization: Bearer <session>`:
 * the app sends the resolved model, the messages, and the caps; the Worker relays them to the
 * provider with the operator's key, charges the account's credits after the answer, and stores
 * none of it. A non-streamed answer is `AiCompleteResult` as JSON; a streamed one is NDJSON
 * (`AI_STREAM_CONTENT_TYPE`), one `AiStreamEvent` per line.
 */

/** Hard caps the proxy refuses beyond, so one request can never run long or carry a manuscript. */
export const AI_COMPLETE_MAX_TOKENS = 4_000
export const AI_COMPLETE_MAX_CHARS = 200_000
export const AI_COMPLETE_MAX_MESSAGES = 64

export const AiCompleteMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string()
})
export type AiCompleteMessage = z.infer<typeof AiCompleteMessage>

export const AiCompleteBody = z
  .object({
    /** The `AiFeatureId` that is spending, so the ledger and the Account tab break spend down by feature. */
    feature: AiFeatureId,
    /** Resolved by the app (F-5.11); the Worker refuses a model outside the published rate table. */
    model: ModelName,
    messages: z.array(AiCompleteMessage).min(1).max(AI_COMPLETE_MAX_MESSAGES),
    maxTokens: z.number().int().min(1).max(AI_COMPLETE_MAX_TOKENS),
    json: z.boolean().optional(),
    temperature: z.number().min(0).max(2).optional(),
    stream: z.boolean()
  })
  .refine(
    (body) => body.messages.reduce((sum, m) => sum + m.content.length, 0) <= AI_COMPLETE_MAX_CHARS,
    `The messages are longer than ${AI_COMPLETE_MAX_CHARS} characters`
  )
export type AiCompleteBody = z.infer<typeof AiCompleteBody>

/** What the provider answered plus the meter's receipt: what it cost and what is left. */
export const AiCompleteResult = z.object({
  text: z.string(),
  /** The model that actually answered; the charge is at its published rate. */
  model: ModelName,
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative()
  }),
  /** Micro-USD taken off the balance for this request; at least 1 (`cloudChargeMicros`). */
  chargeMicros: z.number().int().min(1),
  /** The balance after the charge; may be slightly negative, since the charge lands afterwards. */
  balanceMicros: z.number().int()
})
export type AiCompleteResult = z.infer<typeof AiCompleteResult>

/** One line of a streamed answer: text as it arrives, then exactly one `done` or one `error`. */
export const AiStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('delta'), delta: z.string() }),
  z.object({
    type: z.literal('done'),
    model: ModelName,
    usage: AiCompleteResult.shape.usage,
    chargeMicros: AiCompleteResult.shape.chargeMicros,
    balanceMicros: z.number().int()
  }),
  /** The upstream failed after the headers were sent, so the status is already 200. */
  z.object({ type: z.literal('error'), code: CloudErrorCode, message: z.string() })
])
export type AiStreamEvent = z.infer<typeof AiStreamEvent>

export const AI_STREAM_CONTENT_TYPE = 'application/x-ndjson'
