/**
 * Mythscribe Desk on the web. Static files (Desk's page with the shim) come from `public/`;
 * this Worker answers /api/* only.
 */
import { handleAi, monthSpend } from './ai'
import { caller, forwardAuth } from './auth'
import { fail, json } from './http'
import { handleReaderNotes, handleRooms, serveRoomPage } from './rooms'
import { handleSync } from './sync'

export type Env = {
  ASSETS: Fetcher
  DB: D1Database
  AUTH_MODE: string
  CLOUD_API: string
  AI_MONTHLY_CAP_USD: string
  ANTHROPIC_API_KEY?: string
  ANTHROPIC_BASE_URL?: string
}

export async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url)
  const p = url.pathname
  const page = /^\/r\/([^/]+)$/.exec(p)
  if (page && request.method === 'GET') return serveRoomPage(request, env.DB, page[1]!)
  if (!p.startsWith('/api/')) return env.ASSETS.fetch(request)

  if (p === '/api/config' && request.method === 'GET')
    return json({ auth: env.AUTH_MODE === 'none' ? 'none' : 'cloud', ai: Boolean(env.ANTHROPIC_API_KEY) })
  if (p.startsWith('/api/auth/')) return forwardAuth(request, p.slice('/api/auth/'.length), env)
  const readerNotes = /^\/api\/r\/([^/]+)\/notes$/.exec(p)
  if (readerNotes) return handleReaderNotes(request, env.DB, readerNotes[1]!)

  const who = await caller(request, env)
  if (!who) return fail(401, 'not_signed_in', 'Sign in to MythScribe first.')
  if (p === '/api/sync' && request.method === 'POST') return handleSync(request, env.DB, who)
  if (p === '/api/ai' && request.method === 'POST') return handleAi(request, env, who, ctx)
  if (p === '/api/rooms' || p.startsWith('/api/rooms/')) return handleRooms(request, env.DB, who, p.slice('/api/rooms'.length))
  if (p === '/api/usage' && request.method === 'GET') {
    const spent = await monthSpend(env.DB, who.userId)
    return json({ spentUsd: spent / 1_000_000, capUsd: Number(env.AI_MONTHLY_CAP_USD ?? '10') })
  }
  return fail(404, 'not_found', 'No such route.')
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return route(request, env, ctx)
  }
} satisfies ExportedHandler<Env>
