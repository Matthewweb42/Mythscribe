/**
 * Who is calling. Two modes, set by AUTH_MODE:
 * - `cloud`: the MythScribe account the desktop app already uses. The web app signs in through
 *   this Worker (it forwards /api/auth/* to the cloud Worker's /auth/*, which has no CORS), and
 *   every bearer is checked with the cloud's `GET /auth/me`. The cloud Worker is not changed.
 * - `none`: one local author, `local`, and no sign-in. Meant for `wrangler dev` only.
 */
import { type Caller, fail } from './http'

export type AuthEnv = { AUTH_MODE: string; CLOUD_API: string }

/** The cloud routes the browser may reach through this Worker. */
const FORWARDED = new Set(['start', 'poll', 'verify', 'refresh', 'signout'])

/** How long a checked bearer is trusted before asking the cloud again. */
const CHECK_TTL_MS = 60_000
const checked = new Map<string, { userId: string; until: number }>()

function bearer(request: Request): string | null {
  const h = request.headers.get('authorization') ?? ''
  const m = /^Bearer\s+(\S+)$/i.exec(h)
  return m?.[1] ?? null
}

async function hashOf(token: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The caller, or null when the bearer is missing or the cloud doesn't know it. */
export async function caller(request: Request, env: AuthEnv, fetcher: typeof fetch = fetch): Promise<Caller | null> {
  if (env.AUTH_MODE === 'none') return { userId: 'local' }
  const token = bearer(request)
  if (!token) return null
  const key = await hashOf(token)
  const now = Date.now()
  const hit = checked.get(key)
  if (hit && hit.until > now) return { userId: hit.userId }
  const res = await fetcher(`${env.CLOUD_API}/auth/me`, { headers: { authorization: `Bearer ${token}` } })
  if (!res.ok) {
    checked.delete(key)
    return null
  }
  const me = (await res.json()) as { userId?: unknown }
  if (typeof me.userId !== 'string' || !me.userId) return null
  if (checked.size > 5000) checked.clear()
  checked.set(key, { userId: me.userId, until: now + CHECK_TTL_MS })
  return { userId: me.userId }
}

/** `POST /api/auth/<route>`: passed to the cloud Worker as is, body and bearer included. */
export async function forwardAuth(request: Request, route: string, env: AuthEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  if (env.AUTH_MODE === 'none') return fail(404, 'not_found', 'Sign-in is off in this run.')
  if (!FORWARDED.has(route) || request.method !== 'POST') return fail(404, 'not_found', 'No such route.')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  const auth = request.headers.get('authorization')
  if (auth) headers.authorization = auth
  const res = await fetcher(`${env.CLOUD_API}/auth/${route}`, { method: 'POST', headers, body: await request.text() })
  if (route === 'signout') {
    const token = bearer(request)
    if (token) checked.delete(await hashOf(token))
  }
  return new Response(res.body, {
    status: res.status,
    headers: { 'content-type': res.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' }
  })
}
