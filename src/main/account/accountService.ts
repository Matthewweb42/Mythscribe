import type { AccountStatus } from '@shared/account'
import {
  type AuthStartResult,
  CloudSession,
  type CreditsResult,
  LOGIN_ATTEMPT_TTL_MS,
  POLL_INTERVAL_MS
} from '@shared/cloudApi'
import type { AiKeyStore } from '../ai/keyStore'
import { AppError } from '../ipc/errors'
import { AccountError, type CloudAuthClient } from './cloudAuthClient'

/**
 * The one owner of the MythScribe account state (F-15.2): signed out, waiting for a sign-in link
 * to be opened, or signed in. It holds the poll timer, persists the session through the key store
 * (`cloudSession`, the same safeStorage file as the provider key), and reports every change the
 * renderer did not ask for through `onChange` (the `account:changed` event).
 *
 * The session token never leaves this module: `status()` says who is signed in, nothing more.
 * Nothing in the app depends on being signed in, so no failure here blocks writing.
 */

/** Stored under the `cloudSession` secret id; the token is the only secret in it. */
const SECRET_ID = 'cloudSession'

export const NO_SAFE_STORAGE_SESSION_MESSAGE =
  'This system has no safe storage available, so a MythScribe account sign-in cannot be stored ' +
  'securely. On Linux, install and unlock a keyring (GNOME Keyring or KWallet), then try again.'

/** Starts a timer and answers its canceller; injectable so tests run the callbacks themselves. */
export type Schedule = (run: () => void, ms: number) => () => void

const defaultSchedule: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms)
  // A pending poll must never hold the app (or a test) open.
  if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  return () => clearTimeout(timer)
}

export interface AccountServiceOptions {
  client: CloudAuthClient
  keyStore: AiKeyStore
  onChange: (status: AccountStatus) => void
  now?: () => number
  schedule?: Schedule
  pollIntervalMs?: number
}

interface PendingAttempt {
  attemptId: string
  pollSecret: string
  email: string
  expiresAt: string
  expiresAtMs: number
  devLink?: string
}

interface SignedInState {
  session: CloudSession
  /** Null until `refresh()` has asked the Worker once; the Worker owns the sign-in date. */
  since: string | null
}

/** A poll failure that will not change by asking again: the attempt itself is gone or invalid. */
const TERMINAL_POLL_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'UNAUTHORIZED',
  'INVALID_EMAIL'
])

export class AccountService {
  private pending: PendingAttempt | null = null
  private signedIn: SignedInState | null = null
  private cancelTimer: (() => void) | null = null
  /** Bumped by every state change, so an answer from an abandoned poll is dropped. */
  private generation = 0
  private disposed = false

  private readonly client: CloudAuthClient
  private readonly keyStore: AiKeyStore
  private readonly onChange: (status: AccountStatus) => void
  private readonly now: () => number
  private readonly schedule: Schedule
  private readonly pollIntervalMs: number

  constructor(options: AccountServiceOptions) {
    this.client = options.client
    this.keyStore = options.keyStore
    this.onChange = options.onChange
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? defaultSchedule
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.signedIn = this.restore()
  }

  status(): AccountStatus {
    if (this.pending !== null) {
      const { email, attemptId, expiresAt, devLink } = this.pending
      return { state: 'pending', email, attemptId, expiresAt, ...(devLink ? { devLink } : {}) }
    }
    if (this.signedIn !== null) {
      const { session, since } = this.signedIn
      return { state: 'signedIn', email: session.email, userId: session.userId, since }
    }
    return { state: 'signedOut' }
  }

  /**
   * Asks the Worker to email a sign-in link and starts polling for its approval. A machine that
   * cannot protect the session is refused before the address leaves the app: signing in only to
   * lose the session on quit would be worse than not signing in.
   */
  async requestLink(email: string): Promise<AccountStatus> {
    if (this.keyStore.encryption() === 'none') {
      throw new AppError('IO', NO_SAFE_STORAGE_SESSION_MESSAGE)
    }
    this.stopPolling()
    let started: AuthStartResult
    try {
      started = await this.client.start(email)
    } catch (err) {
      throw toAppError(err)
    }
    if (this.disposed) return this.status()
    const expiresAtMs = Date.parse(started.expiresAt)
    this.pending = {
      attemptId: started.attemptId,
      pollSecret: started.pollSecret,
      email: normalizeEmail(email),
      expiresAt: started.expiresAt,
      expiresAtMs: Number.isNaN(expiresAtMs) ? this.now() + LOGIN_ATTEMPT_TTL_MS : expiresAtMs,
      ...(started.devLink === undefined ? {} : { devLink: started.devLink })
    }
    this.generation += 1
    this.armPoll()
    return this.status()
  }

  /** Stops waiting for the link; the link itself stays valid on the Worker until it expires. */
  cancelLink(): AccountStatus {
    this.stopPolling()
    return this.status()
  }

  /** Revokes the session on the Worker when it can be reached, and forgets it locally either way. */
  async signOut(): Promise<AccountStatus> {
    this.stopPolling()
    const session = this.signedIn?.session ?? null
    this.signedIn = null
    this.keyStore.clearKey(SECRET_ID)
    if (session !== null) {
      try {
        await this.client.signOut(session.token)
      } catch (err) {
        if (!(err instanceof AccountError)) throw err
        // Best effort: the session is already forgotten here, and it expires on the Worker.
        console.warn(`Could not revoke the MythScribe Cloud session: ${err.message}`)
      }
    }
    return this.status()
  }

  /**
   * Re-checks a stored session with the Worker: fills `since`, and forgets a session the Worker
   * no longer accepts. An unreachable Worker leaves the status exactly as it was.
   */
  async refresh(): Promise<AccountStatus> {
    const current = this.signedIn
    if (current === null) return this.status()
    try {
      const me = await this.client.me(current.session.token)
      if (this.signedIn !== current) return this.status()
      this.signedIn = {
        session: { ...current.session, email: me.email, userId: me.userId },
        since: me.since
      }
      return this.status()
    } catch (err) {
      if (err instanceof AccountError && err.code === 'UNAUTHORIZED') {
        if (this.signedIn === current) this.forget()
        return this.status()
      }
      throw toAppError(err)
    }
  }

  /**
   * The account's MythScribe Cloud credits (F-15.3): balance, spend per feature, and the packs
   * on sale. Signed out is a failure the author can act on, not an empty balance.
   */
  async credits(): Promise<CreditsResult> {
    const current = this.requireSignedIn('Sign in to see your MythScribe Cloud credits.')
    try {
      return await this.client.credits(current.session.token)
    } catch (err) {
      throw this.callFailed(err, current)
    }
  }

  /**
   * The Lemon Squeezy checkout URL for one pack (F-15.3). The Worker builds it (it knows the
   * account and the pack); this only carries it back to the handler, which opens it.
   */
  async checkoutUrl(variantId: string): Promise<string> {
    const current = this.requireSignedIn('Sign in to buy MythScribe Cloud credits.')
    try {
      const { url } = await this.client.checkout(current.session.token, variantId)
      return url
    } catch (err) {
      throw this.callFailed(err, current)
    }
  }

  /**
   * The session token for a Cloud call made inside main (F-15.4's proxy adapter), or null when
   * signed out. It never crosses IPC and is never stored anywhere but the key store.
   */
  sessionToken(): string | null {
    return this.signedIn?.session.token ?? null
  }

  /**
   * The Worker refused the session (a 401 from the proxy): forget it exactly as `refresh()` and
   * the credit calls do, and tell the renderer through `account:changed`. A no-op when there is
   * nothing signed in, so a burst of failed requests pushes one change, not one each.
   */
  sessionEnded(): void {
    if (this.signedIn === null) return
    this.forget()
    this.onChange(this.status())
  }

  /** The app is quitting: drop the poll timer. Nothing stored changes. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
  }

  /** Drops the signed-in state and the stored session; the caller decides who to tell. */
  private forget(): void {
    this.signedIn = null
    this.keyStore.clearKey(SECRET_ID)
  }

  /** The session a Cloud call needs, or the failure that says which action wanted one. */
  private requireSignedIn(message: string): SignedInState {
    if (this.signedIn === null) throw new AppError('IO', message)
    return this.signedIn
  }

  /**
   * A call made with the session failed. A session the Worker no longer accepts is forgotten
   * here exactly as `refresh()` forgets it, and the renderer hears it through `account:changed`
   * (these calls answer credits, not a status, so there is nothing else to tell it with).
   */
  private callFailed(err: unknown, state: SignedInState): Error {
    if (err instanceof AccountError && err.code === 'UNAUTHORIZED' && this.signedIn === state) {
      this.forget()
      this.onChange(this.status())
    }
    // The pack is gone from the Worker's configuration: the author picked something that is no
    // longer on sale, which is a bad request, not an outage.
    if (err instanceof AccountError && err.code === 'NOT_FOUND') {
      return new AppError('VALIDATION', `${err.message} ${err.nextStep}`, { code: err.code })
    }
    return toAppError(err)
  }

  /** The stored session, or null (and the stored garbage cleared) when it cannot be read. */
  private restore(): SignedInState | null {
    const raw = this.keyStore.getKey(SECRET_ID)
    if (raw === null) return null
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      json = undefined
    }
    const parsed = CloudSession.safeParse(json)
    if (!parsed.success) {
      console.warn('Ignoring an unreadable stored MythScribe Cloud session')
      this.keyStore.clearKey(SECRET_ID)
      return null
    }
    return { session: parsed.data, since: null }
  }

  private stopPolling(): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.pending = null
    this.generation += 1
  }

  private armPoll(): void {
    if (this.disposed) return
    const generation = this.generation
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      void this.poll(generation)
    }, this.pollIntervalMs)
  }

  /** One poll tick. Anything answered for an abandoned attempt (`generation`) is dropped. */
  private async poll(generation: number): Promise<void> {
    const attempt = this.pending
    if (attempt === null || generation !== this.generation || this.disposed) return
    if (this.now() >= attempt.expiresAtMs) {
      this.expire()
      return
    }
    try {
      const result = await this.client.poll({
        attemptId: attempt.attemptId,
        pollSecret: attempt.pollSecret
      })
      if (generation !== this.generation || this.disposed) return
      if (result.status === 'ready') {
        this.signIn(result.session)
        return
      }
      if (result.status === 'expired') {
        this.expire()
        return
      }
    } catch (err) {
      if (generation !== this.generation || this.disposed) return
      if (err instanceof AccountError && TERMINAL_POLL_CODES.has(err.code)) {
        console.warn(`Sign-in attempt abandoned: ${err.message}`)
        this.expire()
        return
      }
      // A network blip is normal for a 15-minute wait: keep asking until the link expires.
      if (!(err instanceof AccountError)) console.error('Sign-in poll failed', err)
    }
    if (this.now() >= attempt.expiresAtMs) {
      this.expire()
      return
    }
    this.armPoll()
  }

  private signIn(session: CloudSession): void {
    this.cancelTimer?.()
    this.cancelTimer = null
    this.pending = null
    this.generation += 1
    try {
      this.keyStore.setKey(SECRET_ID, JSON.stringify(session))
    } catch (err) {
      // Safe storage was checked before the link was sent; if it went away, say so and stay out.
      console.error('Could not store the MythScribe Cloud session', err)
      this.signedIn = null
      this.onChange(this.status())
      return
    }
    this.signedIn = { session, since: null }
    this.onChange(this.status())
  }

  private expire(): void {
    this.stopPolling()
    this.onChange(this.status())
  }
}

/** The address as the Worker stores it, so the pending copy names what the email was sent to. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** Every Cloud failure reaches the renderer as one typed error with the next step in the message. */
export function toAppError(err: unknown): Error {
  if (err instanceof AccountError) {
    return new AppError(
      err.code === 'INVALID_EMAIL' ? 'VALIDATION' : 'IO',
      `${err.message} ${err.nextStep}`,
      { code: err.code }
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}
