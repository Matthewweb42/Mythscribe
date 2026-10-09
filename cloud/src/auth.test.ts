import { beforeEach, describe, expect, it } from 'vitest'
import {
  ACCESS_TOKEN_TTL_MS,
  AuthMeResult,
  AuthPollResult,
  AuthRefreshResult,
  AuthStartResult,
  CloudApiError,
  CreditsResult,
  LOGIN_ATTEMPT_TTL_MS,
  LOGIN_CODE_MAX_FAILURES,
  SESSION_TTL_MS,
  START_RATE_LIMIT
} from '../../src/shared/cloudApi'
import type { MailMessage, Mailer } from './email'
import { handleRequest, type WorkerDeps } from './index'
import { testStore, type TestStore } from './testing/sqliteD1'

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const START = new Date('2026-09-19T12:00:00.000Z')

let mails: MailMessage[]
let clock: number
let counter: number
let deps: WorkerDeps

const capturingMailer: Mailer = {
  send(message) {
    mails.push(message)
    return Promise.resolve()
  }
}

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store: testStore(),
    mailer: capturingMailer,
    now: () => new Date(clock),
    random: () => `tok-${(counter += 1)}`,
    revealLink: false,
    // The credit routes (F-15.3) share the router; the account tests configure neither.
    packs: [],
    webhookSecret: null,
    // F-15.9: the Supporter license has its own tests in `license.test.ts`.
    supporter: null,
    appLicense: null,
    starter: null,
    lemonSqueezy: null,
    signingKey: null,
    // F-15.4: the AI proxy is off for the account and credit routes' tests.
    upstream: null,
    ...overrides
  }
}

beforeEach(() => {
  mails = []
  clock = START.getTime()
  counter = 0
  deps = makeDeps()
})

function post(path: string, body: unknown, token?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: JSON.stringify(body)
  })
}

function get(path: string, token?: string): Request {
  return new Request(`${ORIGIN}${path}`, {
    method: 'GET',
    headers: token ? { Authorization: `Bearer ${token}` } : undefined
  })
}

async function start(email = EMAIL): Promise<{ response: Response; body: AuthStartResult }> {
  const response = await handleRequest(post('/auth/start', { email }), deps)
  return { response, body: AuthStartResult.parse(await response.json()) }
}

function lastLink(): string {
  const text = mails[mails.length - 1]!.text
  const match = /https?:\/\/\S+/.exec(text)
  if (!match) throw new Error(`no link in the email: ${text}`)
  return match[0]
}

async function poll(attempt: AuthStartResult, secret = attempt.pollSecret): Promise<Response> {
  return handleRequest(
    post('/auth/poll', { attemptId: attempt.attemptId, pollSecret: secret }),
    deps
  )
}

async function errorOf(response: Response): Promise<CloudApiError> {
  return CloudApiError.parse(await response.json())
}

/** The code in the last sign-in email (AI-BILLING-SPEC A5). */
function lastCode(): string {
  const match = /enter this code in MythScribe: (\d{6})/.exec(mails[mails.length - 1]!.text)
  if (!match?.[1]) throw new Error('no code in the email')
  return match[1]
}

function verifyCode(attempt: AuthStartResult, code: string): Promise<Response> {
  return handleRequest(
    post('/auth/verify', { attemptId: attempt.attemptId, pollSecret: attempt.pollSecret, code }),
    deps
  )
}

async function ready(response: Response): Promise<Extract<AuthPollResult, { status: 'ready' }>> {
  const result = AuthPollResult.parse(await response.json())
  if (result.status !== 'ready') throw new Error(`expected ready, got ${result.status}`)
  return result
}

describe('POST /auth/start', () => {
  it('creates an attempt and emails exactly one link', async () => {
    const { response, body } = await start()

    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(body.attemptId).not.toBe(body.pollSecret)
    expect(body.expiresAt).toBe(new Date(START.getTime() + LOGIN_ATTEMPT_TTL_MS).toISOString())
    expect(body.devLink).toBeUndefined()

    expect(mails).toHaveLength(1)
    expect(mails[0]!.to).toBe(EMAIL)
    expect(mails[0]!.subject).toBe('Your MythScribe sign-in link')
    expect(mails[0]!.text).toContain('15 minutes')
    expect(mails[0]!.text).toContain('ignore this email')
    expect(lastLink()).toMatch(/^https:\/\/api\.mythscribe\.app\/auth\/verify\?t=/)
    // The link token itself is never handed to the caller.
    expect(lastLink()).not.toContain(body.pollSecret)
  })

  it('lower-cases the address and returns the link when the transport is log', async () => {
    deps = makeDeps({ revealLink: true })
    const { body } = await start('  Author@Example.COM ')

    expect(mails[0]!.to).toBe(EMAIL)
    expect(body.devLink).toBe(lastLink())
  })

  it('builds the link on the configured public origin (wrangler dev)', async () => {
    deps = makeDeps({ revealLink: true, publicOrigin: 'http://127.0.0.1:8787' })
    const { body } = await start(EMAIL)

    expect(body.devLink).toMatch(/^http:\/\/127\.0\.0\.1:8787\/auth\/verify\?t=/)
    expect(lastLink()).toBe(body.devLink)
  })

  it('refuses an address that is not an email', async () => {
    const response = await handleRequest(post('/auth/start', { email: 'not-an-email' }), deps)

    expect(response.status).toBe(400)
    expect((await errorOf(response)).code).toBe('INVALID_EMAIL')
    expect(mails).toHaveLength(0)
  })

  it('rate limits the fourth attempt for one address inside the window', async () => {
    for (let i = 0; i < START_RATE_LIMIT; i += 1) {
      expect((await start()).response.status).toBe(200)
      clock += 1000
    }

    const response = await handleRequest(post('/auth/start', { email: EMAIL }), deps)

    expect(response.status).toBe(429)
    expect((await errorOf(response)).code).toBe('RATE_LIMITED')
    expect(mails).toHaveLength(START_RATE_LIMIT)

    // Another address is unaffected, and so is the same one after the window.
    expect((await start('other@example.com')).response.status).toBe(200)
    clock += LOGIN_ATTEMPT_TTL_MS
    expect((await start()).response.status).toBe(200)
  })

  it('reports that sign-in email is not configured when there is no mailer', async () => {
    deps = makeDeps({ mailer: null })

    const response = await handleRequest(post('/auth/start', { email: EMAIL }), deps)

    expect(response.status).toBe(503)
    expect(await errorOf(response)).toEqual({
      code: 'NOT_CONFIGURED',
      message: 'Sign-in email is not configured on the server yet.'
    })
  })
})

describe('GET /auth/verify', () => {
  it('approves the attempt and renders the signed-in page once', async () => {
    await start()
    const link = lastLink()

    const response = await handleRequest(get(new URL(link).pathname + new URL(link).search), deps)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toContain('text/html')
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; style-src 'unsafe-inline'"
    )
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const html = await response.text()
    expect(html).toContain("You're signed in.")
    expect(html).not.toContain('tok-')

    const second = await handleRequest(get(new URL(link).pathname + new URL(link).search), deps)
    expect(second.status).toBe(410)
    expect(await second.text()).toContain('This link has expired.')
  })

  it('refuses an unknown or expired link with the expired page', async () => {
    const unknown = await handleRequest(get('/auth/verify?t=nope'), deps)
    expect(unknown.status).toBe(410)

    await start()
    const link = lastLink()
    clock += LOGIN_ATTEMPT_TTL_MS + 1

    const expired = await handleRequest(get(new URL(link).pathname + new URL(link).search), deps)
    expect(expired.status).toBe(410)
    expect(await expired.text()).toContain('This link has expired.')
  })
})

describe('POST /auth/poll', () => {
  it('answers pending, then ready exactly once, then expired', async () => {
    const { body: attempt } = await start()

    const pending = await poll(attempt)
    expect(pending.status).toBe(200)
    expect(AuthPollResult.parse(await pending.json())).toEqual({ status: 'pending' })

    const link = lastLink()
    await handleRequest(get(new URL(link).pathname + new URL(link).search), deps)

    const ready = AuthPollResult.parse(await (await poll(attempt)).json())
    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') throw new Error('expected a ready poll')
    expect(ready.session.email).toBe(EMAIL)
    expect(ready.session.token.length).toBeGreaterThan(0)
    expect(ready.session.userId.length).toBeGreaterThan(0)

    const again = AuthPollResult.parse(await (await poll(attempt)).json())
    expect(again).toEqual({ status: 'expired' })
  })

  it('answers not found for a wrong secret, exactly like an unknown id', async () => {
    const { body: attempt } = await start()

    const wrong = await poll(attempt, 'tok-guessed')
    const unknown = await handleRequest(
      post('/auth/poll', { attemptId: 'nope', pollSecret: attempt.pollSecret }),
      deps
    )

    expect(wrong.status).toBe(404)
    expect(unknown.status).toBe(404)
    expect(await errorOf(wrong)).toEqual(await errorOf(unknown))
  })

  it('answers expired once the attempt window has passed', async () => {
    const { body: attempt } = await start()
    clock += LOGIN_ATTEMPT_TTL_MS + 1

    const response = await poll(attempt)

    expect(AuthPollResult.parse(await response.json())).toEqual({ status: 'expired' })
  })
})

describe('GET /auth/me and POST /auth/signout', () => {
  async function signIn(): Promise<string> {
    const { body: attempt } = await start()
    const link = lastLink()
    await handleRequest(get(new URL(link).pathname + new URL(link).search), deps)
    const ready = AuthPollResult.parse(await (await poll(attempt)).json())
    if (ready.status !== 'ready') throw new Error('expected a ready poll')
    return ready.session.token
  }

  it('reports the identity behind a session', async () => {
    const token = await signIn()

    const response = await handleRequest(get('/auth/me', token), deps)

    expect(response.status).toBe(200)
    const me = AuthMeResult.parse(await response.json())
    expect(me.email).toBe(EMAIL)
    expect(me.since).toBe(START.toISOString())
  })

  it('refuses a missing, unknown, or signed-out session', async () => {
    const token = await signIn()

    expect((await handleRequest(get('/auth/me'), deps)).status).toBe(401)
    expect((await handleRequest(get('/auth/me', 'tok-made-up'), deps)).status).toBe(401)

    const signOut = await handleRequest(post('/auth/signout', {}, token), deps)
    expect(signOut.status).toBe(204)

    const after = await handleRequest(get('/auth/me', token), deps)
    expect(after.status).toBe(401)
    expect((await errorOf(after)).code).toBe('UNAUTHORIZED')
  })

  it('answers 204 when signing out an unknown session', async () => {
    const response = await handleRequest(post('/auth/signout', {}, 'tok-made-up'), deps)

    expect(response.status).toBe(204)
  })
})

describe('the router', () => {
  it('names the service at the root', async () => {
    const response = await handleRequest(get('/'), deps)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ service: 'mythscribe-api' })
    expect(response.headers.get('Cache-Control')).toBe('no-store')
  })

  it('answers 404 for an unknown route and for the wrong method', async () => {
    const unknown = await handleRequest(get('/nope'), deps)
    const wrongMethod = await handleRequest(get('/auth/start'), deps)

    expect(unknown.status).toBe(404)
    expect((await errorOf(unknown)).code).toBe('NOT_FOUND')
    expect(wrongMethod.status).toBe(404)
  })

  it('turns a thrown error into a generic 500', async () => {
    deps = makeDeps({
      store: {
        ...testStore(),
        countAttemptsSince: () => Promise.reject(new Error('D1 is down: secret-detail'))
      }
    })

    const response = await handleRequest(post('/auth/start', { email: EMAIL }), deps)

    expect(response.status).toBe(500)
    const error = await errorOf(response)
    expect(error.code).toBe('INTERNAL')
    expect(error.message).not.toContain('secret-detail')
  })
})

describe('POST /auth/verify (the emailed code)', () => {
  it('mails a six-digit code beside the link and signs in with it at once', async () => {
    const { body: attempt } = await start()
    expect(mails[0]!.html).toContain(lastCode())

    const result = await ready(await verifyCode(attempt, lastCode()))

    expect(result.session.email).toBe(EMAIL)
    expect(result.access?.expiresAt).toBe(
      new Date(START.getTime() + ACCESS_TOKEN_TTL_MS).toISOString()
    )
    // Spent: neither the code nor a poll hands the session over again.
    expect(AuthPollResult.parse(await (await verifyCode(attempt, lastCode())).json())).toEqual({
      status: 'expired'
    })
    expect(AuthPollResult.parse(await (await poll(attempt)).json())).toEqual({ status: 'expired' })
  })

  it('refuses a wrong code and spends the attempt after too many', async () => {
    const { body: attempt } = await start()
    const right = lastCode()
    const wrong = right === '000000' ? '111111' : '000000'

    for (let i = 1; i < LOGIN_CODE_MAX_FAILURES; i += 1) {
      const response = await verifyCode(attempt, wrong)
      expect(response.status).toBe(400)
      expect((await errorOf(response)).code).toBe('BAD_REQUEST')
    }
    expect(AuthPollResult.parse(await (await verifyCode(attempt, wrong)).json())).toEqual({
      status: 'expired'
    })
    expect(AuthPollResult.parse(await (await verifyCode(attempt, right)).json())).toEqual({
      status: 'expired'
    })
  })

  it('needs the poll secret of the app that started the sign-in', async () => {
    const { body: attempt } = await start()
    const response = await handleRequest(
      post('/auth/verify', { attemptId: attempt.attemptId, pollSecret: 'tok-x', code: lastCode() }),
      deps
    )
    expect(response.status).toBe(404)
  })

  it('refuses a code once the attempt window has passed', async () => {
    const { body: attempt } = await start()
    clock += LOGIN_ATTEMPT_TTL_MS + 1
    expect(AuthPollResult.parse(await (await verifyCode(attempt, lastCode())).json())).toEqual({
      status: 'expired'
    })
  })
})

describe('access and refresh tokens (A5, S6)', () => {
  async function signIn(): Promise<Extract<AuthPollResult, { status: 'ready' }>> {
    const { body: attempt } = await start()
    return ready(await verifyCode(attempt, lastCode()))
  }

  it('hands an access token over with the session after the link too', async () => {
    const { body: attempt } = await start()
    const link = lastLink()
    await handleRequest(get(new URL(link).pathname + new URL(link).search), deps)
    const result = await ready(await poll(attempt))
    expect(result.access?.token).toBeTruthy()
    expect((await handleRequest(get('/auth/me', result.access?.token), deps)).status).toBe(200)
  })

  it('accepts a short-lived access token until it expires, then refreshes it', async () => {
    const { session, access } = await signIn()
    expect((await handleRequest(get('/auth/me', access?.token), deps)).status).toBe(200)

    clock += ACCESS_TOKEN_TTL_MS
    expect((await handleRequest(get('/auth/me', access?.token), deps)).status).toBe(401)

    const refreshed = await handleRequest(
      post('/auth/refresh', { refreshToken: session.token }),
      deps
    )
    expect(refreshed.status).toBe(200)
    const { access: fresh } = AuthRefreshResult.parse(await refreshed.json())
    expect(fresh.token).not.toBe(access?.token)
    expect((await handleRequest(get('/auth/me', fresh.token), deps)).status).toBe(200)
  })

  it('ends every access token when the session is revoked, and refuses to refresh it', async () => {
    const { session, access } = await signIn()

    // Signing out with an access token revokes the session it was minted from.
    expect((await handleRequest(post('/auth/signout', {}, access?.token), deps)).status).toBe(204)

    expect((await handleRequest(get('/auth/me', access?.token), deps)).status).toBe(401)
    expect((await handleRequest(get('/auth/me', session.token), deps)).status).toBe(401)
    const refresh = await handleRequest(
      post('/auth/refresh', { refreshToken: session.token }),
      deps
    )
    expect(refresh.status).toBe(401)
    expect((await errorOf(refresh)).code).toBe('UNAUTHORIZED')
  })

  it('refuses to refresh an unknown or expired session', async () => {
    const { session } = await signIn()
    expect(
      (await handleRequest(post('/auth/refresh', { refreshToken: 'tok-made-up' }), deps)).status
    ).toBe(401)
    clock += SESSION_TTL_MS
    expect(
      (await handleRequest(post('/auth/refresh', { refreshToken: session.token }), deps)).status
    ).toBe(401)
  })
})

describe('the trial grant (M7)', () => {
  async function balanceOf(token: string | undefined): Promise<number> {
    const response = await handleRequest(get('/credits', token), deps)
    return CreditsResult.parse(await response.json()).balanceMicros
  }

  it('grants a configured trial once per verified email, never again for the same email', async () => {
    // 2026-10-08: no grant by default (the starter pack replaces it); an operator may set one.
    ;(deps.store as TestStore).setConfig('trial_grant_usd', 2)
    const first = await ready(await verifyCode((await start()).body, lastCode()))
    expect(await balanceOf(first.access?.token)).toBe(2_000_000)

    const second = await ready(await verifyCode((await start()).body, lastCode()))
    expect(await balanceOf(second.access?.token)).toBe(2_000_000)
    const ledger = await (deps.store as TestStore).ledger()
    expect(ledger.filter((row) => row.type === 'trial_grant')).toHaveLength(1)
  })

  it('grants nothing by default: a new account starts at $0 (2026-10-08)', async () => {
    const store = deps.store as TestStore
    const result = await ready(await verifyCode((await start()).body, lastCode()))
    expect(await balanceOf(result.access?.token)).toBe(0)
    expect(await store.ledger()).toEqual([])
  })
})

describe('email verification (2026-10-08, the starter pack needs it)', () => {
  it('marks a new account verified at its first sign-in', async () => {
    await ready(await verifyCode((await start()).body, lastCode()))
    const user = await deps.store.findUserByEmail(EMAIL)
    expect(user?.emailVerifiedAt).toBe(clock)
  })

  it('verifies an account that was not, on its next sign-in, and leaves a verified one alone', async () => {
    await deps.store.insertUser({ id: 'u-old', email: EMAIL, createdAt: clock - 1000 })
    expect((await deps.store.findUserById('u-old'))?.emailVerifiedAt).toBeNull()
    await ready(await verifyCode((await start()).body, lastCode()))
    expect((await deps.store.findUserById('u-old'))?.emailVerifiedAt).toBe(clock)

    clock += 60_000
    await ready(await verifyCode((await start()).body, lastCode()))
    expect((await deps.store.findUserById('u-old'))?.emailVerifiedAt).toBe(clock - 60_000)
  })
})
