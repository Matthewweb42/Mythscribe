/**
 * The MythScribe Cloud Worker (F-15.2, F-15.3): the account routes and the credit routes behind
 * `api.mythscribe.app`. No CORS headers — the desktop app is not a browser origin and nothing
 * here is meant to be called from a web page; only `/auth/verify` is opened in a browser, and it
 * answers HTML. F-15.4 adds the AI proxy route (`POST /ai/complete`) to the same router, F-15.8 the
 * one unauthenticated route, `POST /diagnostics`, and F-15.9 the Supporter license, `GET /license`.
 * AI-BILLING-SPEC (2026-10-07) adds `GET /pricing`, `GET /usage`, `POST /auth/refresh`, the code
 * exchange `POST /auth/verify`, and the scheduled sweep that releases expired holds.
 */
import { type AiDeps, handleAiComplete } from './ai'
import {
  handleMe,
  handlePoll,
  handleRefresh,
  handleSignOut,
  handleStart,
  handleVerify,
  handleVerifyCode,
  jsonError,
  jsonResponse
} from './auth'
import {
  ConfiguredPack,
  ConfiguredPacks,
  handleCheckout,
  handleCredits,
  handleLemonSqueezyWebhook,
  handlePricing,
  handleRefund,
  handleUsage
} from './credits'
import { importSigningKey, randomToken } from './crypto'
import { handleDiagnostics } from './diagnostics'
import { logMailer, resendMailer, type Mailer } from './email'
import { lemonSqueezyApi } from './lemonSqueezy'
import { handleLicense, type LicenseDeps, LicenseSigningJwk, type LicenseSigner } from './license'
import { openAiModelId, openAiUpstream, openRouterUpstream, type Upstream } from './openai'
import { d1Store, type Store } from './store'

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
  /** F-15.9: the Supporter product, as one JSON `{ variantId, url, priceCents }` object. */
  LEMONSQUEEZY_SUPPORTER?: string
  /** M1: the $30 app license, the same shape; supersedes the Supporter product. */
  LEMONSQUEEZY_APP_LICENSE?: string
  /** 2026-10-08: the $5 starter pack, the same shape; exempt from the minimum pack. */
  LEMONSQUEEZY_STARTER?: string
  LEMONSQUEEZY_WEBHOOK_SECRET?: string
  /** 2026-10-08: the store's API key, for refunds; absent → `POST /billing/refund` is NOT_CONFIGURED. */
  LEMONSQUEEZY_API_KEY?: string
  /** A9: the operator's OpenRouter key, the gateway the proxy forwards to. Preferred when set. */
  OPENROUTER_API_KEY?: string
  /** F-15.4: the operator's OpenAI key, used only while `OPENROUTER_API_KEY` is unset. */
  OPENAI_API_KEY?: string
  /** F-15.9: the private Ed25519 JWK license tokens are signed with; absent → no token is issued. */
  LICENSE_SIGNING_KEY?: string
}

/** Everything the router's routes need together; each handler asks for its own slice of it. */
export type WorkerDeps = AiDeps & LicenseDeps

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

/**
 * One license product (the Supporter product of F-15.9, or the $30 app license), configured
 * exactly like one pack. Unset or malformed is treated the same way as a malformed pack list:
 * nothing is on sale and the Account tab says so.
 */
function productFor(name: string, value: string | undefined): ConfiguredPack | null {
  if (!value) return null
  const parsed = ConfiguredPack.safeParse(parseJson(value))
  if (!parsed.success) {
    console.error(`${name} is not a valid product; it is off sale`)
    return null
  }
  return parsed.data
}

/**
 * The gateway (A9): OpenRouter when its key is set; else OpenAI direct (the F-15.4 setup), which
 * knows the price table's `openai/…` models by their bare names; else none (503).
 */
function upstreamFor(env: WorkerEnv): Upstream | null {
  if (env.OPENROUTER_API_KEY) return openRouterUpstream(env.OPENROUTER_API_KEY)
  if (env.OPENAI_API_KEY) {
    return openAiUpstream(env.OPENAI_API_KEY, undefined, { modelId: openAiModelId })
  }
  return null
}

/**
 * The license signer (F-15.9), or none. The key material is validated here and imported only when
 * a token actually has to be signed, so no route pays for it and a mistyped secret is one logged
 * line plus a 503 on `GET /license` rather than a failure anywhere else.
 */
function signingKeyFor(env: WorkerEnv): LicenseSigner | null {
  if (!env.LICENSE_SIGNING_KEY) return null
  const parsed = LicenseSigningJwk.safeParse(parseJson(env.LICENSE_SIGNING_KEY))
  if (!parsed.success) {
    console.error('LICENSE_SIGNING_KEY is not an Ed25519 private JWK; no license can be signed')
    return null
  }
  const jwk = parsed.data
  return () => importSigningKey(jwk)
}

function depsFor(env: WorkerEnv): WorkerDeps {
  return {
    store: d1Store(env.DB),
    mailer: mailerFor(env),
    now: () => new Date(),
    random: randomToken,
    revealLink: env.EMAIL_TRANSPORT === 'log',
    packs: packsFor(env),
    supporter: productFor('LEMONSQUEEZY_SUPPORTER', env.LEMONSQUEEZY_SUPPORTER),
    appLicense: productFor('LEMONSQUEEZY_APP_LICENSE', env.LEMONSQUEEZY_APP_LICENSE),
    starter: productFor('LEMONSQUEEZY_STARTER', env.LEMONSQUEEZY_STARTER),
    lemonSqueezy: env.LEMONSQUEEZY_API_KEY ? lemonSqueezyApi(env.LEMONSQUEEZY_API_KEY) : null,
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET ?? null,
    upstream: upstreamFor(env),
    signingKey: signingKeyFor(env),
    ...(env.PUBLIC_ORIGIN ? { publicOrigin: env.PUBLIC_ORIGIN } : {})
  }
}

function route(request: Request, deps: WorkerDeps): Promise<Response> | Response {
  const { pathname } = new URL(request.url)
  const { method } = request

  if (pathname === '/' && method === 'GET') return jsonResponse({ service: 'mythscribe-api' })

  if (pathname === '/auth/start' && method === 'POST') return handleStart(request, deps)
  if (pathname === '/auth/verify' && method === 'GET') return handleVerify(request, deps)
  if (pathname === '/auth/verify' && method === 'POST') return handleVerifyCode(request, deps)
  if (pathname === '/auth/poll' && method === 'POST') return handlePoll(request, deps)
  if (pathname === '/auth/refresh' && method === 'POST') return handleRefresh(request, deps)
  if (pathname === '/auth/me' && method === 'GET') return handleMe(request, deps)
  if (pathname === '/auth/signout' && method === 'POST') return handleSignOut(request, deps)

  if (pathname === '/credits' && method === 'GET') return handleCredits(request, deps)
  if (pathname === '/pricing' && method === 'GET') return handlePricing(deps)
  if (pathname === '/usage' && method === 'GET') return handleUsage(request, deps)
  if (pathname === '/billing/checkout' && method === 'POST') return handleCheckout(request, deps)
  if (pathname === '/billing/refund' && method === 'POST') return handleRefund(request, deps)
  if (pathname === '/billing/lemonsqueezy' && method === 'POST') {
    return handleLemonSqueezyWebhook(request, deps)
  }

  // F-15.9: the Supporter license token for this account, signed fresh on every call.
  if (pathname === '/license' && method === 'GET') return handleLicense(request, deps)

  if (pathname === '/ai/complete' && method === 'POST') return handleAiComplete(request, deps)

  // F-15.8: no bearer, on purpose — a diagnostics report carries nothing to authenticate.
  if (pathname === '/diagnostics' && method === 'POST') return handleDiagnostics(request, deps)

  return jsonError('NOT_FOUND', 'No such endpoint.')
}

/** Nothing this Worker answers may be cached: every body is a secret, a session, or a one-off. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, headers })
}

/** The whole request path over injected dependencies, so the tests drive the real router. */
export async function handleRequest(request: Request, deps: WorkerDeps): Promise<Response> {
  try {
    return withNoStore(await route(request, deps))
  } catch (error) {
    // The cause stays in the Worker log; the caller gets a generic message.
    console.error('Unhandled error in the MythScribe Cloud Worker', error)
    return withNoStore(jsonError('INTERNAL', 'Something went wrong. Try again in a moment.'))
  }
}

/** How long a rate window or an expired access token is kept before the sweep drops it. */
const PRUNE_AFTER_MS = 60 * 60_000

/**
 * The scheduled sweep (L5), run by the Cron Trigger in `wrangler.toml`: release every active hold
 * past its expiry (the request never settled — the Worker was evicted, or the store failed), and
 * drop rate-limit windows and access tokens that ended over an hour ago. Answers how many holds
 * it released; the count goes to the log, nothing else does.
 */
export async function runScheduledSweep(store: Store, now: number): Promise<number> {
  const released = await store.releaseExpiredHolds(now)
  await store.pruneExpired(now - PRUNE_AFTER_MS)
  if (released > 0) console.log(`sweep released=${released}`)
  return released
}

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, depsFor(env))
  },
  async scheduled(controller: ScheduledController, env: WorkerEnv): Promise<void> {
    await runScheduledSweep(d1Store(env.DB), controller.scheduledTime)
  }
}
