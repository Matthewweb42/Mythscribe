import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CLOUD_ERROR_STATUS, type CloudErrorCode } from '@shared/cloudApi'
import { AccountError, createCloudAuthClient } from './cloudAuthClient'

const BASE = 'http://127.0.0.1:8787'
const SESSION = { token: 'tok-1', email: 'author@example.com', userId: 'u1' }

interface Call {
  url: string
  init: RequestInit | undefined
}

let calls: Call[]
/** The next answers, in order; an `Error` fails the call instead of answering it. */
let answers: (Response | Error)[]

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

const fetchFake = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
  const url = urlOf(input)
  calls.push({ url, init })
  const next = answers.shift()
  if (next === undefined) throw new Error(`No fake answer left for ${url}`)
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const errorBody = (code: CloudErrorCode, message: string): Response =>
  json(CLOUD_ERROR_STATUS[code], { code, message })

const client = (): ReturnType<typeof createCloudAuthClient> =>
  createCloudAuthClient({ baseUrl: `${BASE}/`, fetch: fetchFake })

/** Asserts the rejection is an `AccountError` and answers it, so the test can read its copy. */
const caught = async (run: Promise<unknown>): Promise<AccountError> => {
  try {
    await run
  } catch (err) {
    expect(err).toBeInstanceOf(AccountError)
    if (err instanceof AccountError) return err
  }
  throw new Error('Expected the call to fail')
}

beforeEach(() => {
  calls = []
  answers = []
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('createCloudAuthClient (F-15.2)', () => {
  it('starts an attempt, trimming the base URL and normalising the address', async () => {
    answers = [
      json(200, {
        attemptId: 'a1',
        pollSecret: 's1',
        expiresAt: '2026-09-19T10:15:00.000Z',
        devLink: 'http://127.0.0.1:8787/auth/verify?t=x'
      })
    ]
    const result = await client().start('  Author@Example.COM ')

    expect(result.attemptId).toBe('a1')
    expect(result.devLink).toBe('http://127.0.0.1:8787/auth/verify?t=x')
    expect(calls[0]?.url).toBe(`${BASE}/auth/start`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ email: 'author@example.com' }))
  })

  it('refuses a malformed address before any request leaves', async () => {
    const err = await caught(client().start('not-an-email'))
    expect(err.code).toBe('INVALID_EMAIL')
    expect(calls).toEqual([])
  })

  it('parses each poll answer', async () => {
    answers = [
      json(200, { status: 'pending' }),
      json(200, { status: 'ready', session: SESSION }),
      json(200, { status: 'expired' })
    ]
    const api = client()
    const body = { attemptId: 'a1', pollSecret: 's1' }
    expect(await api.poll(body)).toEqual({ status: 'pending' })
    expect(await api.poll(body)).toEqual({ status: 'ready', session: SESSION })
    expect(await api.poll(body)).toEqual({ status: 'expired' })
    expect(calls[0]?.url).toBe(`${BASE}/auth/poll`)
    expect(calls[0]?.init?.body).toBe(JSON.stringify(body))
  })

  it('sends the session token as a bearer for me and signOut', async () => {
    answers = [
      json(200, { email: 'author@example.com', userId: 'u1', since: '2026-09-01T00:00:00.000Z' }),
      new Response(null, { status: 204 })
    ]
    const api = client()
    const me = await api.me('tok-1')
    expect(me.since).toBe('2026-09-01T00:00:00.000Z')
    await expect(api.signOut('tok-1')).resolves.toBeUndefined()

    expect(calls[0]?.url).toBe(`${BASE}/auth/me`)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(calls.map((c) => new Headers(c.init?.headers).get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-1'
    ])
    expect(calls[1]?.init?.method).toBe('POST')
  })

  it('maps every error code to author-facing copy with a next step', async () => {
    const cases: [CloudErrorCode, string][] = [
      ['INVALID_EMAIL', 'Check the address and try again.'],
      ['RATE_LIMITED', 'Open the last email, or wait 15 minutes.'],
      ['NOT_CONFIGURED', 'Try again later.'],
      ['UNAUTHORIZED', 'Sign in again.'],
      ['NOT_FOUND', 'Ask for a new sign-in link.'],
      ['INTERNAL', 'Try again in a moment.']
    ]
    for (const [code, nextStep] of cases) {
      answers = [errorBody(code, 'the worker said so')]
      const err = await caught(client().poll({ attemptId: 'a1', pollSecret: 's1' }))
      expect(err.code).toBe(code)
      expect(err.nextStep).toBe(nextStep)
      expect(err.message.length).toBeGreaterThan(0)
    }
  })

  it('passes the Worker message through for a Worker without a mail transport', async () => {
    answers = [errorBody('NOT_CONFIGURED', 'The sign-in email is not configured.')]
    const err = await caught(client().start('author@example.com'))
    expect(err.code).toBe('NOT_CONFIGURED')
    expect(err.message).toBe('The sign-in email is not configured.')
    expect(err.nextStep).toBe('Try again later.')
  })

  it('reports fixed copy for a rate limit, whatever the Worker wrote', async () => {
    answers = [errorBody('RATE_LIMITED', 'slow down')]
    const err = await caught(client().start('author@example.com'))
    expect(err.message).toBe('Too many sign-in links were requested for this address.')
  })

  it('reports an unreachable Worker as NETWORK', async () => {
    answers = [new TypeError('fetch failed')]
    const err = await caught(client().me('tok-1'))
    expect(err.code).toBe('NETWORK')
    expect(`${err.message} ${err.nextStep}`).toBe(
      'Could not reach MythScribe Cloud. Check your connection and try again.'
    )
  })

  it('gives up on a Worker that never answers', async () => {
    const hang = (_input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const api = createCloudAuthClient({ baseUrl: BASE, fetch: hang, timeoutMs: 5 })
    const err = await caught(api.me('tok-1'))
    expect(err.code).toBe('NETWORK')
    expect(err.message).toBe('MythScribe Cloud did not answer in time.')
  })

  it('names the two codes only the credit routes can answer with', async () => {
    answers = [errorBody('INSUFFICIENT_CREDITS', 'no credit')]
    const spent = await caught(client().credits('tok-1'))
    expect(spent.message).toBe('Your MythScribe Cloud balance is used up.')
    expect(spent.nextStep).toBe('Buy more credits in Settings › Account.')

    answers = [errorBody('BAD_SIGNATURE', 'nope')]
    const signature = await caught(client().credits('tok-1'))
    expect(signature.message).toBe("MythScribe Cloud refused the request's signature.")
    expect(signature.nextStep).toBe('Try again; if it keeps happening, update MythScribe.')
  })

  it('reports a body it cannot read as PROTOCOL, success or failure', async () => {
    answers = [json(200, { attemptId: 'a1' })]
    expect((await caught(client().start('author@example.com'))).code).toBe('PROTOCOL')

    answers = [new Response('<html>502</html>', { status: 502 })]
    const err = await caught(client().poll({ attemptId: 'a1', pollSecret: 's1' }))
    expect(err.code).toBe('PROTOCOL')
    expect(err.nextStep).toBe('Try again; if it keeps happening, update MythScribe.')
  })
})

describe('createCloudAuthClient credits (F-15.3)', () => {
  const CREDITS = {
    balanceMicros: 2_500_000,
    spend: [{ feature: 'ghostText', micros: 1200, requests: 3, tokens: 900 }],
    packs: [{ variantId: 'pack-5', priceCents: 500 }]
  }

  it('reads the balance, the spend, and the packs with the session as a bearer', async () => {
    answers = [json(200, CREDITS)]
    expect(await client().credits('tok-1')).toEqual(CREDITS)
    expect(calls[0]?.url).toBe(`${BASE}/credits`)
    expect(calls[0]?.init?.method).toBe('GET')
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1')
  })

  it('asks the Worker for the checkout URL of one pack', async () => {
    const url = 'https://mythscribe.lemonsqueezy.com/buy/abc?checkout%5Bcustom%5D%5Buser_id%5D=u1'
    answers = [json(200, { url })]
    expect(await client().checkout('tok-1', 'pack-5')).toEqual({ url })
    expect(calls[0]?.url).toBe(`${BASE}/billing/checkout`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ variantId: 'pack-5' }))
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok-1')
  })

  it('names the pack, not a sign-in attempt, when the Worker does not know it', async () => {
    answers = [errorBody('NOT_FOUND', 'unknown variant')]
    const err = await caught(client().checkout('tok-1', 'gone'))
    expect(err.code).toBe('NOT_FOUND')
    expect(err.message).toBe('That credit pack is no longer on sale.')
    expect(err.nextStep).toBe('Refresh the packs and pick another.')
  })

  it('reports a revoked session as UNAUTHORIZED on both routes', async () => {
    answers = [errorBody('UNAUTHORIZED', 'gone')]
    expect((await caught(client().credits('tok-1'))).code).toBe('UNAUTHORIZED')
    answers = [errorBody('UNAUTHORIZED', 'gone')]
    const err = await caught(client().checkout('tok-1', 'pack-5'))
    expect(err.code).toBe('UNAUTHORIZED')
    expect(err.nextStep).toBe('Sign in again.')
  })

  it('reports a credits body it cannot read as PROTOCOL', async () => {
    answers = [json(200, { balanceMicros: 1.5, spend: [], packs: [] })]
    expect((await caught(client().credits('tok-1'))).code).toBe('PROTOCOL')
    answers = [json(200, { url: 'not a url' })]
    expect((await caught(client().checkout('tok-1', 'pack-5'))).code).toBe('PROTOCOL')
  })
})
