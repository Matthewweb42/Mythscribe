import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CheckoutResult,
  CloudApiError,
  CreditsResult,
  isCheckoutUrl,
  SESSION_TTL_MS
} from '../../src/shared/cloudApi'
import type { AiDeps } from './ai'
import { type ConfiguredPack, hasCredit, meterRequest } from './credits'
import { hmacSha256Hex, sha256Hex } from './crypto'
import type { Mailer } from './email'
import { handleRequest } from './index'
import { memoryStore } from './store'

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const USER_ID = 'user-1'
const TOKEN = 'session-token'
const SECRET = 'lemon-webhook-secret'
const START = new Date('2026-09-19T12:00:00.000Z')

const PACKS: ConfiguredPack[] = [
  { variantId: '111', priceCents: 500, url: 'https://mythscribe.lemonsqueezy.com/buy/five' },
  { variantId: '222', priceCents: 2000, url: 'https://mythscribe.lemonsqueezy.com/buy/twenty' }
]

const silentMailer: Mailer = { send: () => Promise.resolve() }

let deps: AiDeps
let clock: number
let counter: number
let warnings: string[]

function makeDeps(overrides: Partial<AiDeps> = {}): AiDeps {
  return {
    store: memoryStore(),
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => `evt-${(counter += 1)}`,
    revealLink: false,
    packs: PACKS,
    webhookSecret: SECRET,
    // F-15.4: the AI proxy has its own tests in `ai.test.ts`.
    upstream: null,
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
}

/** A Lemon Squeezy `order_created` body, trimmed to the fields the Worker reads. */
function orderEvent({
  event = 'order_created',
  id = 'order-1',
  status = 'paid',
  userId = USER_ID,
  variantId = '111'
}: OrderEventOptions = {}): unknown {
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
        total: 500,
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
      spend: [],
      packs: [
        { variantId: '111', priceCents: 500 },
        { variantId: '222', priceCents: 2000 }
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

    // gpt-5.4-mini at the Cloud rate: (1000 * 0.5 + 100 * 4) / 1e6 USD = 900 micros.
    await meterRequest(deps, USER_ID, {
      feature: 'ghostText',
      model: 'gpt-5.4-mini',
      tokensIn: 1000,
      tokensOut: 100,
      requestId: 'req-1'
    })
    await meterRequest(deps, USER_ID, {
      feature: 'ghostText',
      model: 'gpt-5.4-mini',
      tokensIn: 1000,
      tokensOut: 100,
      requestId: 'req-2'
    })
    // gpt-5.4: (2000 * 2.5 + 500 * 20) / 1e6 USD = 15000 micros.
    const chat = await meterRequest(deps, USER_ID, {
      feature: 'chat',
      model: 'gpt-5.4',
      tokensIn: 2000,
      tokensOut: 500,
      requestId: 'req-3'
    })

    expect(chat.micros).toBe(15_000)
    const body = await credits()
    expect(body.balanceMicros).toBe(5_000_000 - 900 - 900 - 15_000)
    expect(body.spend).toEqual([
      { feature: 'chat', micros: 15_000, requests: 1, tokens: 2500 },
      { feature: 'ghostText', micros: 1800, requests: 2, tokens: 2200 }
    ])
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
    expect((await credits()).balanceMicros).toBe(5_000_000)
  })

  it('accepts the variant id as the number Lemon Squeezy sends', async () => {
    expect(await webhookStatus(await webhook(orderEvent({ variantId: 111 })))).toBe('applied')

    expect((await credits()).balanceMicros).toBe(5_000_000)
  })

  it('applies a replayed delivery exactly once', async () => {
    await webhook(orderEvent())

    expect(await webhookStatus(await webhook(orderEvent()))).toBe('duplicate')
    expect((await credits()).balanceMicros).toBe(5_000_000)
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
      message: 'Credit purchases are not configured on the server yet.'
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

describe('meterRequest and hasCredit', () => {
  it('charges the answered request and returns the new balance', async () => {
    await webhook(orderEvent())

    const charge = await meterRequest(deps, USER_ID, {
      feature: 'critique',
      model: 'gpt-5.4',
      tokensIn: 4000,
      tokensOut: 800,
      requestId: 'req-9'
    })

    // (4000 * 2.5 + 800 * 20) / 1e6 USD = 26000 micros.
    expect(charge).toEqual({ micros: 26_000, balanceMicros: 5_000_000 - 26_000 })
  })

  it('charges even when it overdraws, so the next request is refused', async () => {
    expect(await hasCredit(deps.store, USER_ID)).toBe(false)

    await meterRequest(deps, USER_ID, {
      feature: 'chat',
      model: 'gpt-5.4',
      tokensIn: 1000,
      tokensOut: 100,
      requestId: 'req-over'
    })

    expect(await deps.store.getBalance(USER_ID)).toBe(-4500)
    expect(await hasCredit(deps.store, USER_ID)).toBe(false)
  })

  it('reports credit only while the balance is above zero', async () => {
    await webhook(orderEvent())

    expect(await hasCredit(deps.store, USER_ID)).toBe(true)

    await webhook(orderEvent({ event: 'order_refunded' }))

    expect(await hasCredit(deps.store, USER_ID)).toBe(false)
  })

  it('refuses to charge a model with no published rate', async () => {
    await expect(
      meterRequest(deps, USER_ID, {
        feature: 'chat',
        model: 'gpt-made-up',
        tokensIn: 10,
        tokensOut: 10,
        requestId: 'req-unpriced'
      })
    ).rejects.toThrow('No MythScribe Cloud rate for model "gpt-made-up"')

    expect(await deps.store.getBalance(USER_ID)).toBe(0)
  })
})
