/**
 * The MythScribe Cloud Worker (F-15.2): the account routes behind `api.mythscribe.app`.
 * No CORS headers — the desktop app is not a browser origin and nothing here is meant to be
 * called from a web page; only `/auth/verify` is opened in a browser, and it answers HTML.
 * F-15.4 adds the AI proxy routes to the same router.
 */
import {
  handleMe,
  handlePoll,
  handleSignOut,
  handleStart,
  handleVerify,
  jsonError,
  jsonResponse,
  type AuthDeps
} from './auth'
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
}

function mailerFor(env: WorkerEnv): Mailer | null {
  if (env.EMAIL_TRANSPORT === 'log') return logMailer()
  if (env.RESEND_API_KEY) return resendMailer(env.RESEND_API_KEY)
  return null
}

function depsFor(env: WorkerEnv): AuthDeps {
  return {
    store: d1Store(env.DB),
    mailer: mailerFor(env),
    now: () => new Date(),
    random: randomToken,
    revealLink: env.EMAIL_TRANSPORT === 'log',
    ...(env.PUBLIC_ORIGIN ? { publicOrigin: env.PUBLIC_ORIGIN } : {})
  }
}

function route(request: Request, deps: AuthDeps): Promise<Response> | Response {
  const { pathname } = new URL(request.url)
  const { method } = request

  if (pathname === '/' && method === 'GET') return jsonResponse({ service: 'mythscribe-api' })

  if (pathname === '/auth/start' && method === 'POST') return handleStart(request, deps)
  if (pathname === '/auth/verify' && method === 'GET') return handleVerify(request, deps)
  if (pathname === '/auth/poll' && method === 'POST') return handlePoll(request, deps)
  if (pathname === '/auth/me' && method === 'GET') return handleMe(request, deps)
  if (pathname === '/auth/signout' && method === 'POST') return handleSignOut(request, deps)

  return jsonError('NOT_FOUND', 'No such endpoint.')
}

/** Nothing this Worker answers may be cached: every body is a secret, a session, or a one-off. */
function withNoStore(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Cache-Control', 'no-store')
  return new Response(response.body, { status: response.status, headers })
}

/** The whole request path over injected dependencies, so the tests drive the real router. */
export async function handleRequest(request: Request, deps: AuthDeps): Promise<Response> {
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
