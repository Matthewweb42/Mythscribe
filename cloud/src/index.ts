/**
 * The MythScribe Cloud Worker (F-15.2, F-15.3): the account routes and the credit routes behind
 * `api.mythscribe.app`. No CORS headers — the desktop app is not a browser origin and nothing
 * here is meant to be called from a web page; only `/auth/verify` is opened in a browser, and it
 * answers HTML. F-15.4 adds the AI proxy route (`POST /ai/complete`) to the same router, F-15.8 the
 * one unauthenticated route, `POST /diagnostics`, and F-15.9 the Supporter license, `GET /license`.
 */
import { type AiDeps, handleAiComplete } from './ai'
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
  ConfiguredPack,
  ConfiguredPacks,
  handleCheckout,
  handleCredits,
  handleLemonSqueezyWebhook
} from './credits'
import { importSigningKey, randomToken } from './crypto'
import { handleDiagnostics } from './diagnostics'
import { logMailer, resendMailer, type Mailer } from './email'
import { handleLicense, type LicenseDeps, LicenseSigningJwk, type LicenseSigner } from './license'
import { openAiUpstream } from './openai'
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
  /** F-15.9: the Supporter product, as one JSON `{ variantId, url, priceCents }` object. */
  LEMONSQUEEZY_SUPPORTER?: string
  LEMONSQUEEZY_WEBHOOK_SECRET?: string
  /** F-15.4: the operator's provider key, the only place it exists; absent → the proxy is a 503. */
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
 * The Supporter product (F-15.9), configured exactly like one pack. Unset or malformed is treated
 * the same way as a malformed pack list: nothing is on sale and the Account tab says so.
 */
function supporterFor(env: WorkerEnv): ConfiguredPack | null {
  if (!env.LEMONSQUEEZY_SUPPORTER) return null
  const parsed = ConfiguredPack.safeParse(parseJson(env.LEMONSQUEEZY_SUPPORTER))
  if (!parsed.success) {
    console.error(
      'LEMONSQUEEZY_SUPPORTER is not a valid product; the Supporter license is off sale'
    )
    return null
  }
  return parsed.data
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
    supporter: supporterFor(env),
    webhookSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET ?? null,
    upstream: env.OPENAI_API_KEY ? openAiUpstream(env.OPENAI_API_KEY) : null,
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
  if (pathname === '/auth/poll' && method === 'POST') return handlePoll(request, deps)
  if (pathname === '/auth/me' && method === 'GET') return handleMe(request, deps)
  if (pathname === '/auth/signout' && method === 'POST') return handleSignOut(request, deps)

  if (pathname === '/credits' && method === 'GET') return handleCredits(request, deps)
  if (pathname === '/billing/checkout' && method === 'POST') return handleCheckout(request, deps)
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

export default {
  fetch(request: Request, env: WorkerEnv): Promise<Response> {
    return handleRequest(request, depsFor(env))
  }
}
