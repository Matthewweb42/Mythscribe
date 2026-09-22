import { beforeEach, describe, expect, it } from 'vitest'
import { CloudApiError, LicenseResult, SESSION_TTL_MS } from '../../src/shared/cloudApi'
import { LICENSE_GRACE_MS, parseLicenseToken } from '../../src/shared/license'
import type { ConfiguredPack } from './credits'
import { importSigningKey, sha256Hex } from './crypto'
import type { Mailer } from './email'
import { handleRequest, type WorkerDeps } from './index'
import { memoryStore } from './store'

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const USER_ID = 'user-1'
const TOKEN = 'session-token'
const START = new Date('2026-09-21T09:00:00.000Z')

const SUPPORTER: ConfiguredPack = {
  variantId: '333',
  priceCents: 3900,
  url: 'https://mythscribe.lemonsqueezy.com/buy/supporter'
}

/**
 * A throwaway Ed25519 pair, generated for this file alone: the Worker signs with the private half
 * and the test verifies with the public one, exactly as the app verifies against the key embedded
 * in `src/shared/license.ts`. Neither half is a key any build trusts.
 */
const PRIVATE_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  d: '6Y-u2smyDPAMWziqG8SPQDSYzAWXCnVsKtP7E84feMA',
  x: 'qjffPnTw-DNsxehz_S23btcXZYEapX5w_VS7FGU7X5c'
}
const PUBLIC_JWK = {
  kty: 'OKP',
  crv: 'Ed25519',
  x: 'qjffPnTw-DNsxehz_S23btcXZYEapX5w_VS7FGU7X5c'
}

const silentMailer: Mailer = { send: () => Promise.resolve() }

let deps: WorkerDeps
let clock: number

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: memoryStore(),
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => 'random',
    revealLink: false,
    packs: [],
    supporter: SUPPORTER,
    webhookSecret: null,
    upstream: null,
    signingKey: () => importSigningKey(PRIVATE_JWK),
    ...overrides
  }
}

/** Seed a signed-in user directly; the sign-in flow is covered by `auth.test.ts`. */
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
  deps = makeDeps()
  await signIn()
})

function get(path: string, token?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  })
}

async function license(token = TOKEN): Promise<LicenseResult> {
  const response = await handleRequest(get('/license', token), deps)
  expect(response.status).toBe(200)
  return LicenseResult.parse(await response.json())
}

/** What the app does with a token before it trusts it: parse it, then check the signature. */
async function verifyToken(token: string): Promise<boolean> {
  const parsed = parseLicenseToken(token)
  if (!parsed) return false
  const key = await crypto.subtle.importKey('jwk', PUBLIC_JWK, { name: 'Ed25519' }, false, [
    'verify'
  ])
  return crypto.subtle.verify('Ed25519', key, parsed.signature, parsed.payload)
}

describe('GET /license', () => {
  it('signs a token the embedded public key verifies', async () => {
    await deps.store.grantSupporter(USER_ID, 'order_created:order-1', clock)

    const body = await license()

    expect(body.product).toEqual({ variantId: '333', priceCents: 3900 })
    expect(body.token).not.toBeNull()
    expect(await verifyToken(body.token!)).toBe(true)
    expect(parseLicenseToken(body.token!)?.claims).toEqual({
      v: 1,
      sub: USER_ID,
      iat: START.getTime(),
      exp: START.getTime() + LICENSE_GRACE_MS
    })
  })

  it('signs a fresh token on every call, so the grace period starts again', async () => {
    await deps.store.grantSupporter(USER_ID, 'order_created:order-1', clock)
    const first = await license()

    clock = START.getTime() + 24 * 60 * 60_000
    const second = await license()

    expect(second.token).not.toBe(first.token)
    expect(parseLicenseToken(second.token!)?.claims.exp).toBe(clock + LICENSE_GRACE_MS)
    expect(await verifyToken(second.token!)).toBe(true)
  })

  it('answers no token for an account that never bought the license', async () => {
    const body = await license()

    expect(body.token).toBeNull()
    expect(body.product).toEqual({ variantId: '333', priceCents: 3900 })
  })

  it('answers no token once the license was revoked', async () => {
    await deps.store.grantSupporter(USER_ID, 'order_created:order-1', clock)
    await deps.store.revokeSupporter(USER_ID, clock + 1000)

    expect((await license()).token).toBeNull()
  })

  it('offers nothing to buy until the operator configures the product', async () => {
    deps = makeDeps({ supporter: null })
    await signIn()

    expect(await license()).toEqual({ token: null, product: null })
  })

  it('reports that the license is not configured when the Worker cannot sign', async () => {
    deps = makeDeps({ signingKey: null })
    await signIn()
    await deps.store.grantSupporter(USER_ID, 'order_created:order-1', clock)

    const response = await handleRequest(get('/license', TOKEN), deps)

    expect(response.status).toBe(503)
    expect(CloudApiError.parse(await response.json())).toEqual({
      code: 'NOT_CONFIGURED',
      message: 'The Supporter license is not configured on the server yet.'
    })
  })

  it('looks like an unlicensed account when the Worker cannot sign and there is no license', async () => {
    deps = makeDeps({ signingKey: null })
    await signIn()

    expect((await license()).token).toBeNull()
  })

  it('refuses a caller with no session', async () => {
    const response = await handleRequest(get('/license'), deps)

    expect(response.status).toBe(401)
    expect(CloudApiError.parse(await response.json()).code).toBe('UNAUTHORIZED')
  })
})
