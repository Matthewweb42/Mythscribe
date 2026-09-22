import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type {
  AuthMeResult,
  AuthPollBody,
  AuthPollResult,
  AuthStartResult,
  CheckoutResult,
  CloudSession,
  CreditsResult,
  LicenseResult
} from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import {
  encodeLicensePayload,
  formatLicenseToken,
  LICENSE_GRACE_MS,
  LICENSE_REFRESH_INTERVAL_MS,
  LicensePublicKeyJwk,
  type LicenseClaims,
  type SupporterStatus
} from '@shared/license'
import { AiKeyStore } from '../ai/keyStore'
import { fakeSafeStorage } from '../ai/keyStoreFixture'
import { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import type { Schedule } from '../schedule'
import { AccountService } from './accountService'
import { AccountError, type CloudAuthClient } from './cloudAuthClient'

const EMAIL = 'author@example.com'
const SESSION: CloudSession = { token: 'tok-1', email: EMAIL, userId: 'u1' }
const START: AuthStartResult = {
  attemptId: 'a1',
  pollSecret: 's1',
  expiresAt: '2026-09-19T10:15:00.000Z'
}
const START_MS = Date.parse(START.expiresAt)
const ME: AuthMeResult = { email: EMAIL, userId: 'u1', since: '2026-09-01T00:00:00.000Z' }
const CREDITS: CreditsResult = {
  balanceMicros: 2_500_000,
  spend: [{ feature: 'ghostText', micros: 1200, requests: 3, tokens: 900 }],
  periodDays: USAGE_PERIOD_DAYS,
  periodSpend: [{ feature: 'ghostText', micros: 400, requests: 1, tokens: 300 }],
  periodFirstChargeAt: 1_758_000_000_000,
  packs: [{ variantId: 'pack-5', priceCents: 500 }]
}
const CHECKOUT: CheckoutResult = { url: 'https://mythscribe.lemonsqueezy.com/buy/abc?x=1' }
/** F-15.9: the Supporter product the Worker publishes beside the license. */
const SUPPORTER_PRODUCT = { variantId: 'supporter', priceCents: 3900 }

/**
 * F-15.9: one throwaway Ed25519 keypair for the whole file. The service verifies every token
 * against `licensePublicKey`, so a token signed with `signLicense` is the only kind it trusts.
 */
const { privateKey: licenseKey, publicKey: licensePublic } = generateKeyPairSync('ed25519')
const LICENSE_PUBLIC_JWK = LicensePublicKeyJwk.parse(licensePublic.export({ format: 'jwk' }))

const signLicense = (claims: LicenseClaims, key: KeyObject = licenseKey): string => {
  const payload = encodeLicensePayload(claims)
  return formatLicenseToken(payload, new Uint8Array(sign(null, payload, key)))
}

/** A token for the signed-in account (`SESSION.userId`), issued `agoMs` ago. */
const licenseFor = (agoMs = 0, sub = SESSION.userId): { token: string; claims: LicenseClaims } => {
  const claims: LicenseClaims = {
    v: 1,
    sub,
    iat: clock - agoMs,
    exp: clock - agoMs + LICENSE_GRACE_MS
  }
  return { token: signLicense(claims), claims }
}

let tmp: string
let keyFile: string
let appState: AppStateStore
let clock: number
let changes: AccountStatus[]
let supporterChanges: SupporterStatus[]
/** The timers the service armed and has not cancelled; `tick()` runs the newest one. */
let timers: { run: () => void; ms: number; cancelled: boolean }[]
let start: Mock<(email: string) => Promise<AuthStartResult>>
let poll: Mock<(body: AuthPollBody) => Promise<AuthPollResult>>
let me: Mock<(token: string) => Promise<AuthMeResult>>
let signOut: Mock<(token: string) => Promise<void>>
let credits: Mock<(token: string) => Promise<CreditsResult>>
let checkout: Mock<(token: string, variantId: string) => Promise<CheckoutResult>>
let license: Mock<(token: string) => Promise<LicenseResult>>

const schedule: Schedule = (run, ms) => {
  const timer = { run, ms, cancelled: false }
  timers.push(timer)
  return () => {
    timer.cancelled = true
  }
}

/** Runs the poll timer that is waiting, then lets its request settle. */
const tick = async (): Promise<void> => {
  const timer = timers.filter((t) => !t.cancelled).at(-1)
  if (timer === undefined) throw new Error('No timer is armed')
  timer.cancelled = true
  timer.run()
  await new Promise<void>((resolve) => setImmediate(resolve))
}

const armed = (): boolean => timers.some((t) => !t.cancelled)

/** Lets a floating request (the F-15.9 background license refresh) settle. */
const settle = (): Promise<void> => new Promise<void>((resolve) => setImmediate(resolve))

const store = (): AiKeyStore => new AiKeyStore(keyFile, fakeSafeStorage(), 'win32')

/** A key store that already holds the session, for the tests that start signed in. */
const signedInStore = (): AiKeyStore => {
  const keyStore = store()
  keyStore.setKey('cloudSession', JSON.stringify(SESSION))
  return keyStore
}

const build = (keyStore: AiKeyStore = store()): AccountService => {
  const client: CloudAuthClient = { start, poll, me, signOut, credits, checkout, license }
  return new AccountService({
    client,
    keyStore,
    appState,
    licensePublicKey: LICENSE_PUBLIC_JWK,
    onChange: (status) => changes.push(status),
    onSupporterChange: (status) => supporterChanges.push(status),
    now: () => clock,
    schedule
  })
}

/** Asserts the rejection is an `AppError` and answers it. */
const caught = async (run: Promise<unknown>): Promise<AppError> => {
  try {
    await run
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    if (err instanceof AppError) return err
  }
  throw new Error('Expected the call to fail')
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mythscribe-account-'))
  keyFile = path.join(tmp, 'userData', 'ai-keys.json')
  appState = new AppStateStore(path.join(tmp, 'userData', 'app-state.json'))
  clock = START_MS - 15 * 60_000
  changes = []
  supporterChanges = []
  timers = []
  start = vi.fn(() => Promise.resolve(START))
  poll = vi.fn<(body: AuthPollBody) => Promise<AuthPollResult>>(() =>
    Promise.resolve({ status: 'pending' })
  )
  me = vi.fn(() => Promise.resolve(ME))
  signOut = vi.fn(() => Promise.resolve())
  credits = vi.fn(() => Promise.resolve(CREDITS))
  checkout = vi.fn(() => Promise.resolve(CHECKOUT))
  // F-15.9: no license unless a test says so, so the background refresh a signed-in service runs
  // on construction is harmless and changes nothing.
  license = vi.fn(() => Promise.resolve({ token: null, product: null }))
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('AccountService (F-15.2)', () => {
  it('starts signed out with no session stored', () => {
    const service = build()
    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(armed()).toBe(false)
    service.dispose()
  })

  it('goes pending on a requested link and signs in when the poll turns ready', async () => {
    const keyStore = store()
    const service = build(keyStore)
    const pending = await service.requestLink('  Author@Example.COM ')

    expect(start).toHaveBeenCalledWith('  Author@Example.COM ')
    expect(pending).toEqual({
      state: 'pending',
      email: EMAIL,
      attemptId: 'a1',
      expiresAt: START.expiresAt
    })
    expect(changes).toEqual([])
    expect(armed()).toBe(true)

    await tick()
    expect(service.status().state).toBe('pending')
    expect(poll).toHaveBeenCalledWith({ attemptId: 'a1', pollSecret: 's1' })

    poll.mockResolvedValueOnce({ status: 'ready', session: SESSION })
    await tick()

    expect(service.status()).toEqual({
      state: 'signedIn',
      email: EMAIL,
      userId: 'u1',
      since: null
    })
    expect(changes).toEqual([service.status()])
    // The poll is over; the only timer left is F-15.9's daily license refresh.
    expect(timers.filter((t) => !t.cancelled).map((t) => t.ms)).toEqual([
      LICENSE_REFRESH_INTERVAL_MS
    ])
    // The session is on disk, as ciphertext, and a fresh service reads it back.
    expect(fs.readFileSync(keyFile, 'utf8')).not.toContain(SESSION.token)
    expect(JSON.parse(keyStore.getKey('cloudSession') ?? 'null')).toEqual(SESSION)
    service.dispose()
  })

  it('carries a dev link through to the pending status', async () => {
    start.mockResolvedValueOnce({ ...START, devLink: 'http://127.0.0.1:8787/auth/verify?t=x' })
    const service = build()
    expect(await service.requestLink(EMAIL)).toMatchObject({
      devLink: 'http://127.0.0.1:8787/auth/verify?t=x'
    })
    service.dispose()
  })

  it('signs out and stops polling when the attempt expires', async () => {
    const service = build()
    await service.requestLink(EMAIL)
    poll.mockResolvedValueOnce({ status: 'expired' })
    await tick()

    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(changes).toEqual([{ state: 'signedOut' }])
    expect(armed()).toBe(false)
    service.dispose()
  })

  it('keeps polling through a network failure until the link expires', async () => {
    const service = build()
    await service.requestLink(EMAIL)

    poll.mockRejectedValueOnce(new AccountError('NETWORK', 'no', 'later'))
    await tick()
    expect(service.status().state).toBe('pending')
    expect(armed()).toBe(true)

    clock = START_MS
    poll.mockRejectedValueOnce(new AccountError('NETWORK', 'no', 'later'))
    await tick()
    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(changes).toEqual([{ state: 'signedOut' }])
    expect(armed()).toBe(false)
    service.dispose()
  })

  it('stops polling on cancel and never polls again', async () => {
    const service = build()
    await service.requestLink(EMAIL)
    expect(service.cancelLink()).toEqual({ state: 'signedOut' })
    expect(armed()).toBe(false)
    expect(changes).toEqual([])
    expect(poll).not.toHaveBeenCalled()
    service.dispose()
  })

  it('reports a Worker that cannot send the email as IO, with the next step', async () => {
    start.mockRejectedValueOnce(
      new AccountError('NOT_CONFIGURED', 'The sign-in email is not configured.', 'Try again later.')
    )
    const service = build()
    const err = await caught(service.requestLink(EMAIL))
    expect(err.code).toBe('IO')
    expect(err.message).toBe('The sign-in email is not configured. Try again later.')
    expect(service.status()).toEqual({ state: 'signedOut' })
    service.dispose()
  })

  it('reports a malformed address as VALIDATION', async () => {
    start.mockRejectedValueOnce(
      new AccountError('INVALID_EMAIL', 'Enter a valid email address.', 'Check it.')
    )
    const service = build()
    expect((await caught(service.requestLink('nope'))).code).toBe('VALIDATION')
    service.dispose()
  })

  it('refuses to sign in at all when the machine cannot protect the session', async () => {
    const keyStore = new AiKeyStore(
      keyFile,
      fakeSafeStorage({ isEncryptionAvailable: () => false })
    )
    const service = build(keyStore)
    const err = await caught(service.requestLink(EMAIL))
    expect(err.code).toBe('IO')
    expect(err.message).toContain('keyring')
    expect(start).not.toHaveBeenCalled()
    service.dispose()
  })

  it('forgets the session on sign out even when the Worker is unreachable', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)
    expect(service.status().state).toBe('signedIn')

    signOut.mockRejectedValueOnce(new AccountError('NETWORK', 'no', 'later'))
    expect(await service.signOut()).toEqual({ state: 'signedOut' })
    expect(signOut).toHaveBeenCalledWith(SESSION.token)
    expect(keyStore.hasKey('cloudSession')).toBe(false)
    service.dispose()
  })

  it('fills the sign-in date on refresh', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    expect(await service.refresh()).toEqual({
      state: 'signedIn',
      email: EMAIL,
      userId: 'u1',
      since: ME.since
    })
    expect(me).toHaveBeenCalledWith(SESSION.token)
    service.dispose()
  })

  it('forgets a session the Worker no longer accepts', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    me.mockRejectedValueOnce(new AccountError('UNAUTHORIZED', 'gone', 'Sign in again.'))
    expect(await service.refresh()).toEqual({ state: 'signedOut' })
    expect(keyStore.hasKey('cloudSession')).toBe(false)
    service.dispose()
  })

  it('leaves the status alone when the Worker cannot be reached on refresh', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    me.mockRejectedValueOnce(
      new AccountError(
        'NETWORK',
        'Could not reach MythScribe Cloud.',
        'Check your connection and try again.'
      )
    )
    const err = await caught(service.refresh())
    expect(err.code).toBe('IO')
    expect(err.message).toBe(
      'Could not reach MythScribe Cloud. Check your connection and try again.'
    )
    expect(service.status()).toEqual({ state: 'signedIn', email: EMAIL, userId: 'u1', since: null })
    expect(keyStore.hasKey('cloudSession')).toBe(true)
    service.dispose()
  })

  it('hands the session token to main-side Cloud calls and null when signed out (F-15.4)', () => {
    const keyStore = store()
    const service = build(keyStore)
    expect(service.sessionToken()).toBeNull()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const restored = build(keyStore)
    expect(restored.sessionToken()).toBe(SESSION.token)
    service.dispose()
    restored.dispose()
  })

  it('forgets the session and pushes one change when the proxy refuses it (F-15.4)', () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)
    service.sessionEnded()
    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(service.sessionToken()).toBeNull()
    expect(keyStore.hasKey('cloudSession')).toBe(false)
    expect(changes).toEqual([{ state: 'signedOut' }])
    // A second failure of an in-flight request changes nothing and says nothing.
    service.sessionEnded()
    expect(changes).toHaveLength(1)
    service.dispose()
  })

  it('does nothing on refresh while signed out', async () => {
    const service = build()
    expect(await service.refresh()).toEqual({ state: 'signedOut' })
    expect(me).not.toHaveBeenCalled()
    service.dispose()
  })

  it('restores a stored session on construction', () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)
    expect(service.status()).toEqual({
      state: 'signedIn',
      email: EMAIL,
      userId: 'u1',
      since: null
    })
    service.dispose()
  })

  it('clears a stored session it cannot read', () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', 'not json at all')
    const service = build(keyStore)
    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(keyStore.hasKey('cloudSession')).toBe(false)

    keyStore.setKey('cloudSession', JSON.stringify({ token: 'tok-1' }))
    const second = build(keyStore)
    expect(second.status()).toEqual({ state: 'signedOut' })
    expect(keyStore.hasKey('cloudSession')).toBe(false)
    service.dispose()
    second.dispose()
  })

  it('refuses to ask for credits or a checkout while signed out', async () => {
    const service = build()
    expect((await caught(service.credits())).message).toBe(
      'Sign in to see your MythScribe Cloud credits.'
    )
    expect((await caught(service.checkoutUrl('pack-5'))).message).toBe(
      'Sign in to buy MythScribe Cloud credits.'
    )
    expect(credits).not.toHaveBeenCalled()
    expect(checkout).not.toHaveBeenCalled()
    service.dispose()
  })

  it('answers the balance and the checkout URL with the stored session', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    expect(await service.credits()).toEqual(CREDITS)
    expect(credits).toHaveBeenCalledWith(SESSION.token)
    expect(await service.checkoutUrl('pack-5')).toBe(CHECKOUT.url)
    expect(checkout).toHaveBeenCalledWith(SESSION.token, 'pack-5')
    service.dispose()
  })

  it('forgets a session the Worker rejects on a credits call and says so', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    credits.mockRejectedValueOnce(
      new AccountError('UNAUTHORIZED', 'This sign-in is no longer valid.', 'Sign in again.')
    )
    const err = await caught(service.credits())
    expect(err.code).toBe('IO')
    expect(err.message).toBe('This sign-in is no longer valid. Sign in again.')
    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(keyStore.hasKey('cloudSession')).toBe(false)
    expect(changes).toEqual([{ state: 'signedOut' }])
    service.dispose()
  })

  it('reports a pack the Worker does not know as VALIDATION and stays signed in', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    checkout.mockRejectedValueOnce(
      new AccountError(
        'NOT_FOUND',
        'That credit pack is no longer on sale.',
        'Refresh the packs and pick another.'
      )
    )
    const err = await caught(service.checkoutUrl('gone'))
    expect(err.code).toBe('VALIDATION')
    expect(err.message).toBe(
      'That credit pack is no longer on sale. Refresh the packs and pick another.'
    )
    expect(service.status().state).toBe('signedIn')
    expect(changes).toEqual([])
    service.dispose()
  })

  it('leaves the session alone when the Worker cannot be reached for credits', async () => {
    const keyStore = store()
    keyStore.setKey('cloudSession', JSON.stringify(SESSION))
    const service = build(keyStore)

    credits.mockRejectedValueOnce(
      new AccountError('NETWORK', 'Could not reach MythScribe Cloud.', 'Try again.')
    )
    const err = await caught(service.credits())
    expect(err.code).toBe('IO')
    expect(service.status().state).toBe('signedIn')
    expect(keyStore.hasKey('cloudSession')).toBe(true)
    expect(changes).toEqual([])
    service.dispose()
  })

  it('drops the poll timer on dispose', async () => {
    const service = build()
    await service.requestLink(EMAIL)
    service.dispose()
    expect(armed()).toBe(false)
    expect(changes).toEqual([])
  })
})

describe('AccountService Supporter license (F-15.9)', () => {
  const UNLICENSED: SupporterStatus = {
    licensed: false,
    since: null,
    validUntil: null,
    offline: false,
    product: null,
    accent: 'default'
  }

  /** Puts a cached license in `app-state.json` before the service reads it. */
  const cache = (token: string | null, refreshedAt: number | null): void => {
    appState.update((state) => ({
      ...state,
      supporter: { ...state.supporter, token, refreshedAt }
    }))
  }

  const stored = (): { token: string | null; refreshedAt: number | null; accent: string } =>
    appState.get().supporter

  it('answers unlicensed on a fresh install and asks for nothing', () => {
    const service = build()
    expect(service.supporter()).toEqual(UNLICENSED)
    expect(license).not.toHaveBeenCalled()
    service.dispose()
  })

  it('trusts a cached token offline once no refresh has reached the Worker for a day', async () => {
    const { token, claims } = licenseFor(2 * LICENSE_REFRESH_INTERVAL_MS)
    cache(token, clock - 2 * LICENSE_REFRESH_INTERVAL_MS)
    license.mockRejectedValue(new AccountError('NETWORK', 'no', 'later'))
    const service = build(signedInStore())
    await settle()

    expect(service.supporter()).toEqual({
      licensed: true,
      since: new Date(claims.iat).toISOString(),
      validUntil: new Date(claims.exp).toISOString(),
      offline: true,
      product: null,
      accent: 'default'
    })
    // The unreachable Worker left the cache alone: that is what the grace period is.
    expect(stored().token).toBe(token)
    expect(supporterChanges).toEqual([])
    service.dispose()
  })

  it('reports a cached token the Worker confirmed today as online', async () => {
    const { token } = licenseFor(60_000)
    cache(token, clock - 60_000)
    license.mockResolvedValue({ token, product: null })
    const service = build(signedInStore())
    await settle()
    expect(service.supporter()).toMatchObject({ licensed: true, offline: false })
    service.dispose()
  })

  it('refuses a cached token that expired and one issued for another account', async () => {
    // The Worker is unreachable, so what the cache holds is all these two have to go on.
    license.mockRejectedValue(new AccountError('NETWORK', 'no', 'later'))
    cache(licenseFor(LICENSE_GRACE_MS).token, clock)
    const expired = build(signedInStore())
    await settle()
    expect(expired.supporter()).toEqual(UNLICENSED)
    expired.dispose()

    cache(licenseFor(60_000, 'someone-else').token, clock)
    const other = build(signedInStore())
    await settle()
    expect(other.supporter()).toEqual(UNLICENSED)
    other.dispose()
  })

  it('refuses a cached token while signed out, whatever it says', () => {
    cache(licenseFor(60_000).token, clock)
    const service = build()
    expect(service.supporter()).toEqual(UNLICENSED)
    service.dispose()
  })

  it('stores the token the Worker signs and pushes the change from the background refresh', async () => {
    const { token, claims } = licenseFor()
    license.mockResolvedValue({ token, product: SUPPORTER_PRODUCT })
    const service = build(signedInStore())
    await settle()

    expect(license).toHaveBeenCalledWith(SESSION.token)
    expect(service.supporter()).toEqual({
      licensed: true,
      since: new Date(claims.iat).toISOString(),
      validUntil: new Date(claims.exp).toISOString(),
      offline: false,
      product: null,
      accent: 'default'
    })
    expect(stored()).toMatchObject({ token, refreshedAt: clock })
    expect(supporterChanges).toEqual([service.supporter()])
    service.dispose()
  })

  it('replaces the cached token on every refresh, so the grace period starts again', async () => {
    const first = licenseFor(LICENSE_GRACE_MS / 2)
    cache(first.token, clock - LICENSE_GRACE_MS / 2)
    const fresh = licenseFor()
    license.mockResolvedValue({ token: fresh.token, product: null })
    const service = build(signedInStore())
    await settle()

    const status = await service.refreshLicense()
    expect(status.validUntil).toBe(new Date(fresh.claims.exp).toISOString())
    expect(stored()).toMatchObject({ token: fresh.token, refreshedAt: clock })
    service.dispose()
  })

  it('clears the cache when the Worker answers with no token, and names what is on sale', async () => {
    cache(licenseFor(60_000).token, clock - 60_000)
    license.mockResolvedValue({ token: null, product: SUPPORTER_PRODUCT })
    const service = build(signedInStore())
    await settle()

    expect(service.supporter()).toEqual({ ...UNLICENSED, product: SUPPORTER_PRODUCT })
    expect(stored().token).toBeNull()
    // The extras went out, so the renderer is told without asking.
    expect(supporterChanges).toEqual([service.supporter()])
    service.dispose()
  })

  it('keeps a license answered while refresh() was replacing the signed-in state', async () => {
    // The Account tab refreshes the account as soon as it opens, which lands `/auth/me` while
    // the sign-in's `/license` call is still in flight; the token must count for the same session.
    const { token } = licenseFor()
    let answerLicense: (result: LicenseResult) => void = () => undefined
    license.mockImplementation(
      () => new Promise<LicenseResult>((resolve) => (answerLicense = resolve))
    )
    const service = build(signedInStore())
    await settle()
    await service.refresh()
    answerLicense({ token, product: SUPPORTER_PRODUCT })
    await settle()

    expect(stored().token).toBe(token)
    expect(service.supporter()).toMatchObject({ licensed: true, offline: false })
    expect(supporterChanges).toEqual([service.supporter()])
    service.dispose()
  })

  it('refuses a refreshed token that does not verify and keeps the cached one', async () => {
    const cached = licenseFor(60_000)
    cache(cached.token, clock - 60_000)
    const { privateKey: otherKey } = generateKeyPairSync('ed25519')
    const forged = signLicense(licenseFor().claims, otherKey)
    license.mockResolvedValue({ token: forged, product: null })
    const service = build(signedInStore())
    await settle()

    expect(stored().token).toBe(cached.token)
    expect(service.supporter()).toMatchObject({ licensed: true })
    expect(console.warn).toHaveBeenCalledWith(
      'Refused a Supporter license token that does not verify against the app key'
    )
    service.dispose()
  })

  it('reports an unreachable Worker to the author who asked for the refresh', async () => {
    cache(licenseFor(60_000).token, clock - 60_000)
    license.mockRejectedValue(new AccountError('NETWORK', 'Could not reach it.', 'Try again.'))
    const service = build(signedInStore())
    await settle()

    const err = await caught(service.refreshLicense())
    expect(err.code).toBe('IO')
    expect(err.message).toBe('Could not reach it. Try again.')
    expect(service.supporter()).toMatchObject({ licensed: true })
    service.dispose()
  })

  it('refuses a refresh while signed out', async () => {
    const service = build()
    expect((await caught(service.refreshLicense())).message).toBe(
      'Sign in to check your MythScribe Supporter license.'
    )
    expect(license).not.toHaveBeenCalled()
    service.dispose()
  })

  it('asks again once a day, and stops when the session ends', async () => {
    license.mockResolvedValue({ token: licenseFor().token, product: null })
    const service = build(signedInStore())
    await settle()
    expect(license).toHaveBeenCalledTimes(1)
    const timer = timers.filter((t) => !t.cancelled).at(-1)
    expect(timer?.ms).toBe(LICENSE_REFRESH_INTERVAL_MS)

    await tick()
    expect(license).toHaveBeenCalledTimes(2)
    expect(armed()).toBe(true)

    await service.signOut()
    expect(armed()).toBe(false)
    service.dispose()
  })

  it('drops the cached token on sign out and tells the renderer', async () => {
    const { token } = licenseFor(60_000)
    cache(token, clock - 60_000)
    license.mockResolvedValue({ token, product: null })
    const service = build(signedInStore())
    await settle()
    expect(service.supporter()).toMatchObject({ licensed: true })
    supporterChanges.length = 0

    await service.signOut()
    expect(stored()).toMatchObject({ token: null, refreshedAt: null })
    expect(service.supporter()).toEqual(UNLICENSED)
    expect(supporterChanges).toEqual([UNLICENSED])
    service.dispose()
  })

  it('drops the cached token when the Worker refuses the session', async () => {
    cache(licenseFor(60_000).token, clock - 60_000)
    license.mockRejectedValue(new AccountError('UNAUTHORIZED', 'gone', 'Sign in again.'))
    const service = build(signedInStore())
    await settle()

    expect(service.status()).toEqual({ state: 'signedOut' })
    expect(stored().token).toBeNull()
    expect(supporterChanges).toEqual([UNLICENSED])
    expect(armed()).toBe(false)
    service.dispose()
  })

  it('stores an accent for a licensed account and refuses one without a license', async () => {
    const service = build()
    const refused = caughtSync(() => service.setAccent('ember'))
    expect(refused.code).toBe('VALIDATION')
    expect(refused.message).toContain('Supporter license')
    expect(stored().accent).toBe('default')
    // `default` is every install's, so it is never refused.
    expect(service.setAccent('default')).toEqual(UNLICENSED)
    service.dispose()

    cache(licenseFor(60_000).token, clock - 60_000)
    license.mockResolvedValue({ token: licenseFor().token, product: null })
    const licensed = build(signedInStore())
    await settle()
    expect(licensed.setAccent('ember')).toMatchObject({ licensed: true, accent: 'ember' })
    expect(stored().accent).toBe('ember')
    // The choice is kept through a sign-out, so buying again brings it back; it just stops showing.
    await licensed.signOut()
    expect(stored().accent).toBe('ember')
    expect(licensed.supporter().accent).toBe('default')
    licensed.dispose()
  })

  it('buys the license through the Worker checkout, and refuses when nothing is on sale', async () => {
    license.mockResolvedValue({ token: null, product: null })
    const service = build(signedInStore())
    await settle()
    expect((await caught(service.supporterCheckoutUrl())).message).toBe(
      'The Supporter license is not on sale yet. Try again later.'
    )
    expect(checkout).not.toHaveBeenCalled()
    service.dispose()

    license.mockResolvedValue({ token: null, product: SUPPORTER_PRODUCT })
    const onSale = build(signedInStore())
    await settle()
    expect(await onSale.supporterCheckoutUrl()).toBe(CHECKOUT.url)
    expect(checkout).toHaveBeenCalledWith(SESSION.token, SUPPORTER_PRODUCT.variantId)
    onSale.dispose()
  })

  it('checks the license as soon as a sign-in lands', async () => {
    const { token } = licenseFor()
    license.mockResolvedValue({ token, product: null })
    const service = build()
    await service.requestLink(EMAIL)
    poll.mockResolvedValueOnce({ status: 'ready', session: SESSION })
    await tick()
    await settle()

    expect(license).toHaveBeenCalledWith(SESSION.token)
    expect(service.supporter()).toMatchObject({ licensed: true })
    service.dispose()
  })
})

/** `caught` for a call that answers without a promise (`setAccent`). */
function caughtSync(run: () => unknown): AppError {
  try {
    run()
  } catch (err) {
    expect(err).toBeInstanceOf(AppError)
    if (err instanceof AppError) return err
  }
  throw new Error('Expected the call to fail')
}
