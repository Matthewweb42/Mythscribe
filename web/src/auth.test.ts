import { describe, expect, it } from 'vitest'
import { caller, forwardAuth } from './auth'

const env = { AUTH_MODE: 'cloud', CLOUD_API: 'https://cloud.test' }

describe('caller', () => {
  it('is the one local author when sign-in is off', async () => {
    expect(await caller(new Request('https://x/api/sync'), { ...env, AUTH_MODE: 'none' })).toEqual({ userId: 'local' })
  })
  it('asks the cloud who a bearer belongs to, then remembers it for a minute', async () => {
    let calls = 0
    const fake = (async (url: string, init?: RequestInit) => {
      calls++
      expect(url).toBe('https://cloud.test/auth/me')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok-1')
      return new Response(JSON.stringify({ email: 'a@b.c', userId: 'u1', since: 'x' }))
    }) as typeof fetch
    const req = () => new Request('https://x/api/sync', { headers: { authorization: 'Bearer tok-1' } })
    expect(await caller(req(), env, fake)).toEqual({ userId: 'u1' })
    expect(await caller(req(), env, fake)).toEqual({ userId: 'u1' })
    expect(calls).toBe(1)
  })
  it('is nobody without a bearer or when the cloud says no', async () => {
    const no = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    expect(await caller(new Request('https://x/'), env, no)).toBeNull()
    expect(await caller(new Request('https://x/', { headers: { authorization: 'Bearer bad' } }), env, no)).toBeNull()
  })
})

describe('forwardAuth', () => {
  it('passes the sign-in routes to the cloud and nothing else', async () => {
    const seen: string[] = []
    const fake = (async (url: string) => {
      seen.push(url)
      return new Response('{"status":"pending"}', { headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const post = (route: string) => forwardAuth(new Request('https://x/', { method: 'POST', body: '{}' }), route, env, fake)
    expect((await post('poll')).status).toBe(200)
    expect((await post('me')).status).toBe(404)
    expect(seen).toEqual(['https://cloud.test/auth/poll'])
  })
})
