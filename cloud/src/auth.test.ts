import { beforeEach, describe, expect, it } from 'vitest'
import {
  AuthMeResult,
  AuthPollResult,
  AuthStartResult,
  CloudApiError,
  LOGIN_ATTEMPT_TTL_MS,
  START_RATE_LIMIT
} from '../../src/shared/cloudApi'
import type { AuthDeps } from './auth'
import type { MailMessage, Mailer } from './email'
import { handleRequest } from './index'
import { memoryStore } from './store'

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const START = new Date('2026-09-19T12:00:00.000Z')

let mails: MailMessage[]
let clock: number
let counter: number
let deps: AuthDeps

const capturingMailer: Mailer = {
  send(message) {
    mails.push(message)
    return Promise.resolve()
  }
}

function makeDeps(overrides: Partial<AuthDeps> = {}): AuthDeps {
  return {
    store: memoryStore(),
    mailer: capturingMailer,
    now: () => new Date(clock),
    random: () => `tok-${(counter += 1)}`,
    revealLink: false,
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
        ...memoryStore(),
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
