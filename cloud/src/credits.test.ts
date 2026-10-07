import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CheckoutResult,
  CloudApiError,
  CreditsResult,
  isCheckoutUrl,
  LicenseResult,
  PricingResult,
  SESSION_TTL_MS,
  UsageResult
} from '../../src/shared/cloudApi'
import { DEFAULT_HOSTED_MODELS } from '../../src/shared/cloudBilling'
import { type ConfiguredPack } from './credits'
import { hmacSha256Hex, sha256Hex } from './crypto'
import type { Mailer } from './email'
import { handleRequest, type WorkerDeps } from './index'
import { plainEntry } from './store'
import { testStore, type TestStore } from './testing/sqliteD1'

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const USER_ID = 'user-1'
const TOKEN = 'session-token'
const SECRET = 'lemon-webhook-secret'
const START = new Date('2026-09-19T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60_000

const PACKS: ConfiguredPack[] = [
  { variantId: '111', priceCents: 1000, url: 'https://mythscribe.lemonsqueezy.com/buy/ten' },
  { variantId: '222', priceCents: 2500, url: 'https://mythscribe.lemonsqueezy.com/buy/twenty' }
]

/** M1: the $30 app license, sold through the same checkout and webhook as the Supporter product. */
const APP_LICENSE: ConfiguredPack = {
  variantId: '444',
  priceCents: 3000,
  url: 'https://mythscribe.lemonsqueezy.com/buy/app'
}

/** F-15.9: the Supporter product goes through the same checkout and webhook as a pack. */
const SUPPORTER: ConfiguredPack = {
  variantId: '333',
  priceCents: 3900,
  url: 'https://mythscribe.lemonsqueezy.com/buy/supporter'
}

const silentMailer: Mailer = { send: () => Promise.resolve() }

let deps: WorkerDeps
let clock: number
let counter: number
let warnings: string[]

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: testStore(),
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => `evt-${(counter += 1)}`,
    revealLink: false,
    packs: PACKS,
    supporter: SUPPORTER,
    appLicense: APP_LICENSE,
    webhookSecret: SECRET,
    // F-15.4: the AI proxy has its own tests in `ai.test.ts`.
    upstream: null,
    // F-15.9: signing a token is `license.test.ts`; here the license is only granted and revoked.
    signingKey: null,
    ...overrides
  }
}

/** Seed a signed-in user directly: the sign-in flow itself is covered by `auth.test.ts`. */
async function signIn(): Promise<void> {
  await deps.store.insertUser({ id: USER_ID, email: EMAIL, createdAt: clock })
  await deps.store.insertSession({
    tokenHash: await sha256Hex(TOKEN),
    userId: USER_ID,
    createdAt: clock,
    expiresAt: clock + SESSION_TTL_MS,
    lastSeenAt: clock,
    revokedAt: null
  })
}

beforeEach(async () => {
  clock = START.getTime()
  counter = 0
  deps = makeDeps()
  // The handlers warn about events they drop; the tests assert on that, not on the console.
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  })
  await signIn()
})

afterEach(() => {
  vi.restoreAllMocks()
})

function get(path: string, token?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  })
}

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify(body)
  })
}

async function errorOf(response: Response): Promise<CloudApiError> {
  return CloudApiError.parse(await response.json())
}

async function credits(token = TOKEN): Promise<CreditsResult> {
  const response = await handleRequest(get('/credits', token), deps)
  expect(response.status).toBe(200)
  return CreditsResult.parse(await response.json())
}

interface OrderEventOptions {
  event?: string
  id?: string
  status?: string
  /** `null` leaves `custom_data` off the payload, as a purchase made outside the app would. */
  userId?: string | null
  /** `null` leaves `first_order_item` off the payload. */
  variantId?: string | number | null
  /** When the event happened; the clock by default. `null` leaves the timestamps off. */
  at?: number | null
  /** Cents refunded so far on the order; absent means the whole order. */
  refundedAmount?: number
}

/** A Lemon Squeezy `order_created` body, trimmed to the fields the Worker reads. */
function orderEvent({
  event = 'order_created',
  id = 'order-1',
  status = 'paid',
  userId = USER_ID,
  variantId = '111',
  at = clock,
  refundedAmount
}: OrderEventOptions = {}): unknown {
  const stamp = at === null ? undefined : new Date(at).toISOString()
  return {
    meta: {
      event_name: event,
      custom_data: userId === null ? undefined : { user_id: userId }
    },
    data: {
      type: 'orders',
      id,
      attributes: {
        store_id: 1,
        status,
        total: 1000,
        created_at: event === 'order_refunded' ? undefined : stamp,
        updated_at: stamp,
        refunded_at: event === 'order_refunded' ? stamp : null,
        ...(refundedAmount === undefined ? {} : { refunded_amount: refundedAmount }),
        currency: 'USD',
        first_order_item:
          variantId === null
            ? undefined
            : { id: 42, variant_id: variantId, variant_name: 'Starter pack' }
      }
    }
  }
}

interface WebhookOptions {
  /** Sign with this instead of the Worker's secret. */
  secret?: string
  /** `null` sends no `X-Signature` header at all. */
  signature?: string | null
  /** Send exactly this body instead of the serialized payload. */
  raw?: string
}

async function webhook(payload: unknown, options: WebhookOptions = {}): Promise<Response> {
  const body = options.raw ?? JSON.stringify(payload)
  const signature =
    options.signature === undefined
      ? await hmacSha256Hex(options.secret ?? SECRET, body)
      : options.signature
  const headers = new Headers()
  if (signature !== null) headers.set('X-Signature', signature)
  return handleRequest(
    new Request(`${ORIGIN}/billing/lemonsqueezy`, { method: 'POST', headers, body }),
    deps
  )
}

/** A charge row as the proxy writes it (its own tests are in `ai.test.ts`). */
async function seedCharge(
  feature: string,
  micros: number,
  tokensIn: number,
  tokensOut: number,
  requestId: string
): Promise<void> {
  await deps.store.appendLedgerEntry({
    ...plainEntry({
      id: requestId,
      userId: USER_ID,
      type: 'charge',
      amountMicros: -micros,
      idempotencyKey: `charge:${requestId}`,
      createdAt: clock
    }),
    requestId,
    feature,
    model: 'openai/gpt-5.4-mini',
    tokensIn,
    tokensOut,
    tokensCached: 0,
    providerCostMicros: micros,
    markupBps: 2000
  })
}

async function webhookStatus(response: Response): Promise<string> {
  expect(response.status).toBe(200)
  const body = await response.json<{ status: string }>()
  return body.status
}

describe('GET /credits', () => {
  it('starts at nothing spent and lists the configured packs', async () => {
    const body = await credits()

    expect(body).toEqual({
      balanceMicros: 0,
      heldMicros: 0,
      spend: [],
      periodDays: 30,
      periodSpend: [],
      periodFirstChargeAt: null,
      packs: [
        { variantId: '111', priceCents: 1000 },
        { variantId: '222', priceCents: 2500 }
      ]
    })
  })

  it('says no packs are on sale when the Worker has none configured', async () => {
    deps = makeDeps({ packs: [] })
    await signIn()

    expect((await credits()).packs).toEqual([])
  })

  it('keeps the checkout URLs on the Worker', async () => {
    const response = await handleRequest(get('/credits', TOKEN), deps)

    expect(await response.text()).not.toContain('/buy/')
  })

  it('refuses a caller with no session', async () => {
    const response = await handleRequest(get('/credits'), deps)

    expect(response.status).toBe(401)
    expect((await errorOf(response)).code).toBe('UNAUTHORIZED')
  })

  it('reports the balance and what each feature spent', async () => {
    expect(await webhookStatus(await webhook(orderEvent()))).toBe('applied')

    await seedCharge('ghostText', 2400, 1000, 100, 'req-1')
    await seedCharge('ghostText', 2400, 1000, 100, 'req-2')
    await seedCharge('chat', 25_000, 2000, 500, 'req-3')

    const body = await credits()
    expect(body.balanceMicros).toBe(10_000_000 - 2400 - 2400 - 25_000)
    expect(body.spend).toEqual([
      { feature: 'chat', micros: 25_000, requests: 1, tokens: 2500 },
      { feature: 'ghostText', micros: 4800, requests: 2, tokens: 2200 }
    ])
    // Everything was charged just now, so the period breakdown is the lifetime one.
    expect(body.periodSpend).toEqual(body.spend)
  })

  it('reports the last 30 days separately from all time', async () => {
    // Older than the period: lifetime spend counts it, the meter does not.
    clock = START.getTime() - 40 * DAY_MS
    await seedCharge('ghostText', 2400, 1000, 100, 'req-old')
    clock = START.getTime() - 20 * DAY_MS
    await seedCharge('ghostText', 2400, 1000, 100, 'req-in-window')
    clock = START.getTime() - 5 * DAY_MS
    await seedCharge('chat', 25_000, 2000, 500, 'req-recent')
    clock = START.getTime()

    const body = await credits()

    expect(body.periodDays).toBe(30)
    expect(body.spend).toEqual([
      { feature: 'chat', micros: 25_000, requests: 1, tokens: 2500 },
      { feature: 'ghostText', micros: 4800, requests: 2, tokens: 2200 }
    ])
    expect(body.periodSpend).toEqual([
      { feature: 'chat', micros: 25_000, requests: 1, tokens: 2500 },
      { feature: 'ghostText', micros: 2400, requests: 1, tokens: 1100 }
    ])
    // The oldest charge inside the window, not the oldest charge of the account.
    expect(body.periodFirstChargeAt).toBe(START.getTime() - 20 * DAY_MS)
  })

  it('has no period spend or first charge when nothing was spent in the last 30 days', async () => {
    clock = START.getTime() - 40 * DAY_MS
    await seedCharge('chat', 25_000, 2000, 500, 'req-old')
    clock = START.getTime()

    const body = await credits()

    expect(body.spend).toEqual([{ feature: 'chat', micros: 25_000, requests: 1, tokens: 2500 }])
    expect(body.periodSpend).toEqual([])
    expect(body.periodFirstChargeAt).toBeNull()
  })
})

describe('POST /billing/checkout', () => {
  it('stamps the buyer on the pack URL', async () => {
    const response = await handleRequest(
      post('/billing/checkout', { variantId: '222' }, TOKEN),
      deps
    )

    expect(response.status).toBe(200)
    const { url } = CheckoutResult.parse(await response.json())
    expect(isCheckoutUrl(url)).toBe(true)
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://mythscribe.lemonsqueezy.com/buy/twenty')
    expect(parsed.searchParams.get('checkout[custom][user_id]')).toBe(USER_ID)
    expect(parsed.searchParams.get('checkout[email]')).toBe(EMAIL)
  })

  it('stamps the buyer on the Supporter product too', async () => {
    const response = await handleRequest(
      post('/billing/checkout', { variantId: SUPPORTER.variantId }, TOKEN),
      deps
    )

    expect(response.status).toBe(200)
    const parsed = new URL(CheckoutResult.parse(await response.json()).url)
    expect(parsed.origin + parsed.pathname).toBe(
      'https://mythscribe.lemonsqueezy.com/buy/supporter'
    )
    expect(parsed.searchParams.get('checkout[custom][user_id]')).toBe(USER_ID)
  })

  it('refuses the Supporter variant when the Worker has no product configured', async () => {
    deps = makeDeps({ supporter: null })
    await signIn()

    const response = await handleRequest(
      post('/billing/checkout', { variantId: SUPPORTER.variantId }, TOKEN),
      deps
    )

    expect(response.status).toBe(404)
    expect((await errorOf(response)).code).toBe('NOT_FOUND')
  })

  it('refuses an unknown or malformed pack', async () => {
    const unknown = await handleRequest(
      post('/billing/checkout', { variantId: '999' }, TOKEN),
      deps
    )
    const malformed = await handleRequest(post('/billing/checkout', {}, TOKEN), deps)

    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('NOT_FOUND')
    expect(malformed.status).toBe(404)
  })

  it('refuses a caller with no session', async () => {
    const response = await handleRequest(post('/billing/checkout', { variantId: '111' }), deps)

    expect(response.status).toBe(401)
    expect((await errorOf(response)).code).toBe('UNAUTHORIZED')
  })
})

describe('POST /billing/lemonsqueezy', () => {
  it('credits a paid order with the configured pack price', async () => {
    const response = await webhook(orderEvent())

    expect(await webhookStatus(response)).toBe('applied')
    expect((await credits()).balanceMicros).toBe(10_000_000)
  })

  it('accepts the variant id as the number Lemon Squeezy sends', async () => {
    expect(await webhookStatus(await webhook(orderEvent({ variantId: 111 })))).toBe('applied')

    expect((await credits()).balanceMicros).toBe(10_000_000)
  })

  it('applies a replayed delivery exactly once', async () => {
    await webhook(orderEvent())

    expect(await webhookStatus(await webhook(orderEvent()))).toBe('duplicate')
    expect((await credits()).balanceMicros).toBe(10_000_000)
  })

  it('debits a refund of the same order', async () => {
    await webhook(orderEvent())

    expect(await webhookStatus(await webhook(orderEvent({ event: 'order_refunded' })))).toBe(
      'applied'
    )
    expect((await credits()).balanceMicros).toBe(0)

    // A refund is idempotent too, and is not confused with the purchase it reverses.
    expect(await webhookStatus(await webhook(orderEvent({ event: 'order_refunded' })))).toBe(
      'duplicate'
    )
    expect((await credits()).balanceMicros).toBe(0)
  })

  it('refuses a wrong or missing signature without touching the balance', async () => {
    const wrong = await webhook(orderEvent(), { secret: 'not-the-secret' })
    const garbage = await webhook(orderEvent(), { signature: 'deadbeef' })
    const unsigned = await webhook(orderEvent(), { signature: null })

    for (const response of [wrong, garbage, unsigned]) {
      expect(response.status).toBe(401)
      expect((await errorOf(response)).code).toBe('BAD_SIGNATURE')
    }
    expect((await credits()).balanceMicros).toBe(0)
  })

  it('reports that purchases are not configured when the Worker has no secret', async () => {
    deps = makeDeps({ webhookSecret: null })
    await signIn()

    const response = await webhook(orderEvent())

    expect(response.status).toBe(503)
    expect(await errorOf(response)).toEqual({
      code: 'NOT_CONFIGURED',
      message: 'Purchases are not configured on the server yet.'
    })
  })

  it('ignores an order that is not paid yet and any other event', async () => {
    expect(await webhookStatus(await webhook(orderEvent({ status: 'pending' })))).toBe('ignored')
    expect(await webhookStatus(await webhook(orderEvent({ event: 'subscription_created' })))).toBe(
      'ignored'
    )

    expect((await credits()).balanceMicros).toBe(0)
    expect(warnings).toEqual([])
  })

  it('warns and ignores an unknown user or variant', async () => {
    expect(await webhookStatus(await webhook(orderEvent({ userId: 'nobody' })))).toBe('ignored')
    expect(await webhookStatus(await webhook(orderEvent({ userId: null })))).toBe('ignored')
    expect(
      await webhookStatus(await webhook(orderEvent({ id: 'order-2', variantId: '999' })))
    ).toBe('ignored')

    expect((await credits()).balanceMicros).toBe(0)
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('order-1')
  })

  it('warns and ignores a signed body it cannot read', async () => {
    expect(await webhookStatus(await webhook(null, { raw: 'not json at all' }))).toBe('ignored')
    expect(await webhookStatus(await webhook({ hello: 'world' }))).toBe('ignored')

    expect((await credits()).balanceMicros).toBe(0)
    expect(warnings).toHaveLength(2)
  })
})

describe('POST /billing/lemonsqueezy for the Supporter license (F-15.9)', () => {
  /** An order for the Supporter variant; everything else about the payload is the same. */
  function supporterOrder(options: OrderEventOptions = {}): unknown {
    return orderEvent({ id: 'order-s1', variantId: SUPPORTER.variantId, ...options })
  }

  it('grants the license and credits nothing', async () => {
    expect(await webhookStatus(await webhook(supporterOrder()))).toBe('applied')

    expect(await deps.store.findSupporter(USER_ID)).toEqual({
      grantedAt: START.getTime(),
      revokedAt: null
    })
    // The license is not credit: the balance and the ledger stay untouched.
    const body = await credits()
    expect(body.balanceMicros).toBe(0)
    expect(body.spend).toEqual([])
  })

  it('grants once for a replayed delivery', async () => {
    await webhook(supporterOrder())

    expect(await webhookStatus(await webhook(supporterOrder()))).toBe('duplicate')

    expect(await deps.store.findSupporter(USER_ID)).toEqual({
      grantedAt: START.getTime(),
      revokedAt: null
    })
  })

  it('revokes the license on a refund of the same order', async () => {
    await webhook(supporterOrder())

    clock = START.getTime() + DAY_MS
    expect(await webhookStatus(await webhook(supporterOrder({ event: 'order_refunded' })))).toBe(
      'applied'
    )

    expect(await deps.store.findSupporter(USER_ID)).toEqual({
      grantedAt: START.getTime(),
      revokedAt: clock
    })
    expect((await credits()).balanceMicros).toBe(0)
  })

  it('grants again when the author buys it a second time', async () => {
    await webhook(supporterOrder())
    await webhook(supporterOrder({ event: 'order_refunded' }))

    clock = START.getTime() + 30 * DAY_MS
    expect(await webhookStatus(await webhook(supporterOrder({ id: 'order-s2' })))).toBe('applied')

    expect(await deps.store.findSupporter(USER_ID)).toEqual({
      grantedAt: clock,
      revokedAt: null
    })
  })

  it('ignores the order when the Worker has no Supporter product configured', async () => {
    deps = makeDeps({ supporter: null })
    await signIn()

    expect(await webhookStatus(await webhook(supporterOrder()))).toBe('ignored')

    expect(await deps.store.findSupporter(USER_ID)).toBeNull()
    expect(warnings).toHaveLength(1)
  })
})

describe('POST /billing/lemonsqueezy: replays, staleness, refunds (S5, L8)', () => {
  it('adds the balance once when a webhook is delivered twice (acceptance check)', async () => {
    expect(await webhookStatus(await webhook(orderEvent()))).toBe('applied')
    expect(await webhookStatus(await webhook(orderEvent()))).toBe('duplicate')

    expect((await credits()).balanceMicros).toBe(10_000_000)
    const ledger = await (deps.store as TestStore).ledger()
    expect(ledger.map((row) => [row.type, row.amountMicros, row.orderId])).toEqual([
      ['topup', 10_000_000, 'order-1']
    ])
  })

  it('refuses a signed event older than the window, or with no timestamp', async () => {
    const stale = await webhook(orderEvent({ at: START.getTime() - 73 * 60 * 60_000 }))
    expect(stale.status).toBe(400)
    expect((await errorOf(stale)).code).toBe('STALE_WEBHOOK')

    const undated = await webhook(orderEvent({ at: null }))
    expect((await errorOf(undated)).code).toBe('STALE_WEBHOOK')

    expect(await webhookStatus(await webhook(orderEvent({ at: START.getTime() - 60_000 })))).toBe(
      'applied'
    )
    expect((await credits()).balanceMicros).toBe(10_000_000)
  })

  it('takes the window from the config', async () => {
    ;(deps.store as TestStore).setConfig('webhook_max_age_hours', 1)
    const response = await webhook(orderEvent({ at: START.getTime() - 2 * 60 * 60_000 }))
    expect((await errorOf(response)).code).toBe('STALE_WEBHOOK')
  })

  it('refunds what is left of a pack, then only the difference of a later refund', async () => {
    await webhook(orderEvent({ variantId: '222' }))
    await seedCharge('chat', 500_000, 1000, 100, 'req-spent')

    // $15 of the $25 pack refunded: the unused part, as the operator refunds it.
    const refund = (cents: number): Promise<Response> =>
      webhook(orderEvent({ event: 'order_refunded', variantId: '222', refundedAmount: cents }))
    expect(await webhookStatus(await refund(1500))).toBe('applied')
    expect((await credits()).balanceMicros).toBe(25_000_000 - 500_000 - 15_000_000)

    // The same delivery again changes nothing; a later, larger refund adds only the difference.
    expect(await webhookStatus(await refund(1500))).toBe('duplicate')
    expect(await webhookStatus(await refund(2000))).toBe('applied')
    expect((await credits()).balanceMicros).toBe(25_000_000 - 500_000 - 20_000_000)
  })

  it('never refunds more than the pack', async () => {
    await webhook(orderEvent())
    await webhook(orderEvent({ event: 'order_refunded', refundedAmount: 99_999 }))
    expect((await credits()).balanceMicros).toBe(0)
  })
})

describe('the $30 app license (M1)', () => {
  it('is what GET /license offers, and the webhook grants the license, not balance', async () => {
    const offered = LicenseResult.parse(
      await (await handleRequest(get('/license', TOKEN), deps)).json()
    )
    expect(offered.product).toEqual({ variantId: '444', priceCents: 3000 })

    const checkout = await handleRequest(
      post('/billing/checkout', { variantId: '444' }, TOKEN),
      deps
    )
    expect(new URL(CheckoutResult.parse(await checkout.json()).url).pathname).toBe('/buy/app')

    expect(
      await webhookStatus(await webhook(orderEvent({ id: 'order-a1', variantId: '444' })))
    ).toBe('applied')
    expect(await deps.store.findSupporter(USER_ID)).toEqual({
      grantedAt: START.getTime(),
      revokedAt: null
    })
    expect((await credits()).balanceMicros).toBe(0)
  })
})

describe('GET /pricing (P1, P5)', () => {
  async function pricing(): Promise<PricingResult> {
    const response = await handleRequest(get('/pricing'), deps)
    expect(response.status).toBe(200)
    return PricingResult.parse(await response.json())
  }

  it('serves the defaults without a session', async () => {
    const body = await pricing()

    expect(body).toMatchObject({
      currency: 'USD',
      markup: 0.2,
      appPriceMicros: 30_000_000,
      minPackMicros: 10_000_000,
      packs: [
        { variantId: '111', priceCents: 1000 },
        { variantId: '222', priceCents: 2500 }
      ],
      trialGrantMicros: 2_000_000,
      quoteThresholdMicros: 250_000,
      estimateSafetyFactor: 1.2,
      lowBalanceWarningMicros: 2_000_000,
      holdExpiryMinutes: 10,
      refundWindowDays: 30,
      limits: { requestsPerMinute: 60, maxInputChars: 200_000, maxOutputTokens: 4000 },
      routing: { tiers: { fast: 'openai/gpt-5.4-mini', strong: 'openai/gpt-5.4' }, features: {} },
      wordCosts: { lineEdit: null, consistencyCheck: null }
    })
    expect(body.models.map((model) => model.id)).toEqual(DEFAULT_HOSTED_MODELS.map((m) => m.id))
    // The checkout URLs and the aliases stay on the Worker.
    expect(JSON.stringify(body)).not.toContain('/buy/')
    expect(JSON.stringify(body)).not.toContain('aliases')
  })

  it('answers a config change on the next call, with no release', async () => {
    const store = deps.store as TestStore
    store.setConfig('markup', 0.25)
    store.setConfig('word_costs', { lineEdit: 0.00002, consistencyCheck: null })
    store.setConfig('routing', {
      tiers: { fast: 'openai/gpt-5.4-nano', strong: 'openai/gpt-5.4' },
      features: { tags: 'fast' }
    })

    const body = await pricing()
    expect(body.markup).toBe(0.25)
    expect(body.wordCosts.lineEdit).toBe(0.00002)
    expect(body.routing.tiers.fast).toBe('openai/gpt-5.4-nano')
    expect(body.routing.features).toEqual({ tags: 'fast' })
  })

  it('keeps the default for a malformed row, and routing that names an unpriced model', async () => {
    const store = deps.store as TestStore
    store.setConfig('markup', '"twenty percent"')
    store.setConfig('routing', { tiers: { fast: 'made/up', strong: 'openai/gpt-5.4' } })
    store.setConfig('no_such_key', 1)

    const body = await pricing()
    expect(body.markup).toBe(0.2)
    expect(body.routing.tiers.fast).toBe('openai/gpt-5.4-mini')
    expect(warnings).toHaveLength(3)
  })

  it('does not sell a configured pack below the minimum pack (M4)', async () => {
    deps = makeDeps({
      packs: [
        { variantId: '100', priceCents: 500, url: 'https://mythscribe.lemonsqueezy.com/buy/five' },
        ...PACKS
      ]
    })
    await signIn()

    expect((await pricing()).packs.map((pack) => pack.variantId)).toEqual(['111', '222'])
    expect((await credits()).packs.map((pack) => pack.variantId)).toEqual(['111', '222'])
    const checkout = await handleRequest(
      post('/billing/checkout', { variantId: '100' }, TOKEN),
      deps
    )
    expect(checkout.status).toBe(404)
  })
})

describe('GET /usage (E7)', () => {
  function usage(query = ''): Promise<Response> {
    return handleRequest(get(`/usage${query}`, TOKEN), deps)
  }

  it('pages the ledger newest first, with every entry type and the charge details', async () => {
    await webhook(orderEvent())
    clock += 1
    await seedCharge('chat', 25_000, 2000, 500, 'req-a')
    clock += 1
    await seedCharge('ghostText', 2400, 1000, 100, 'req-b')

    const first = UsageResult.parse(await (await usage('?limit=2')).json())
    expect(first.entries.map((entry) => [entry.type, entry.amountMicros, entry.feature])).toEqual([
      ['charge', -2400, 'ghostText'],
      ['charge', -25_000, 'chat']
    ])
    expect(first.entries[0]).toMatchObject({
      model: 'openai/gpt-5.4-mini',
      tokensIn: 1000,
      tokensOut: 100,
      tokensCached: 0,
      requestId: 'req-b',
      at: START.getTime() + 2
    })
    expect(first.nextCursor).not.toBeNull()

    const cursor = encodeURIComponent(first.nextCursor ?? '')
    const second = UsageResult.parse(await (await usage(`?limit=2&cursor=${cursor}`)).json())
    expect(second.entries.map((entry) => entry.type)).toEqual(['topup'])
    expect(second.nextCursor).toBeNull()
  })

  it('refuses a malformed cursor and a caller with no session', async () => {
    const bad = await usage('?cursor=nonsense')
    expect(bad.status).toBe(400)
    expect((await errorOf(bad)).code).toBe('BAD_REQUEST')
    expect((await handleRequest(get('/usage'), deps)).status).toBe(401)
  })
})
