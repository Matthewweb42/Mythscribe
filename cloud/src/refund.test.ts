import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CheckoutResult,
  CloudApiError,
  type CloudErrorCode,
  CreditsResult,
  RefundResult,
  SESSION_TTL_MS
} from '../../src/shared/cloudApi'
import { type ConfiguredPack, REFUND_HOLD_MS } from './credits'
import { hmacSha256Hex, sha256Hex } from './crypto'
import type { Mailer } from './email'
import { handleRequest, type WorkerDeps } from './index'
import type { LemonSqueezyApi, RefundOutcome } from './lemonSqueezy'
import type { Upstream } from './openai'
import { type HoldRow, plainEntry } from './store'
import { testStore, type TestStore } from './testing/sqliteD1'

/**
 * The $5 starter pack and the self-serve refund of unused balance (2026-10-08), through the real
 * router and the real SQL. Lemon Squeezy is a fake `LemonSqueezyApi` that records every call, so
 * no test reaches the real API. The money rules each have a test: a webhook delivered twice, a
 * refund racing a spend, a refund after a dispute, a negative balance blocking hosted AI, a second
 * starter purchase after a refund, the minimum-pack exemption for the starter variant alone, and
 * an unverified email.
 */

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const USER_ID = 'user-1'
const TOKEN = 'session-token'
const OTHER_ID = 'user-2'
const OTHER_TOKEN = 'other-token'
const SECRET = 'lemon-webhook-secret'
const START = new Date('2026-10-08T12:00:00.000Z')
const DAY_MS = 24 * 60 * 60_000
const USD = 1_000_000

const PACKS: ConfiguredPack[] = [
  { variantId: '111', priceCents: 1000, url: 'https://mythscribe.lemonsqueezy.com/buy/ten' },
  { variantId: '222', priceCents: 2500, url: 'https://mythscribe.lemonsqueezy.com/buy/twenty' },
  // Configured by mistake under the $10 minimum: not on sale, unlike the starter.
  { variantId: '555', priceCents: 500, url: 'https://mythscribe.lemonsqueezy.com/buy/five' }
]
const STARTER: ConfiguredPack = {
  variantId: '777',
  priceCents: 500,
  url: 'https://mythscribe.lemonsqueezy.com/buy/starter'
}
const APP_LICENSE: ConfiguredPack = {
  variantId: '444',
  priceCents: 3000,
  url: 'https://mythscribe.lemonsqueezy.com/buy/app'
}

const silentMailer: Mailer = { send: () => Promise.resolve() }

/** A gateway the tests never expect to reach: every hosted request here is refused first. */
const unreachableUpstream: Upstream = {
  complete: () => Promise.reject(new Error('the gateway must not be called')),
  stream: () => {
    throw new Error('the gateway must not be called')
  }
}

interface FakeLemonSqueezy extends LemonSqueezyApi {
  calls: { orderId: string; amountCents: number | null }[]
  /** What the next calls answer; `refunded` by default. */
  outcome: RefundOutcome
  /** Runs inside the call, before it answers: a spend or a webhook racing the refund. */
  during: (() => Promise<void>) | null
}

function fakeLemonSqueezy(): FakeLemonSqueezy {
  const fake: FakeLemonSqueezy = {
    calls: [],
    outcome: { status: 'refunded' },
    during: null,
    async refundOrder(orderId, amountCents) {
      fake.calls.push({ orderId, amountCents })
      if (fake.during) await fake.during()
      return fake.outcome
    }
  }
  return fake
}

let deps: WorkerDeps
let store: TestStore
let lemon: FakeLemonSqueezy
let clock: number
let counter: number
let warnings: string[]

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store,
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => `id-${(counter += 1)}`,
    revealLink: false,
    packs: PACKS,
    supporter: null,
    appLicense: APP_LICENSE,
    starter: STARTER,
    lemonSqueezy: lemon,
    webhookSecret: SECRET,
    upstream: unreachableUpstream,
    signingKey: null,
    ...overrides
  }
}

async function addUser(id: string, email: string, token: string, verified: boolean): Promise<void> {
  await store.insertUser({
    id,
    email,
    createdAt: clock,
    emailVerifiedAt: verified ? clock : null
  })
  await store.insertSession({
    tokenHash: await sha256Hex(token),
    userId: id,
    createdAt: clock,
    expiresAt: clock + SESSION_TTL_MS,
    lastSeenAt: clock,
    revokedAt: null
  })
}

beforeEach(async () => {
  clock = START.getTime()
  counter = 0
  store = testStore()
  lemon = fakeLemonSqueezy()
  deps = makeDeps()
  warnings = []
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(' '))
  })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
  await addUser(USER_ID, EMAIL, TOKEN, true)
})

afterEach(() => {
  vi.restoreAllMocks()
})

function get(path: string, token: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` }
  })
}

function post(path: string, body: unknown, token: string | null = TOKEN): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: token === null ? undefined : { Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  })
}

async function credits(token = TOKEN): Promise<CreditsResult> {
  const response = await handleRequest(get('/credits', token), deps)
  expect(response.status).toBe(200)
  return CreditsResult.parse(await response.json())
}

async function available(userId = USER_ID): Promise<number> {
  const balance = await store.getBalance(userId, clock)
  return balance.ledgerMicros - balance.heldMicros
}

async function expectError(response: Response, code: CloudErrorCode): Promise<CloudApiError> {
  const body = CloudApiError.parse(await response.json())
  expect(body.code).toBe(code)
  return body
}

function checkout(variantId: string, token = TOKEN): Promise<Response> {
  return handleRequest(post('/billing/checkout', { variantId }, token), deps)
}

function refund(orderId: string, token: string | null = TOKEN): Promise<Response> {
  return handleRequest(post('/billing/refund', { orderId }, token), deps)
}

async function refunded(response: Response): Promise<RefundResult> {
  expect(response.status).toBe(200)
  return RefundResult.parse(await response.json())
}

interface OrderOptions {
  event?: 'order_created' | 'order_refunded'
  id?: string
  userId?: string
  variantId?: string
  /** Cents refunded so far on the order (cumulative); absent means the whole order. */
  refundedAmount?: number
  /** What the customer was charged in US cents, and the tax in it; absent on older payloads. */
  totalUsd?: number
  taxUsd?: number
}

/** A signed Lemon Squeezy order event, as the webhook receives it. */
async function webhook({
  event = 'order_created',
  id = 'order-1',
  userId = USER_ID,
  variantId = '111',
  refundedAmount,
  totalUsd,
  taxUsd
}: OrderOptions = {}): Promise<string> {
  const stamp = new Date(clock).toISOString()
  const body = JSON.stringify({
    meta: { event_name: event, custom_data: { user_id: userId } },
    data: {
      type: 'orders',
      id,
      attributes: {
        status: event === 'order_created' ? 'paid' : 'refunded',
        created_at: stamp,
        updated_at: stamp,
        refunded_at: event === 'order_refunded' ? stamp : null,
        ...(refundedAmount === undefined ? {} : { refunded_amount: refundedAmount }),
        ...(totalUsd === undefined ? {} : { total_usd: totalUsd }),
        ...(taxUsd === undefined ? {} : { tax_usd: taxUsd }),
        first_order_item: { variant_id: Number(variantId) }
      }
    }
  })
  const response = await handleRequest(
    new Request(`${ORIGIN}/billing/lemonsqueezy`, {
      method: 'POST',
      headers: { 'X-Signature': await hmacSha256Hex(SECRET, body) },
      body
    }),
    deps
  )
  expect(response.status).toBe(200)
  return (await response.json<{ status: string }>()).status
}

let spends = 0

/** Spend `micros` the way an answered AI request does: one charge row. */
async function spend(micros: number, userId = USER_ID): Promise<void> {
  spends += 1
  await store.appendLedgerEntry({
    ...plainEntry({
      id: `charge-${spends}`,
      userId,
      type: 'charge',
      amountMicros: -micros,
      idempotencyKey: `charge:req-${spends}`,
      createdAt: clock
    }),
    requestId: `req-${spends}`,
    feature: 'chat',
    model: 'openai/gpt-5.4-mini'
  })
}

/** An AI request's hold, placed directly: what a hosted request does before it is forwarded. */
function aiHold(micros: number, key: string): HoldRow {
  return {
    id: `hold-${key}`,
    userId: USER_ID,
    idempotencyKey: key,
    requestId: `rq-${key}`,
    feature: 'chat',
    model: 'openai/gpt-5.4-mini',
    amountMicros: micros,
    prices: { inputMicrosPerM: 1, outputMicrosPerM: 1, cachedMicrosPerM: null, markupBps: 0 },
    status: 'active',
    createdAt: clock,
    expiresAt: clock + 10 * 60_000,
    closedAt: null,
    chargeMicros: null
  }
}

async function refundRows(): Promise<number[]> {
  return (await store.ledger()).filter((row) => row.type === 'refund').map((r) => r.amountMicros)
}

function aiRequest(): Promise<Response> {
  return handleRequest(
    post('/ai/complete', {
      feature: 'chat',
      model: 'openai/gpt-5.4-mini',
      messages: [{ role: 'user', content: 'Why is Mara on the ridge?' }],
      maxTokens: 200,
      stream: false
    }),
    deps
  )
}

describe('the starter pack: checkout', () => {
  it('sells the $5 starter to a verified account that never bought it, below the $10 minimum', async () => {
    const body = await credits()
    expect(body.starter).toEqual({ variantId: '777', priceCents: 500 })
    // The minimum still applies to every other variant: the $5 pack is not on sale.
    expect(body.packs.map((pack) => pack.variantId)).toEqual(['111', '222'])
    expect(warnings.some((line) => line.includes('Pack 555 is below the minimum'))).toBe(true)

    const response = await checkout('777')
    expect(response.status).toBe(200)
    const { url } = CheckoutResult.parse(await response.json())
    expect(url).toContain('/buy/starter')
    expect(url).toContain(`checkout%5Bcustom%5D%5Buser_id%5D=${USER_ID}`)

    await expectError(await checkout('555'), 'NOT_FOUND')
  })

  it('needs no app license', async () => {
    // Nothing licensed on this account, and the license product exists: the starter still sells.
    expect(await store.findSupporter(USER_ID)).toBeNull()
    expect((await checkout('777')).status).toBe(200)
  })

  it('refuses an account whose email is not verified', async () => {
    await addUser(OTHER_ID, 'other@example.com', OTHER_TOKEN, false)
    expect((await credits(OTHER_TOKEN)).starter).toBeNull()
    const error = await expectError(await checkout('777', OTHER_TOKEN), 'NOT_ELIGIBLE')
    expect(error.message).toContain('verified email')
  })

  it('refuses a second starter, even after the first was refunded', async () => {
    expect(await webhook({ id: 'starter-1', variantId: '777' })).toBe('applied')
    expect((await credits()).starter).toBeNull()
    await expectError(await checkout('777'), 'NOT_ELIGIBLE')

    await refunded(await refund('starter-1'))
    expect(await available()).toBe(0)
    expect((await credits()).starter).toBeNull()
    const error = await expectError(await checkout('777'), 'NOT_ELIGIBLE')
    expect(error.message).toContain('one per account')
  })

  it('is off sale when the Worker has no starter configured', async () => {
    deps = makeDeps({ starter: null })
    expect((await credits()).starter).toBeNull()
    await expectError(await checkout('777'), 'NOT_FOUND')
  })
})

describe('the starter pack: webhook', () => {
  it('credits $5 once when the webhook is delivered twice', async () => {
    expect(await webhook({ id: 'starter-1', variantId: '777' })).toBe('applied')
    expect(await webhook({ id: 'starter-1', variantId: '777' })).toBe('duplicate')
    expect(await available()).toBe(5 * USD)
    expect(await store.findStarterPurchase(USER_ID)).toEqual({
      orderId: 'starter-1',
      purchasedAt: clock
    })
  })

  it('does not credit a second starter order (the buy link is public) and refunds it in full', async () => {
    await webhook({ id: 'starter-1', variantId: '777' })
    expect(await webhook({ id: 'starter-2', variantId: '777' })).toBe('ignored')
    expect(await available()).toBe(5 * USD)
    expect(lemon.calls).toEqual([{ orderId: 'starter-2', amountCents: null }])

    // Its refund webhook then finds nothing to take back.
    expect(await webhook({ event: 'order_refunded', id: 'starter-2', variantId: '777' })).toBe(
      'ignored'
    )
    expect(await available()).toBe(5 * USD)
    expect(await refundRows()).toEqual([])
  })

  it('does not credit a second starter order after the first was refunded', async () => {
    await webhook({ id: 'starter-1', variantId: '777' })
    await webhook({ event: 'order_refunded', id: 'starter-1', variantId: '777' })
    expect(await available()).toBe(0)

    expect(await webhook({ id: 'starter-2', variantId: '777' })).toBe('ignored')
    expect(await available()).toBe(0)
  })

  it('does not credit a starter order from an unverified account', async () => {
    await addUser(OTHER_ID, 'other@example.com', OTHER_TOKEN, false)
    expect(await webhook({ id: 'starter-9', userId: OTHER_ID, variantId: '777' })).toBe('ignored')
    expect(await available(OTHER_ID)).toBe(0)
    expect(await store.findStarterPurchase(OTHER_ID)).toBeNull()
    expect(lemon.calls).toEqual([{ orderId: 'starter-9', amountCents: null }])
  })

  it('leaves a refused starter order to the operator when no API key is set', async () => {
    deps = makeDeps({ lemonSqueezy: null })
    await webhook({ id: 'starter-1', variantId: '777' })
    expect(await webhook({ id: 'starter-2', variantId: '777' })).toBe('ignored')
    expect(warnings.some((line) => line.includes('refund it by hand'))).toBe(true)
  })
})

describe('POST /billing/refund', () => {
  it('refunds the unused balance of a purchase, holding it before Lemon Squeezy is called', async () => {
    await webhook()
    await spend(3 * USD)
    lemon.during = async () => {
      // While Lemon Squeezy works, the refund is held: nothing of it can be spent.
      expect(await available()).toBe(0)
    }

    const result = await refunded(await refund('order-1'))
    expect(result).toEqual({ refundedMicros: 7 * USD, balanceMicros: 0 })
    expect(lemon.calls).toEqual([{ orderId: 'order-1', amountCents: 700 }])
    expect(await refundRows()).toEqual([-7 * USD])
    const [hold] = await store.holds()
    expect(hold).toMatchObject({ status: 'settled', amountMicros: 7 * USD, chargeMicros: 7 * USD })
  })

  it('is idempotent: a repeat answers the first result and refunds nothing more', async () => {
    await webhook()
    await refunded(await refund('order-1'))
    const again = await refunded(await refund('order-1'))
    expect(again).toEqual({ refundedMicros: 10 * USD, balanceMicros: 0 })
    expect(lemon.calls).toHaveLength(1)
    expect(await refundRows()).toEqual([-10 * USD])
  })

  it('takes nothing off twice when the webhook for the same refund arrives (before or after)', async () => {
    await webhook({ variantId: '222' })
    await spend(5 * USD)
    // After: the webhook reports the cumulative refund the app's call made.
    await refunded(await refund('order-1'))
    expect(await webhook({ event: 'order_refunded', variantId: '222', refundedAmount: 2000 })).toBe(
      'duplicate'
    )
    expect(await refundRows()).toEqual([-20 * USD])
    expect(await available()).toBe(0)

    // Before: a second purchase whose webhook lands while the app's call is still running.
    await webhook({ id: 'order-2' })
    lemon.during = async () => {
      expect(await webhook({ event: 'order_refunded', id: 'order-2', refundedAmount: 1000 })).toBe(
        'applied'
      )
    }
    await refunded(await refund('order-2'))
    expect(await refundRows()).toEqual([-20 * USD, -10 * USD])
    expect(await available()).toBe(0)
  })

  it('never refunds more than the order, even with more unused balance', async () => {
    await webhook({ id: 'order-1' })
    await webhook({ id: 'order-2', variantId: '222' })
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(10 * USD)
    expect(await available()).toBe(25 * USD)
    expect(lemon.calls).toEqual([{ orderId: 'order-1', amountCents: 1000 }])
  })

  it('never refunds more than the unused balance, and refuses when it is spent', async () => {
    await webhook({ id: 'order-1' })
    await webhook({ id: 'order-2', variantId: '222' })
    await spend(28 * USD + 1)
    // $6.99999 unused, rounded down to cents.
    expect((await refunded(await refund('order-2'))).refundedMicros).toBe(6_990_000)
    expect(await available()).toBe(9_999)

    const error = await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
    expect(error.message).toContain('Nothing unused')
    expect(lemon.calls).toHaveLength(1)
  })

  it('never refunds money that was given rather than paid', async () => {
    await store.appendLedgerEntry(
      plainEntry({
        id: 'grant',
        userId: USER_ID,
        type: 'trial_grant',
        amountMicros: 2 * USD,
        idempotencyKey: 'trial_grant:x',
        createdAt: clock
      })
    )
    await webhook()
    await spend(1 * USD)
    // Spending counts against paid money first: $9 of the $10 pack is unused, the $2 grant stays.
    expect(lemon.calls).toHaveLength(0)
    expect((await credits()).refunds[0]?.refundableMicros).toBe(9 * USD)
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(9 * USD)
    expect(await available()).toBe(2 * USD)
  })

  it('cannot be overtaken by a spend: a request racing the refund finds the money held', async () => {
    await webhook()
    await spend(4 * USD)
    lemon.during = async () => {
      // $6 is being refunded; a request needing any of it is refused while Lemon Squeezy works.
      expect((await store.placeHold(aiHold(1, 'race-1'), clock)).status).toBe('insufficient')
    }
    await refunded(await refund('order-1'))
    expect(await available()).toBe(0)
  })

  it('cannot overtake a spend: a request already holding money shrinks the refund', async () => {
    await webhook()
    expect((await store.placeHold(aiHold(4 * USD, 'held'), clock)).status).toBe('placed')
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(6 * USD)
    expect(lemon.calls).toEqual([{ orderId: 'order-1', amountCents: 600 }])
  })

  it('refuses when the balance changes between the check and the hold', async () => {
    await webhook()
    const placeRefundHold = store.placeRefundHold.bind(store)
    deps = makeDeps({
      store: {
        ...store,
        placeRefundHold: async (hold, now) => {
          await spend(1)
          return placeRefundHold(hold, now)
        }
      }
    })
    const error = await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
    expect(error.message).toContain('balance changed')
    expect(lemon.calls).toHaveLength(0)
    expect(await refundRows()).toEqual([])
  })

  it('refunds within 30 days of the purchase and not after', async () => {
    await webhook({ id: 'order-1' })
    clock += 1
    await webhook({ id: 'order-2' })
    clock += 30 * DAY_MS
    await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
    expect((await credits()).refunds.map((order) => order.orderId)).toEqual(['order-2'])
    expect((await refunded(await refund('order-2'))).refundedMicros).toBe(10 * USD)
  })

  it('releases the hold when Lemon Squeezy refuses, so a retry can run', async () => {
    await webhook()
    lemon.outcome = { status: 'refused', httpStatus: 422 }
    await expectError(await refund('order-1'), 'UPSTREAM')
    expect(await available()).toBe(10 * USD)
    expect(await refundRows()).toEqual([])

    lemon.outcome = { status: 'refunded' }
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(10 * USD)
    expect(lemon.calls).toHaveLength(2)
  })

  it('keeps the money held when Lemon Squeezy does not answer, until the webhook says', async () => {
    await webhook()
    lemon.outcome = { status: 'unknown' }
    await expectError(await refund('order-1'), 'UPSTREAM')
    expect(await available()).toBe(0)
    expect((await store.holds())[0]?.expiresAt).toBe(clock + REFUND_HOLD_MS)
    expect((await credits()).refunds[0]).toMatchObject({ pending: true, refundableMicros: 0 })

    // A retry cannot send a second refund while the first may have happened.
    await expectError(await refund('order-1'), 'DUPLICATE_REQUEST')
    expect(lemon.calls).toHaveLength(1)

    // The webhook confirms it: one refund row, the hold closed, no double count.
    expect(await webhook({ event: 'order_refunded', refundedAmount: 1000 })).toBe('applied')
    expect(await refundRows()).toEqual([-10 * USD])
    expect(await available()).toBe(0)
    expect((await store.holds())[0]?.status).toBe('settled')
  })

  it('fails clearly when the Lemon Squeezy API key is not set', async () => {
    deps = makeDeps({ lemonSqueezy: null })
    await webhook()
    const error = await expectError(await refund('order-1'), 'NOT_CONFIGURED')
    expect(error.message).toBe('Refunds are not configured on the server yet.')
    expect(await available()).toBe(10 * USD)
  })

  it('refunds only purchases of this account that added balance', async () => {
    await addUser(OTHER_ID, 'other@example.com', OTHER_TOKEN, true)
    await webhook({ id: 'theirs', userId: OTHER_ID })
    await webhook({ id: 'license', variantId: '444' })
    await expectError(await refund('theirs'), 'NOT_FOUND')
    await expectError(await refund('license'), 'NOT_FOUND')
    await expectError(await refund('nope'), 'NOT_FOUND')
    await expectError(await refund('theirs', null), 'UNAUTHORIZED')
    expect(lemon.calls).toHaveLength(0)
  })
})

describe('refunds and disputes on the provider side (webhook)', () => {
  it('debits a dispute once, leaves the balance below zero, and blocks hosted AI', async () => {
    await webhook()
    await spend(4 * USD)
    // A lost dispute reaches the Worker as a refund of the whole order.
    expect(await webhook({ event: 'order_refunded' })).toBe('applied')
    expect(await webhook({ event: 'order_refunded' })).toBe('duplicate')
    expect(await available()).toBe(-4 * USD)

    const blocked = await aiRequest()
    expect(blocked.status).toBe(402)
    const error = await expectError(blocked, 'INSUFFICIENT_CREDITS')
    expect(error.message).toContain('below zero')
    // The starter is still on offer to an account that never bought it.
    expect(error.offer).toEqual({
      kind: 'starter',
      variantId: '777',
      priceCents: 500,
      refundWindowDays: 30
    })
    expect(await store.holds()).toEqual([])
  })

  it('refuses a self-serve refund after a dispute took the order back', async () => {
    await webhook()
    await webhook({ event: 'order_refunded' })
    await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
    expect((await credits()).refunds).toEqual([])
    expect(lemon.calls).toHaveLength(0)
  })

  it('takes back at most what the order added, whatever amount the event reports', async () => {
    await webhook()
    expect(await webhook({ event: 'order_refunded', refundedAmount: 99_999 })).toBe('applied')
    expect(await refundRows()).toEqual([-10 * USD])
  })

  it('ignores a refund for an order that never added balance', async () => {
    expect(await webhook({ event: 'order_refunded', id: 'ghost' })).toBe('ignored')
    expect(await refundRows()).toEqual([])
  })
})

describe('the offer on a refused hosted request', () => {
  it('offers the starter at $0, the packs once it was bought, and says when the balance is below zero', async () => {
    const atZero = await expectError(await aiRequest(), 'INSUFFICIENT_CREDITS')
    expect(atZero.offer).toEqual({
      kind: 'starter',
      variantId: '777',
      priceCents: 500,
      refundWindowDays: 30
    })

    await webhook({ id: 'starter-1', variantId: '777' })
    await spend(5 * USD)
    const spent = await expectError(await aiRequest(), 'INSUFFICIENT_CREDITS')
    expect(spent.offer).toEqual({ kind: 'packs', negative: false })
    expect(spent.message).not.toContain('below zero')

    await spend(1)
    const negative = await expectError(await aiRequest(), 'INSUFFICIENT_CREDITS')
    expect(negative.offer).toEqual({ kind: 'packs', negative: true })
  })
})

describe('GET /credits: refundable purchases', () => {
  it('lists each purchase in the window with what a refund would return now', async () => {
    await webhook({ id: 'order-1' })
    clock += 1000
    await webhook({ id: 'order-2', variantId: '222' })
    await spend(30 * USD)

    expect((await credits()).refunds).toEqual([
      {
        orderId: 'order-2',
        paidMicros: 25 * USD,
        purchasedAt: clock,
        refundUntil: clock + 30 * DAY_MS,
        refundableMicros: 5 * USD,
        pending: false
      },
      {
        orderId: 'order-1',
        paidMicros: 10 * USD,
        purchasedAt: clock - 1000,
        refundUntil: clock - 1000 + 30 * DAY_MS,
        refundableMicros: 5 * USD,
        pending: false
      }
    ])

    // One self-serve refund per purchase: a refunded one leaves the list.
    await refunded(await refund('order-2'))
    expect((await credits()).refunds.map((order) => order.orderId)).toEqual(['order-1'])
    expect((await credits()).refunds[0]?.refundableMicros).toBe(0)
  })

  it('lists nothing when the window is set to zero days', async () => {
    store.setConfig('refund_window_days', 0)
    await webhook()
    expect((await credits()).refunds).toEqual([])
    await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
  })
})

describe('verifier: a refund webhook that does not cover a running self-serve refund', () => {
  it('keeps the self-serve hold when a replayed earlier refund lands while Lemon Squeezy has not answered', async () => {
    await webhook()
    // The operator refunded $2 by hand; its webhook landed.
    expect(await webhook({ event: 'order_refunded', refundedAmount: 200 })).toBe('applied')
    lemon.outcome = { status: 'unknown' }
    lemon.during = async () => {
      // Lemon Squeezy redelivers that same $2 event while the app's $8 refund is in flight.
      expect(await webhook({ event: 'order_refunded', refundedAmount: 200 })).toBe('duplicate')
    }
    await expectError(await refund('order-1'), 'UPSTREAM')
    // The $8 may have been refunded: it must stay held until a webhook covering it arrives.
    expect(await available()).toBe(0)
    expect((await store.holds())[0]?.status).toBe('active')
  })

  it('does not report a refused self-serve refund as done after a replayed earlier refund', async () => {
    await webhook()
    expect(await webhook({ event: 'order_refunded', refundedAmount: 200 })).toBe('applied')
    lemon.outcome = { status: 'refused', httpStatus: 422 }
    lemon.during = async () => {
      expect(await webhook({ event: 'order_refunded', refundedAmount: 200 })).toBe('duplicate')
    }
    await expectError(await refund('order-1'), 'UPSTREAM')
    expect(await refundRows()).toEqual([-2 * USD])
    // Nothing of the $8 left the account, so a retry must reach Lemon Squeezy again rather than
    // answer "refunded $8".
    lemon.outcome = { status: 'refunded' }
    lemon.during = null
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(8 * USD)
    expect(lemon.calls).toHaveLength(2)
  })

  it('debits once when the webhook lands after the sweep released an unanswered refund hold', async () => {
    await webhook()
    await spend(3 * USD)
    lemon.outcome = { status: 'unknown' }
    await expectError(await refund('order-1'), 'UPSTREAM')
    clock += REFUND_HOLD_MS
    expect(await store.releaseExpiredHolds(clock)).toBe(1)
    expect(await available()).toBe(7 * USD)
    expect(await webhook({ event: 'order_refunded', refundedAmount: 700 })).toBe('applied')
    expect(await webhook({ event: 'order_refunded', refundedAmount: 700 })).toBe('duplicate')
    expect(await refundRows()).toEqual([-7 * USD])
    expect(await available()).toBe(0)
    await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
  })
})

describe('refunds never return more than the customer paid for the order', () => {
  it('refunds a discounted order at most its discounted price, though it credited the full pack', async () => {
    await webhook({ totalUsd: 800, taxUsd: 0 })
    expect(await available()).toBe(10 * USD)
    expect((await credits()).refunds[0]).toMatchObject({
      paidMicros: 8 * USD,
      refundableMicros: 8 * USD
    })
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(8 * USD)
    expect(lemon.calls).toEqual([{ orderId: 'order-1', amountCents: 800 }])
    // The $2 the discount gave stays spendable and is never refundable.
    expect(await available()).toBe(2 * USD)
    expect((await credits()).refunds).toEqual([])
    // A repeat answers the first result and asks Lemon Squeezy for nothing more.
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(8 * USD)
    expect(lemon.calls).toHaveLength(1)
  })

  it('caps at the pre-tax price: the tax in the total is never refunded as balance', async () => {
    await webhook({ totalUsd: 1210, taxUsd: 210 })
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(10 * USD)
    expect(lemon.calls).toEqual([{ orderId: 'order-1', amountCents: 1000 }])
  })

  it('refunds nothing of an order a 100 % discount made free', async () => {
    await webhook({ totalUsd: 0, taxUsd: 0 })
    expect(await available()).toBe(10 * USD)
    expect((await credits()).refunds).toEqual([])
    await expectError(await refund('order-1'), 'NOT_ELIGIBLE')
    expect(lemon.calls).toEqual([])
  })

  it('caps a discounted refund after spending at what is left of the paid price', async () => {
    await webhook({ totalUsd: 800, taxUsd: 0 })
    await spend(1 * USD)
    // Unused balance $9, paid $8: the refund is $8, never the $9.
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(8 * USD)
  })

  it('caps at the credit when the order event carries no amount (as before)', async () => {
    await webhook()
    expect((await refunded(await refund('order-1'))).refundedMicros).toBe(10 * USD)
  })
})

describe('a refund webhook closes a running self-serve refund only when it covers it', () => {
  it('settles the hold once a later webhook covers the earlier refunds plus the hold', async () => {
    await webhook()
    expect(await webhook({ event: 'order_refunded', refundedAmount: 200 })).toBe('applied')
    lemon.outcome = { status: 'unknown' }
    await expectError(await refund('order-1'), 'UPSTREAM')
    // An operator refund of $1 more lands first: $3 refunded, the $8 hold still running.
    expect(await webhook({ event: 'order_refunded', refundedAmount: 300 })).toBe('applied')
    expect((await store.holds())[0]?.status).toBe('active')
    // Then the app's $8 shows up in the cumulative: the order is refunded in full, the hold closes.
    expect(await webhook({ event: 'order_refunded', refundedAmount: 1000 })).toBe('applied')
    expect((await store.holds())[0]?.status).toBe('settled')
    expect(await refundRows()).toEqual([-2 * USD, -1 * USD, -7 * USD])
    expect(await available()).toBe(0)
  })

  it('does not settle on a webhook in the same millisecond that predates the hold', async () => {
    await webhook()
    // Same clock for the earlier refund, the hold, and the replay: timing cannot tell them apart.
    expect(await webhook({ event: 'order_refunded', refundedAmount: 500 })).toBe('applied')
    lemon.outcome = { status: 'unknown' }
    lemon.during = async () => {
      expect(await webhook({ event: 'order_refunded', refundedAmount: 500 })).toBe('duplicate')
    }
    await expectError(await refund('order-1'), 'UPSTREAM')
    expect((await store.holds())[0]).toMatchObject({ status: 'active', amountMicros: 5 * USD })
    expect(await available()).toBe(0)
  })
})
