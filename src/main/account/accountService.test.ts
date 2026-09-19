import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { AccountStatus } from '@shared/account'
import type {
  AuthMeResult,
  AuthPollBody,
  AuthPollResult,
  AuthStartResult,
  CloudSession
} from '@shared/cloudApi'
import { AiKeyStore } from '../ai/keyStore'
import { fakeSafeStorage } from '../ai/keyStoreFixture'
import { AppError } from '../ipc/errors'
import { AccountService, type Schedule } from './accountService'
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

let tmp: string
let keyFile: string
let clock: number
let changes: AccountStatus[]
/** The timers the service armed and has not cancelled; `tick()` runs the newest one. */
let timers: { run: () => void; ms: number; cancelled: boolean }[]
let start: Mock<(email: string) => Promise<AuthStartResult>>
let poll: Mock<(body: AuthPollBody) => Promise<AuthPollResult>>
let me: Mock<(token: string) => Promise<AuthMeResult>>
let signOut: Mock<(token: string) => Promise<void>>

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

const store = (): AiKeyStore => new AiKeyStore(keyFile, fakeSafeStorage(), 'win32')

const build = (keyStore: AiKeyStore = store()): AccountService => {
  const client: CloudAuthClient = { start, poll, me, signOut }
  return new AccountService({
    client,
    keyStore,
    onChange: (status) => changes.push(status),
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
  clock = START_MS - 15 * 60_000
  changes = []
  timers = []
  start = vi.fn(() => Promise.resolve(START))
  poll = vi.fn<(body: AuthPollBody) => Promise<AuthPollResult>>(() =>
    Promise.resolve({ status: 'pending' })
  )
  me = vi.fn(() => Promise.resolve(ME))
  signOut = vi.fn(() => Promise.resolve())
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
    expect(armed()).toBe(false)
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

  it('drops the poll timer on dispose', async () => {
    const service = build()
    await service.requestLink(EMAIL)
    service.dispose()
    expect(armed()).toBe(false)
    expect(changes).toEqual([])
  })
})
