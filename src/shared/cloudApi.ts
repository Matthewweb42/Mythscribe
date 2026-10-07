import { z } from 'zod'
import { AiFeatureId, ModelName } from './ai'
import { HostedModelId, HostedRouting, WordCostConstants } from './cloudBilling'
import { USAGE_PERIOD_DAYS } from './cloudUsage'
import {
  CrashReport,
  DIAGNOSTIC_QUEUE_MAX,
  DIAGNOSTIC_ROWS_MAX,
  DiagnosticCountRow,
  DiagnosticsEnvironment
} from './diagnostics'

/**
 * The wire contract between the desktop app and the MythScribe Cloud Worker (F-15.2), imported
 * by both sides (`src/main/account/` and `cloud/src/`) so a route's body is defined once.
 * Nothing here carries manuscript text; the auth routes see an email address and opaque tokens,
 * the credit routes (F-15.3) amounts and feature ids.
 */

/** Where the app sends Cloud requests; `MYTHSCRIBE_CLOUD_API_URL` overrides it for dev and e2e. */
export const CLOUD_API_URL = 'https://api.mythscribe.app'

/**
 * Whether MythScribe Cloud can serve AI requests (`/ai/complete`) yet. While false (decided by
 * the author 2026-10-07: own key until Cloud launches), the new-project wizard and Settings › AI
 * show the Cloud source disabled with "Coming soon", a project still stored on Cloud is told to
 * choose another source, and the Cloud adapter refuses before sending anything. Flip it to true
 * once the Worker with `/ai/complete` is deployed and the Lemon Squeezy store and packs exist.
 */
export const CLOUD_AI_AVAILABLE = false

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
/**
 * Short-lived access tokens (AI-BILLING-SPEC A5, S6): what `POST /auth/refresh` and a completed
 * sign-in mint for the bearer header. The session token is the revocable refresh token; revoking
 * it ends every access token minted from it at once.
 */
export const ACCESS_TOKEN_TTL_MS = 15 * 60_000
/** The sign-in email carries a code beside the link, for `POST /auth/verify` (A5). */
export const LOGIN_CODE_DIGITS = 6
/** Wrong codes allowed per sign-in attempt; the next one expires the attempt. */
export const LOGIN_CODE_MAX_FAILURES = 5

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

/** A short-lived access token and when it stops working (ISO timestamp). */
export const AccessToken = z.object({ token: z.string().min(1), expiresAt: z.string().min(1) })
export type AccessToken = z.infer<typeof AccessToken>

export const AuthPollResult = z.discriminatedUnion('status', [
  z.object({ status: z.literal('pending') }),
  /**
   * Handed over exactly once; the Worker wipes the session from the attempt afterwards.
   * `session.token` is the refresh token; `access` the first short-lived access token (optional
   * so an app reading a Worker deployed before it still parses the answer).
   */
  z.object({ status: z.literal('ready'), session: CloudSession, access: AccessToken.optional() }),
  z.object({ status: z.literal('expired') })
])
export type AuthPollResult = z.infer<typeof AuthPollResult>

/**
 * `POST /auth/verify`: the code from the sign-in email, for an author who reads mail on another
 * device. Bound to the attempt and its poll secret, so only the app that started the sign-in can
 * spend the code; answers like `/auth/poll` (`ready`, or `expired` after too many wrong codes).
 */
export const AuthCodeBody = AuthPollBody.extend({
  code: z
    .string()
    .trim()
    .regex(new RegExp(`^\\d{${LOGIN_CODE_DIGITS}}$`), 'Enter the code from the email')
})
export type AuthCodeBody = z.infer<typeof AuthCodeBody>

/** `POST /auth/refresh`: a fresh access token for a live session (the refresh token). */
export const AuthRefreshBody = z.object({ refreshToken: z.string().min(1) })
export type AuthRefreshBody = z.infer<typeof AuthRefreshBody>

export const AuthRefreshResult = z.object({ access: AccessToken })
export type AuthRefreshResult = z.infer<typeof AuthRefreshResult>

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

/** Spend on one AI feature (`AiFeatureId`, kept as a string on the wire) over one window of time. */
export const CreditSpendRow = z.object({
  feature: z.string().min(1),
  micros: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  tokens: z.number().int().nonnegative()
})
export type CreditSpendRow = z.infer<typeof CreditSpendRow>

/**
 * `GET /credits` with `Authorization: Bearer <token>`. The three `period*` fields are the usage
 * meter (F-15.5); they default so the app still reads a Worker deployed before them.
 */
export const CreditsResult = z.object({
  /**
   * What can be spent now: the sum of the account's ledger minus its active holds (L6). Negative
   * only after a refund of spent money; a request is never answered past it.
   */
  balanceMicros: z.number().int(),
  /**
   * Reserved by requests in flight (L5); `balanceMicros + heldMicros` is the ledger's sum.
   * Optional so a Worker deployed before holds still parses (none held then).
   */
  heldMicros: z.number().int().nonnegative().optional(),
  /** Spend per feature since the account was created. */
  spend: z.array(CreditSpendRow),
  /** How many days back `periodSpend` reaches (`USAGE_PERIOD_DAYS`, a rolling window). */
  periodDays: z.number().int().positive().default(USAGE_PERIOD_DAYS),
  /** Spend per feature inside the period. */
  periodSpend: z.array(CreditSpendRow).default([]),
  /** When the oldest charge inside the period was made (epoch ms); null with none. */
  periodFirstChargeAt: z.number().int().nullable().default(null),
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

/**
 * `GET /license` with the bearer (F-15.9): the Supporter license token for this account, or
 * null when it has none, and the product on sale (a `CreditPack` shape: the variant to name in
 * `POST /billing/checkout` and the price to show). The token's claims and format are in
 * `license.ts`; the app verifies it against the embedded public key before trusting it.
 */
export const LicenseResult = z.object({
  token: z.string().nullable(),
  product: CreditPack.nullable()
})
export type LicenseResult = z.infer<typeof LicenseResult>

export const CloudErrorCode = z.enum([
  'INVALID_EMAIL',
  /** The proxy could not read the body, or it asks for a model or a size the proxy refuses (F-15.4). */
  'BAD_REQUEST',
  /** Too many requests: sign-in emails per address, proxy requests per minute, or a busy provider. */
  'RATE_LIMITED',
  /** The messages are longer than the configured input cap (AI-BILLING-SPEC S4). */
  'REQUEST_TOO_LARGE',
  /** The model is not on the hosted price table, or the gateway no longer serves it. */
  'MODEL_UNAVAILABLE',
  /** This `Idempotency-Key` already ran (charged once) or is still running (L8). */
  'DUPLICATE_REQUEST',
  /** A signed webhook older than the configured window (S5); a replay, never applied. */
  'STALE_WEBHOOK',
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
  REQUEST_TOO_LARGE: 413,
  MODEL_UNAVAILABLE: 422,
  DUPLICATE_REQUEST: 409,
  STALE_WEBHOOK: 400,
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

/**
 * `Idempotency-Key` on `POST /ai/complete` (L8): a retry with the same key is charged at most once.
 * Optional until the app sends it; the Worker makes one up for a request without it.
 */
export const IDEMPOTENCY_KEY_HEADER = 'Idempotency-Key'
export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9._:-]{8,128}$/)

/** The body's fields without the size cap, so the Worker can answer an oversize body by name. */
export const AiCompleteFields = z.object({
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

export const AiCompleteBody = AiCompleteFields.refine(
  (body) => body.messages.reduce((sum, m) => sum + m.content.length, 0) <= AI_COMPLETE_MAX_CHARS,
  `The messages are longer than ${AI_COMPLETE_MAX_CHARS} characters`
)
export type AiCompleteBody = z.infer<typeof AiCompleteBody>

/** What the provider answered plus the meter's receipt: what it cost and what is left. */
export const AiCompleteResult = z.object({
  text: z.string(),
  /** The model the request was billed as (the price table's id); the charge is at its price. */
  model: ModelName,
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    /** Input tokens the provider served from its prompt cache, billed at the cached price (R6). */
    cachedInputTokens: z.number().int().nonnegative().optional()
  }),
  /** Micro-USD taken off the balance for this request; at least 1, never more than its hold. */
  chargeMicros: z.number().int().min(1),
  /** What can be spent after the charge (the ledger minus any other active holds). */
  balanceMicros: z.number().int(),
  /** The proxy's id for the request, on its ledger row and its log line. */
  requestId: z.string().optional()
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
    balanceMicros: z.number().int(),
    requestId: z.string().optional()
  }),
  /** The upstream failed after the headers were sent, so the status is already 200. */
  z.object({ type: z.literal('error'), code: CloudErrorCode, message: z.string() })
])
export type AiStreamEvent = z.infer<typeof AiStreamEvent>

export const AI_STREAM_CONTENT_TYPE = 'application/x-ndjson'

/**
 * Opt-in diagnostics (F-15.8). One route, `POST /diagnostics`, and no `Authorization` header: a
 * report is anonymous by design, so it carries no session, no install id, and nothing that links
 * two reports. The shapes come from `diagnostics.ts` and are validated by the app before sending
 * and by the Worker before storing, so nothing outside the counter enum and the scrubbed crash
 * fields can cross the wire. The Worker answers 204 and stores only aggregates.
 */

/** Bytes the Worker reads at most; a longer body is refused outright. */
export const DIAGNOSTICS_BODY_MAX = 32 * 1024

export const DiagnosticsBody = DiagnosticsEnvironment.extend({
  counts: z.array(DiagnosticCountRow).max(DIAGNOSTIC_ROWS_MAX),
  crashes: z.array(CrashReport).max(DIAGNOSTIC_QUEUE_MAX)
})
export type DiagnosticsBody = z.infer<typeof DiagnosticsBody>

/**
 * `GET /pricing` (AI-BILLING-SPEC P1, P5, config defaults), no bearer: everything the app needs
 * to quote, label, and route hosted requests, read from the Worker's config so a price, the
 * markup, a pack, or the routing table changes without an app release. Money is micro-USD;
 * model prices stay USD per million tokens, as the providers publish them.
 */
export const PricingModel = z.object({
  id: HostedModelId,
  label: z.string().min(1),
  inputUsdPerM: z.number().positive(),
  outputUsdPerM: z.number().positive(),
  cachedInputUsdPerM: z.number().nonnegative().nullable(),
  displayMultiplier: z.number().positive()
})
export type PricingModel = z.infer<typeof PricingModel>

export const PricingResult = z.object({
  currency: z.literal('USD'),
  /** Over the provider cost: 0.2 is cost + 20 %. */
  markup: z.number().nonnegative(),
  /** The one-time app license (M1). */
  appPriceMicros: z.number().int().nonnegative(),
  /** The smallest pack sold (M4); smaller configured packs are not offered. */
  minPackMicros: z.number().int().nonnegative(),
  packs: z.array(CreditPack),
  /** Once per verified email (M7). */
  trialGrantMicros: z.number().int().nonnegative(),
  /** Jobs estimated above this are quoted and confirmed first (hosted request flow 2). */
  quoteThresholdMicros: z.number().int().nonnegative(),
  /** Every displayed estimate is multiplied by this (E4). */
  estimateSafetyFactor: z.number().min(1),
  /** Warn below this balance (E6). */
  lowBalanceWarningMicros: z.number().int().nonnegative(),
  /** A hold is released this long after it was placed if the request never settled (L5). */
  holdExpiryMinutes: z.number().int().positive(),
  /** Unused balance is refundable this long after the pack was bought. */
  refundWindowDays: z.number().int().nonnegative(),
  /** Per-user limits on the proxy (S4). */
  limits: z.object({
    requestsPerMinute: z.number().int().positive(),
    maxInputChars: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive()
  }),
  models: z.array(PricingModel),
  routing: HostedRouting,
  /** Null constants hide the estimate lines that need them (E2, E3). */
  wordCosts: WordCostConstants
})
export type PricingResult = z.infer<typeof PricingResult>

/** `GET /usage?limit=&cursor=` with the bearer (E7): the account's ledger, newest first. */
export const USAGE_PAGE_DEFAULT = 50
export const USAGE_PAGE_MAX = 200

export const LedgerEntryType = z.enum(['topup', 'trial_grant', 'charge', 'refund', 'adjustment'])
export type LedgerEntryType = z.infer<typeof LedgerEntryType>

export const UsageEntry = z.object({
  id: z.string().min(1),
  type: LedgerEntryType,
  /** Signed micro-USD: a top-up adds, a charge subtracts. */
  amountMicros: z.number().int(),
  /** Epoch ms. */
  at: z.number().int(),
  feature: z.string().nullable(),
  model: z.string().nullable(),
  tokensIn: z.number().int().nullable(),
  tokensOut: z.number().int().nullable(),
  tokensCached: z.number().int().nullable(),
  requestId: z.string().nullable()
})
export type UsageEntry = z.infer<typeof UsageEntry>

export const UsageResult = z.object({
  entries: z.array(UsageEntry),
  /** Pass back as `cursor` for the next (older) page; null on the last page. */
  nextCursor: z.string().nullable()
})
export type UsageResult = z.infer<typeof UsageResult>
