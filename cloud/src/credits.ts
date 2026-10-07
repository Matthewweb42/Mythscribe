/**
 * MythScribe hosted AI billing (F-15.3, AI-BILLING-SPEC A7, A8, L1-L8, P1, S5, E7): the balance,
 * the price table, the usage history, the Lemon Squeezy checkout, and the webhook that writes
 * top-ups and refunds to the ledger. The proxy's holds and charges are in `ai.ts`.
 *
 * Every amount is an integer in micro-USD (1e-6 USD). A balance is never stored: it is the sum of
 * the account's ledger entries minus its active holds (`Store.getBalance`). Handlers are pure over
 * `CreditsDeps`, like the account routes.
 *
 * The same checkout and webhook also sell the one-time licenses (F-15.9): the $30 app license
 * (M1, 2026-10-07) and the older Supporter product it supersedes. Each is one more configured
 * variant, but it grants a row in `supporter_licenses` instead of balance, and `license.ts` turns
 * that row into a signed token.
 */
import { z } from 'zod'
import {
  AI_COMPLETE_MAX_TOKENS,
  CheckoutBody,
  type CheckoutResult,
  CreditPack,
  type CreditsResult,
  isCheckoutUrl,
  type PricingResult,
  TOKEN_BYTES,
  USAGE_PAGE_DEFAULT,
  USAGE_PAGE_MAX,
  type UsageResult
} from '../../src/shared/cloudApi'
import { MICROS_PER_USD, usdToMicros } from '../../src/shared/cloudBilling'
import { USAGE_PERIOD_DAYS, USAGE_PERIOD_MS } from '../../src/shared/cloudUsage'
import {
  type AuthDeps,
  authenticate,
  jsonError,
  jsonResponse,
  readJson,
  UNAUTHORIZED_MESSAGE
} from './auth'
import { type BillingConfig, loadBillingConfig } from './config'
import { hmacSha256Hex, timingSafeEqualHex } from './crypto'
import { plainEntry } from './store'

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
  /**
   * The packs configured in `LEMONSQUEEZY_PACKS`; empty until the operator sets it. Those below
   * the configured minimum (`min_pack_usd`, M4) are not sold.
   */
  packs: ConfiguredPack[]
  /**
   * F-15.9: the Supporter product, configured like a pack but sold through the same checkout and
   * webhook. It buys a license, never balance; null until the operator configures it.
   */
  supporter: ConfiguredPack | null
  /** M1: the $30 app license (`LEMONSQUEEZY_APP_LICENSE`); the same license row as the Supporter. */
  appLicense: ConfiguredPack | null
  /** `LEMONSQUEEZY_WEBHOOK_SECRET`; absent means the webhook answers NOT_CONFIGURED. */
  webhookSecret: string | null
}

/** One variant on sale, and what buying it does: add balance, or grant the license. */
interface Variant {
  pack: ConfiguredPack
  license: boolean
}

/** $1 paid is $1 of balance: the markup is on the usage, not on the pack (M6). */
const MICROS_PER_CENT = MICROS_PER_USD / 100

/** The configured packs at or above the minimum pack (M4), in their configured order. */
export function packsOnSale(deps: CreditsDeps, config: BillingConfig): ConfiguredPack[] {
  const minCents = Math.round(config.minPackUsd * 100)
  return deps.packs.filter((pack) => {
    if (pack.priceCents >= minCents) return true
    console.warn(`Pack ${pack.variantId} is below the minimum pack; not on sale`)
    return false
  })
}

/** Everything the operator has on sale: the packs, the app license, and the Supporter product. */
function findVariant(
  deps: CreditsDeps,
  config: BillingConfig,
  variantId: string | undefined
): Variant | null {
  const pack = packsOnSale(deps, config).find((candidate) => candidate.variantId === variantId)
  if (pack) return { pack, license: false }
  for (const product of [deps.appLicense, deps.supporter]) {
    if (product && product.variantId === variantId) return { pack: product, license: true }
  }
  return null
}

/** A pack as the app sees it: the checkout URL stays on the Worker, the app only names a variant. */
function wirePack({ variantId, priceCents }: ConfiguredPack): CreditPack {
  return { variantId, priceCents }
}

/** One message for an unknown credit pack and an unknown license variant alike (F-15.9). */
const UNKNOWN_VARIANT = 'That purchase is not on sale. Refresh the Account tab and try again.'
const WEBHOOK_NOT_CONFIGURED = 'Purchases are not configured on the server yet.'
const BAD_SIGNATURE_MESSAGE = 'That webhook body was not signed with the configured secret.'
const STALE_MESSAGE = 'That webhook event is older than the accepted window.'
const BAD_CURSOR = 'That usage page is not available. Start again from the first page.'

/**
 * `GET /credits`: the balance, what it was spent on, and what can be bought. The balance is what
 * can be spent now (L6: the ledger's sum minus active holds), with the held part beside it. Spend
 * comes twice — lifetime, and over the usage meter's rolling period (F-15.5), with the oldest
 * charge inside it so the app can project the run-out from the pace.
 */
export async function handleCredits(request: Request, deps: CreditsDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const now = deps.now().getTime()
  const since = now - USAGE_PERIOD_MS
  const config = await loadBillingConfig(deps.store)
  const balance = await deps.store.getBalance(caller.user.id, now)
  const spend = await deps.store.spendByFeature(caller.user.id)
  const periodSpend = await deps.store.spendByFeature(caller.user.id, since)
  const periodFirstChargeAt = await deps.store.firstChargeAt(caller.user.id, since)
  return jsonResponse({
    balanceMicros: balance.ledgerMicros - balance.heldMicros,
    heldMicros: balance.heldMicros,
    spend,
    periodDays: USAGE_PERIOD_DAYS,
    periodSpend,
    periodFirstChargeAt,
    packs: packsOnSale(deps, config).map(wirePack)
  } satisfies CreditsResult)
}

/**
 * `GET /pricing` (P1, P5): the price table, the packs, the markup, the limits, the routing table,
 * and the estimate constants, as the config holds them now. No bearer: none of it is personal,
 * and the app shows prices before anyone signs in.
 */
export async function handlePricing(deps: CreditsDeps): Promise<Response> {
  const config = await loadBillingConfig(deps.store)
  return jsonResponse({
    currency: 'USD',
    markup: config.markup,
    appPriceMicros: usdToMicros(config.appPriceUsd),
    minPackMicros: usdToMicros(config.minPackUsd),
    packs: packsOnSale(deps, config).map(wirePack),
    trialGrantMicros: usdToMicros(config.trialGrantUsd),
    quoteThresholdMicros: usdToMicros(config.quoteThresholdUsd),
    estimateSafetyFactor: config.estimateSafetyFactor,
    lowBalanceWarningMicros: usdToMicros(config.lowBalanceWarningUsd),
    holdExpiryMinutes: config.holdExpiryMinutes,
    refundWindowDays: config.refundWindowDays,
    limits: {
      requestsPerMinute: config.requestsPerMinute,
      maxInputChars: config.maxInputChars,
      maxOutputTokens: AI_COMPLETE_MAX_TOKENS
    },
    models: config.models.map((model) => ({
      id: model.id,
      label: model.label,
      inputUsdPerM: model.inputUsdPerM,
      outputUsdPerM: model.outputUsdPerM,
      cachedInputUsdPerM: model.cachedInputUsdPerM,
      displayMultiplier: model.displayMultiplier
    })),
    routing: config.routing,
    wordCosts: config.wordCosts
  } satisfies PricingResult)
}

/** A usage page cursor: `<created_at>.<id>` of the last entry on the previous page. */
function parseCursor(cursor: string | null): { createdAt: number; id: string } | null | 'bad' {
  if (cursor === null || cursor === '') return null
  const dot = cursor.indexOf('.')
  const createdAt = Number(cursor.slice(0, dot))
  const id = cursor.slice(dot + 1)
  if (dot <= 0 || !Number.isSafeInteger(createdAt) || id === '') return 'bad'
  return { createdAt, id }
}

/** `GET /usage?limit=&cursor=` (E7): the account's ledger, newest first, one page at a time. */
export async function handleUsage(request: Request, deps: CreditsDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const params = new URL(request.url).searchParams
  const requested = Number(params.get('limit') ?? USAGE_PAGE_DEFAULT)
  const limit = Number.isInteger(requested)
    ? Math.min(Math.max(requested, 1), USAGE_PAGE_MAX)
    : USAGE_PAGE_DEFAULT
  const before = parseCursor(params.get('cursor'))
  if (before === 'bad') return jsonError('BAD_REQUEST', BAD_CURSOR)

  // One extra row says whether there is a next page without a second query.
  const rows = await deps.store.listLedger(caller.user.id, limit + 1, before)
  const page = rows.slice(0, limit)
  const last = page[page.length - 1]
  return jsonResponse({
    entries: page.map((row) => ({
      id: row.id,
      type: row.type,
      amountMicros: row.amountMicros,
      at: row.createdAt,
      feature: row.feature,
      model: row.model,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      tokensCached: row.tokensCached,
      requestId: row.requestId
    })),
    nextCursor: rows.length > limit && last ? `${last.createdAt}.${last.id}` : null
  } satisfies UsageResult)
}

/**
 * `POST /billing/checkout`: the hosted checkout URL for one variant on sale — a pack, the app
 * license, or the Supporter product — with the buyer stamped on it. `custom[user_id]` is what
 * comes back on the webhook, so the Worker — not the app — builds it.
 */
export async function handleCheckout(request: Request, deps: CreditsDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const parsed = CheckoutBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('NOT_FOUND', UNKNOWN_VARIANT)
  const config = await loadBillingConfig(deps.store)
  const variant = findVariant(deps, config, parsed.data.variantId)
  if (!variant) return jsonError('NOT_FOUND', UNKNOWN_VARIANT)

  const url = new URL(variant.pack.url)
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
      /** ISO timestamps; the staleness check (S5) reads the one that dates the event. */
      created_at: z.string().nullish(),
      updated_at: z.string().nullish(),
      refunded_at: z.string().nullish(),
      /** Cents refunded so far on the order (cumulative); absent means the whole order. */
      refunded_amount: z.number().int().nonnegative().nullish(),
      first_order_item: z
        .looseObject({
          // Lemon Squeezy sends the variant id as a number; the config keeps it as a string.
          variant_id: z.union([z.string(), z.number()]).transform(String)
        })
        .optional()
    })
  })
})
type LemonSqueezyEvent = z.infer<typeof LemonSqueezyEvent>

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
 * When the event happened (epoch ms): the order's creation for a purchase, the refund for a
 * refund. Null when the payload does not say, which the staleness check treats as stale.
 */
function eventTime(event: LemonSqueezyEvent, kind: 'purchase' | 'refund'): number | null {
  const { attributes } = event.data
  const stamp =
    kind === 'purchase' ? attributes.created_at : (attributes.refunded_at ?? attributes.updated_at)
  if (!stamp) return null
  const at = Date.parse(stamp)
  return Number.isNaN(at) ? null : at
}

/**
 * `POST /billing/lemonsqueezy`: write a paid order to the ledger as a `topup`, a refund as a
 * `refund`, ignore everything else. An order for a license variant grants or revokes the license
 * instead (F-15.9).
 *
 * Lemon Squeezy retries every non-2xx delivery for days, so the only failures answered here are
 * those an operator can act on: a body not signed with our secret (401), a Worker with no secret
 * set (503), and a signed event older than the accepted window (400, S5: a replay). Anything
 * unreadable, unknown, or uninteresting is a logged 200. A replayed delivery inside the window
 * lands on the ledger's unique key and changes nothing (L8).
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

  const now = deps.now().getTime()
  const config = await loadBillingConfig(deps.store)
  const happenedAt = eventTime(event, kind)
  if (happenedAt === null || now - happenedAt > config.webhookMaxAgeHours * 60 * 60_000) {
    console.warn(`Lemon Squeezy ${eventName} ${event.data.id}: older than the window; refused`)
    return jsonError('STALE_WEBHOOK', STALE_MESSAGE)
  }

  const userId = event.meta.custom_data?.user_id
  const variantId = event.data.attributes.first_order_item?.variant_id
  const variant = findVariant(deps, config, variantId)
  const user = userId ? await deps.store.findUserById(userId) : null
  if (!user || !variant) {
    // Ids only, never the email or the payload. Nothing to retry: the operator fixes the config
    // or refunds the order by hand.
    console.warn(
      `Lemon Squeezy ${eventName} ${event.data.id}: unknown user (${userId ?? 'none'}) or variant (${variantId ?? 'none'}); ignored`
    )
    return webhookDone('ignored')
  }

  const orderId = event.data.id

  if (variant.license) {
    // F-15.9: a license buys a flag, never balance, so the ledger stays out of it.
    if (kind === 'refund') {
      await deps.store.revokeSupporter(user.id, now)
      // Revoking an already revoked license is the same state, so a replay is 'applied' too.
      return webhookDone('applied')
    }
    return webhookDone(await deps.store.grantSupporter(user.id, `${eventName}:${orderId}`, now))
  }

  if (kind === 'refund') {
    // Unused balance is refundable (author decision 2026-10-07): the operator refunds what is
    // left of a pack in Lemon Squeezy, and the ledger takes off exactly what was refunded —
    // never more than the pack — with only the difference added on a later partial refund.
    const packCents = variant.pack.priceCents
    // No amount (or 0) on the event means the whole order, as before partial refunds.
    const reported = event.data.attributes.refunded_amount ?? 0
    const refundedCents = Math.min(reported > 0 ? reported : packCents, packCents)
    return webhookDone(
      await deps.store.refundOrder({
        id: deps.random(TOKEN_BYTES),
        userId: user.id,
        orderId,
        refundedMicros: refundedCents * MICROS_PER_CENT,
        idempotencyKey: `order_refunded:${orderId}:${refundedCents}`,
        createdAt: now
      })
    )
  }

  // The configured price is the truth for the amount, so currency, discounts, and tax on the
  // order never reach the balance.
  return webhookDone(
    await deps.store.appendLedgerEntry(
      plainEntry({
        id: deps.random(TOKEN_BYTES),
        userId: user.id,
        type: 'topup',
        amountMicros: variant.pack.priceCents * MICROS_PER_CENT,
        idempotencyKey: `${eventName}:${orderId}`,
        createdAt: now,
        orderId
      })
    )
  )
}
