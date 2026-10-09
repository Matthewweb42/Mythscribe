import { describe, expect, it, vi } from 'vitest'
import type { AuthRefreshResult, CreditsResult } from '@shared/cloudApi'
import { USAGE_PERIOD_DAYS } from '@shared/cloudUsage'
import { ACCESS_TOKEN_MARGIN_MS, CloudAccessTokens, withAccessTokens } from './accessTokens'
import { AccountError, accountError, type CloudAuthClient } from './cloudAuthClient'

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0)
const MINUTE = 60_000
const SESSION = { token: 'refresh-1', email: 'author@example.com', userId: 'u1' }

const access = (token: string, ttlMs = 15 * MINUTE): AuthRefreshResult => ({
  access: { token, expiresAt: new Date(NOW + ttlMs).toISOString() }
})

const CREDITS: CreditsResult = {
  balanceMicros: 5_000_000,
  spend: [],
  periodDays: USAGE_PERIOD_DAYS,
  periodSpend: [],
  periodFirstChargeAt: null,
  packs: [],
  starter: null,
  refunds: []
}

/** A client whose bearer routes record the bearer they were called with. */
function fakeClient(overrides: Partial<CloudAuthClient> = {}): {
  client: CloudAuthClient
  bearers: string[]
} {
  const bearers: string[] = []
  const seen =
    <T>(answer: T) =>
    (token: string) => {
      bearers.push(token)
      return Promise.resolve(answer)
    }
  const client: CloudAuthClient = {
    start: () => Promise.reject(new Error('unused')),
    poll: () => Promise.resolve({ status: 'pending' }),
    refresh: () => Promise.resolve(access('access-1')),
    me: seen({ email: SESSION.email, userId: 'u1', since: '2026-09-01T00:00:00.000Z' }),
    signOut: (token) => {
      bearers.push(token)
      return Promise.resolve()
    },
    credits: seen(CREDITS),
    checkout: (token) => {
      bearers.push(token)
      return Promise.resolve({ url: 'https://x.lemonsqueezy.com/buy/1' })
    },
    license: seen({ token: null, product: null }),
    refund: (token) => {
      bearers.push(token)
      return Promise.resolve({ refundedMicros: 1, balanceMicros: 0 })
    },
    usage: (token) => {
      bearers.push(token)
      return Promise.resolve({ entries: [], nextCursor: null })
    },
    ...overrides
  }
  return { client, bearers }
}

describe('CloudAccessTokens (AI-BILLING-SPEC A5, S6)', () => {
  it('mints once and reuses the access token until close to its expiry', async () => {
    let now = NOW
    const refresh = vi.fn((_token: string) =>
      Promise.resolve(access(`access-${refresh.mock.calls.length}`))
    )
    const tokens = new CloudAccessTokens({ refresh, now: () => now })
    expect(await tokens.bearer('refresh-1')).toBe('access-1')
    expect(await tokens.bearer('refresh-1')).toBe('access-1')
    expect(refresh).toHaveBeenCalledOnce()
    now = NOW + 15 * MINUTE - ACCESS_TOKEN_MARGIN_MS
    expect(await tokens.bearer('refresh-1')).toBe('access-2')
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(refresh).toHaveBeenCalledWith('refresh-1')
  })

  it('shares one refresh between concurrent calls', async () => {
    const refresh = vi.fn(() => Promise.resolve(access('access-1')))
    const tokens = new CloudAccessTokens({ refresh, now: () => NOW })
    const all = await Promise.all([tokens.bearer('refresh-1'), tokens.bearer('refresh-1')])
    expect(all).toEqual(['access-1', 'access-1'])
    expect(refresh).toHaveBeenCalledOnce()
  })

  it('never hands one session the access token of another', async () => {
    const refresh = vi.fn((token: string) => Promise.resolve(access(`for-${token}`)))
    const tokens = new CloudAccessTokens({ refresh, now: () => NOW })
    expect(await tokens.bearer('refresh-1')).toBe('for-refresh-1')
    expect(await tokens.bearer('refresh-2')).toBe('for-refresh-2')
  })

  it('uses a seeded token, and mints again after invalidate', async () => {
    const refresh = vi.fn(() => Promise.resolve(access('access-new')))
    const tokens = new CloudAccessTokens({ refresh, now: () => NOW })
    tokens.seed('refresh-1', access('access-seeded').access)
    expect(await tokens.bearer('refresh-1')).toBe('access-seeded')
    tokens.invalidate()
    expect(await tokens.bearer('refresh-1')).toBe('access-new')
  })

  it('falls back to the session token on a Worker without /auth/refresh', async () => {
    const tokens = new CloudAccessTokens({
      refresh: () => Promise.reject(accountError('NOT_FOUND')),
      now: () => NOW
    })
    expect(await tokens.bearer('refresh-1')).toBe('refresh-1')
  })

  it('passes a revoked session on as UNAUTHORIZED', async () => {
    const tokens = new CloudAccessTokens({
      refresh: () => Promise.reject(accountError('UNAUTHORIZED')),
      now: () => NOW
    })
    await expect(tokens.bearer('refresh-1')).rejects.toBeInstanceOf(AccountError)
  })
})

describe('withAccessTokens', () => {
  it('sends the access token on every bearer call and the session token to sign out', async () => {
    const { client, bearers } = fakeClient()
    const tokens = new CloudAccessTokens({ refresh: client.refresh, now: () => NOW })
    const wrapped = withAccessTokens(client, tokens)
    await wrapped.me('refresh-1')
    await wrapped.credits('refresh-1')
    await wrapped.checkout('refresh-1', 'pack-10')
    await wrapped.license('refresh-1')
    await wrapped.usage('refresh-1', null)
    await wrapped.signOut('refresh-1')
    expect(bearers).toEqual([
      'access-1',
      'access-1',
      'access-1',
      'access-1',
      'access-1',
      'refresh-1'
    ])
  })

  it('keeps the access token a finished sign-in hands over', async () => {
    const refresh = vi.fn(() => Promise.resolve(access('minted')))
    const { client, bearers } = fakeClient({
      refresh,
      poll: () =>
        Promise.resolve({ status: 'ready', session: SESSION, access: access('from-poll').access })
    })
    const wrapped = withAccessTokens(client, new CloudAccessTokens({ refresh, now: () => NOW }))
    await wrapped.poll({ attemptId: 'a1', pollSecret: 's1' })
    await wrapped.credits(SESSION.token)
    expect(bearers).toEqual(['from-poll'])
    expect(refresh).not.toHaveBeenCalled()
  })

  it('mints a fresh access token once after a 401, then gives up', async () => {
    let first = true
    const refresh = vi.fn(() => Promise.resolve(access(`access-${refresh.mock.calls.length}`)))
    const { client, bearers } = fakeClient({
      refresh,
      credits: (token) => {
        bearers.push(token)
        if (first) {
          first = false
          return Promise.reject(accountError('UNAUTHORIZED'))
        }
        return Promise.resolve(CREDITS)
      }
    })
    const wrapped = withAccessTokens(client, new CloudAccessTokens({ refresh, now: () => NOW }))
    expect(await wrapped.credits('refresh-1')).toEqual(CREDITS)
    expect(bearers).toEqual(['access-1', 'access-2'])

    const { client: refusing } = fakeClient({
      credits: () => Promise.reject(accountError('UNAUTHORIZED'))
    })
    const strict = withAccessTokens(
      refusing,
      new CloudAccessTokens({ refresh: refusing.refresh, now: () => NOW })
    )
    const err = await strict.credits('refresh-1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(AccountError)
    expect((err as AccountError).code).toBe('UNAUTHORIZED')
  })
})
