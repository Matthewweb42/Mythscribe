/**
 * MythScribe Cloud credits (F-15.3): the prepaid balance, the Lemon Squeezy checkout and
 * webhook, and the meter the AI proxy (F-15.4) charges every answered request with.
 *
 * Every amount is an integer in micro-USD (1e-6 USD); the rate per model comes from the same
 * `src/shared/cloudRates.ts` the desktop app publishes, so there is exactly one rate. Handlers
 * are pure over `CreditsDeps`, like the account routes.
 */
import { z } from 'zod'
import {
  CheckoutBody,
  type CheckoutResult,
  CreditPack,
  type CreditsResult,
  isCheckoutUrl,
  TOKEN_BYTES
} from '../../src/shared/cloudApi'
import { cloudChargeMicros, MICROS_PER_USD } from '../../src/shared/cloudRates'
import { USAGE_PERIOD_DAYS, USAGE_PERIOD_MS } from '../../src/shared/cloudUsage'
import {
  type AuthDeps,
  authenticate,
  jsonError,
  jsonResponse,
  readJson,
  UNAUTHORIZED_MESSAGE
} from './auth'
import { hmacSha256Hex, timingSafeEqualHex } from './crypto'
import type { Store } from './store'

/**
 * A pack as the operator configures it: the wire shape plus the hosted checkout URL to send to.
 * The URL must be one the app will open (`isCheckoutUrl`), so a typo is caught on the Worker
 * rather than refused later in the app.
 */
export const ConfiguredPack = CreditPack.extend({
  url: z.string().url().refine(isCheckoutUrl, 'Must be an https Lemon Squeezy checkout URL')
})
export type ConfiguredPack = z.infer<typeof ConfiguredPack>

/** The `LEMONSQUEEZY_PACKS` var: what is on sale, in the order the app lists it. */
export const ConfiguredPacks = z.array(ConfiguredPack)

export interface CreditsDeps extends AuthDeps {
  /** The packs on sale; empty until the operator configures `LEMONSQUEEZY_PACKS`. */
  packs: ConfiguredPack[]
  /** `LEMONSQUEEZY_WEBHOOK_SECRET`; absent means the webhook answers NOT_CONFIGURED. */
  webhookSecret: string | null
}

/** $1 paid is $1 of credit: the margin is in the rate, not in the pack (PLAN.md §4.2). */
const MICROS_PER_CENT = MICROS_PER_USD / 100

const UNKNOWN_PACK = 'That credit pack is not on sale. Refresh the Account tab and try again.'
const WEBHOOK_NOT_CONFIGURED = 'Credit purchases are not configured on the server yet.'
const BAD_SIGNATURE_MESSAGE = 'That webhook body was not signed with the configured secret.'

/**
 * `GET /credits`: the balance, what it was spent on, and what can be bought. Spend comes twice —
 * lifetime, and over the usage meter's rolling period (F-15.5), with the oldest charge inside it
 * so the app can project the run-out from the pace rather than from the whole window.
 */
export async function handleCredits(request: Request, deps: CreditsDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const since = deps.now().getTime() - USAGE_PERIOD_MS
  const balanceMicros = await deps.store.getBalance(caller.user.id)
  const spend = await deps.store.spendByFeature(caller.user.id)
  const periodSpend = await deps.store.spendByFeature(caller.user.id, since)
  const periodFirstChargeAt = await deps.store.firstChargeAt(caller.user.id, since)
  // The checkout URL stays on the Worker: the app only ever names a variant.
  const packs = deps.packs.map(({ variantId, priceCents }) => ({ variantId, priceCents }))
  return jsonResponse({
    balanceMicros,
    spend,
    periodDays: USAGE_PERIOD_DAYS,
    periodSpend,
    periodFirstChargeAt,
    packs
  } satisfies CreditsResult)
}

/**
 * `POST /billing/checkout`: the hosted checkout URL for one pack, with the buyer stamped on it.
 * `custom[user_id]` is what comes back on the webhook, so the Worker — not the app — builds it.
 */
export async function handleCheckout(request: Request, deps: CreditsDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const parsed = CheckoutBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('NOT_FOUND', UNKNOWN_PACK)
  const pack = deps.packs.find((candidate) => candidate.variantId === parsed.data.variantId)
  if (!pack) return jsonError('NOT_FOUND', UNKNOWN_PACK)

  const url = new URL(pack.url)
  url.searchParams.set('checkout[custom][user_id]', caller.user.id)
  url.searchParams.set('checkout[email]', caller.user.email)
  return jsonResponse({ url: url.toString() } satisfies CheckoutResult)
}

/**
 * The slice of a Lemon Squeezy webhook body this Worker reads. Lenient on purpose: the payload
 * carries dozens of fields that may change, and anything unexpected in them must not turn a
 * paid order into a retried failure.
 */
const LemonSqueezyEvent = z.looseObject({
  meta: z.looseObject({
    event_name: z.string(),
    /** Set from `checkout[custom][user_id]` in `handleCheckout`; absent on a direct purchase. */
    custom_data: z.looseObject({ user_id: z.string().optional() }).optional()
  }),
  data: z.looseObject({
    id: z.string(),
    attributes: z.looseObject({
      status: z.string().optional(),
      first_order_item: z
        .looseObject({
          // Lemon Squeezy sends the variant id as a number; the config keeps it as a string.
          variant_id: z.union([z.string(), z.number()]).transform(String)
        })
        .optional()
    })
  })
})

/** Nothing to do, and nothing to retry: every outcome below is a 200. */
function webhookDone(status: 'applied' | 'duplicate' | 'ignored'): Response {
  return jsonResponse({ status })
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body)
  } catch {
    return null
  }
}

/**
 * `POST /billing/lemonsqueezy`: credit a paid order, debit a refund, ignore everything else.
 *
 * Lemon Squeezy retries every non-2xx delivery for days, so the only failures answered here are
 * the two an operator can fix: a body that is not signed with our secret (401) and a Worker with
 * no secret set (503). Anything unreadable, unknown, or uninteresting is a logged 200.
 */
export async function handleLemonSqueezyWebhook(
  request: Request,
  deps: CreditsDeps
): Promise<Response> {
  const secret = deps.webhookSecret
  if (!secret) return jsonError('NOT_CONFIGURED', WEBHOOK_NOT_CONFIGURED)

  // The signature covers the exact bytes, so the body is read as text once and parsed after.
  const body = await request.text()
  const offered = request.headers.get('X-Signature')?.trim().toLowerCase()
  const expected = await hmacSha256Hex(secret, body)
  if (!offered || !timingSafeEqualHex(offered, expected)) {
    return jsonError('BAD_SIGNATURE', BAD_SIGNATURE_MESSAGE)
  }

  const parsed = LemonSqueezyEvent.safeParse(parseJson(body))
  if (!parsed.success) {
    console.warn('Lemon Squeezy webhook: body is not an event we can read; ignored')
    return webhookDone('ignored')
  }

  const event = parsed.data
  const eventName = event.meta.event_name
  const kind =
    eventName === 'order_created' ? 'purchase' : eventName === 'order_refunded' ? 'refund' : null
  if (!kind) return webhookDone('ignored')
  // An order only counts once it is paid; `pending` and `failed` orders may still change.
  if (kind === 'purchase' && event.data.attributes.status !== 'paid') return webhookDone('ignored')

  const userId = event.meta.custom_data?.user_id
  const variantId = event.data.attributes.first_order_item?.variant_id
  const pack = deps.packs.find((candidate) => candidate.variantId === variantId)
  const user = userId ? await deps.store.findUserById(userId) : null
  if (!user || !pack) {
    // Ids only, never the email or the payload. Nothing to retry: the operator fixes the config
    // or refunds the order by hand.
    console.warn(
      `Lemon Squeezy ${eventName} ${event.data.id}: unknown user (${userId ?? 'none'}) or variant (${variantId ?? 'none'}); ignored`
    )
    return webhookDone('ignored')
  }

  // The configured price is the truth for the amount, so currency, discounts, and tax on the
  // order never reach the balance.
  const amountMicros = pack.priceCents * MICROS_PER_CENT * (kind === 'refund' ? -1 : 1)
  const outcome = await deps.store.applyCreditEvent({
    id: deps.random(TOKEN_BYTES),
    userId: user.id,
    kind,
    amountMicros,
    feature: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    // Idempotency: a replayed delivery of the same event for the same order changes nothing.
    orderRef: `${eventName}:${event.data.id}`,
    requestId: null,
    createdAt: deps.now().getTime()
  })
  return webhookDone(outcome)
}

/** What the proxy knows about a request once the provider has answered it. */
export interface MeterInput {
  /** The `AiFeatureId` that spent the credit. */
  feature: string
  model: string
  tokensIn: number
  tokensOut: number
  /** The proxy's id for the request, so a charge can be traced back to a log line. */
  requestId: string
}

export interface CreditCharge {
  micros: number
  balanceMicros: number
}

/** What `meterRequest` needs; the router's `CreditsDeps` satisfies it. */
export type MeterDeps = Pick<AuthDeps, 'store' | 'now' | 'random'>

/**
 * Charge one answered Cloud request (F-15.4 calls this after the provider replies). The charge
 * is unconditional: the token counts are only known afterwards, so the last request may take the
 * balance slightly below zero and `hasCredit` refuses the next one. Throws for a model with no
 * published rate — the proxy must never answer with a model it cannot bill.
 */
export async function meterRequest(
  deps: MeterDeps,
  userId: string,
  input: MeterInput
): Promise<CreditCharge> {
  const micros = cloudChargeMicros(input.model, input.tokensIn, input.tokensOut)
  await deps.store.applyCreditEvent({
    id: deps.random(TOKEN_BYTES),
    userId,
    kind: 'charge',
    amountMicros: -micros,
    feature: input.feature,
    model: input.model,
    tokensIn: input.tokensIn,
    tokensOut: input.tokensOut,
    orderRef: null,
    requestId: input.requestId,
    createdAt: deps.now().getTime()
  })
  return { micros, balanceMicros: await deps.store.getBalance(userId) }
}

/** The pre-flight gate (F-15.4): a request is answered only while there is credit left. */
export async function hasCredit(store: Store, userId: string): Promise<boolean> {
  return (await store.getBalance(userId)) > 0
}
