/**
 * The MythScribe Cloud Worker (F-15.2, F-15.3): the account routes and the credit routes behind
 * `api.mythscribe.app`. No CORS headers — the desktop app is not a browser origin and nothing
 * here is meant to be called from a web page; only `/auth/verify` is opened in a browser, and it
 * answers HTML. F-15.4 adds the AI proxy routes to the same router.
 */
import {
  handleMe,
  handlePoll,
  handleSignOut,
  handleStart,
  handleVerify,
  jsonError,
  jsonResponse
} from './auth'
import {
  type ConfiguredPack,
  ConfiguredPacks,
  type CreditsDeps,
  handleCheckout,
  handleCredits,
  handleLemonSqueezyWebhook
} from './credits'
import { randomToken } from './crypto'
import { logMailer, resendMailer, type Mailer } from './email'
import { d1Store } from './store'

/**
 * The bindings this Worker needs. Hand-written rather than the generated `Env`: secrets are not
 * in `wrangler.toml` (so they are absent from the generated type) and `EMAIL_TRANSPORT` is
 * generated as the literal `"resend"`, while `.dev.vars` sets it to `log`.
 */
export interface WorkerEnv {
  DB: D1Database
  EMAIL_TRANSPORT?: string
  RESEND_API_KEY?: string
  /** Local runs only: the origin for sign-in links (see `AuthDeps.publicOrigin`). */
  PUBLIC_ORIGIN?: string
  /** F-15.3: the credit packs on sale, as a JSON array of `{ variantId, url, priceCents }`. */
  LEMONSQUEEZY_PACKS?: string
  LEMONSQUEEZY_WEBHOOK_SECRET?: string
}

function mailerFor(env: WorkerEnv): Mailer | null {
  if (env.EMAIL_TRANSPORT === 'log') return logMailer()
  if (env.RESEND_API_KEY) return resendMailer(env.RESEND_API_KEY)
  return null
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

/**
 * The configured packs, or none. A malformed var must not take the account routes down with it:
 * the Account tab then says credit packs are not on sale, and the Worker log names the problem.
 */
function packsFor(env: WorkerEnv): ConfiguredPack[] {
  if (!env.LEMONSQUEEZY_PACKS) return []
  const parsed = ConfiguredPacks.safeParse(parseJson(env.LEMONSQUEEZY_PACKS))
  if (!parsed.success) {
    console.error('LEMONSQUEEZY_PACKS is not a valid pack list; no credit packs are on sale')
    return []
  }
  return parsed.data
}

function depsFor(env: WorkerEnv): CreditsDeps {
  return {
    store: d1Store(env.DB),
    mailer: mailerFor(env),
    now: () => new Date(),
    random: randomToken,
    revealLink: env.EMAIL_TRANSPORT === 'log',
    packs: packsFor(env),
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET ?? null,
    ...(env.PUBLIC_ORIGIN ? { publicOrigin: env.PUBLIC_ORIGIN } : {})
  }
}

function route(request: Request, deps: CreditsDeps): Promise<Response> | Response {
  const { pathname } = new URL(request.url)
  const { method } = request

  if (pathname === '/' && method === 'GET') return jsonResponse({ service: 'mythscribe-api' })

  if (pathname === '/auth/start' && method === 'POST') return handleStart(request, deps)
  if (pathname === '/auth/verify' && method === 'GET') return handleVerify(request, deps)
  if (pathname === '/auth/poll' && method === 'POST') return handlePoll(request, deps)
  if (pathname === '/auth/me' && method === 'GET') return handleMe(request, deps)
  if (pathname === '/auth/signout' && method === 'POST') return handleSignOut(request, deps)

  if (pathname === '/credits' && method === 'GET') return handleCredits(request, deps)
  if (pathname === '/billing/checkout' && method === 'POST') return handleCheckout(request, deps)
  if (pathname === '/billing/lemonsqueezy' && method === 'POST') {
    return handleLemonSqueezyWebhook(request, deps)
  }

  return jsonError('NOT_FOUND', 'No such endpoint.')
}

/** Nothing this Worker answers may be cached: every body is a secret, a session, or a one-off. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, headers })
}

/** The whole request path over injected dependencies, so the tests drive the real router. */
export async function handleRequest(request: Request, deps: CreditsDeps): Promise<Response> {
  try {
    return withNoStore(await route(request, deps))
  } catch (error) {
    // The cause stays in the Worker log; the caller gets a generic message.
    console.error('Unhandled error in the MythScribe Cloud Worker', error)
    return withNoStore(jsonError('INTERNAL', 'Something went wrong. Try again in a moment.'))
  }
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, depsFor(env))
  }
}
