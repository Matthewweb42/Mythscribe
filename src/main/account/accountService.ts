import type { AccountStatus } from '@shared/account'
import {
  type AuthStartResult,
  CloudSession,
  type CreditPack,
  type CreditsResult,
  type LicenseResult,
  LOGIN_ATTEMPT_TTL_MS,
  POLL_INTERVAL_MS
} from '@shared/cloudApi'
import {
  LICENSE_REFRESH_INTERVAL_MS,
  type AccentId,
  type LicenseClaims,
  type LicensePublicKeyJwk,
  type SupporterSettings,
  type SupporterStatus
} from '@shared/license'
import type { AiKeyStore } from '../ai/keyStore'
import type { AppStateStore } from '../appState/appStateStore'
import { AppError } from '../ipc/errors'
import { defaultSchedule, type Schedule } from '../schedule'
import { AccountError, type CloudAuthClient } from './cloudAuthClient'
import { verifyLicenseToken } from './licenseVerifier'

/**
 * The one owner of the MythScribe account state (F-15.2): signed out, waiting for a sign-in link
 * to be opened, or signed in. It holds the poll timer, persists the session through the key store
 * (`cloudSession`, the same safeStorage file as the provider key), and reports every change the
 * renderer did not ask for through `onChange` (the `account:changed` event).
 *
 * The session token never leaves this module: `status()` says who is signed in, nothing more.
 * Nothing in the app depends on being signed in, so no failure here blocks writing.
 *
 * It also owns the Supporter license (F-15.9), because the license follows the account: the token
 * is cached in `app-state.json`, verified locally against the Worker's public key, refreshed in
 * the background while signed in, and dropped whenever the session is. Neither the refresh nor a
 * failed one blocks anything: a cached token is trusted until its `exp`.
 */

/** Stored under the `cloudSession` secret id; the token is the only secret in it. */
const SECRET_ID = 'cloudSession'

export const NO_SAFE_STORAGE_SESSION_MESSAGE =
  'This system has no safe storage available, so a MythScribe account sign-in cannot be stored ' +
  'securely. On Linux, install and unlock a keyring (GNOME Keyring or KWallet), then try again.'

export const SIGN_IN_FOR_LICENSE_MESSAGE = 'Sign in to check your MythScribe Supporter license.'
export const SIGN_IN_TO_BUY_LICENSE_MESSAGE = 'Sign in to buy the MythScribe Supporter license.'
export const LICENSE_NOT_ON_SALE_MESSAGE =
  'The Supporter license is not on sale yet. Try again later.'
export const ACCENT_NEEDS_LICENSE_MESSAGE =
  'The accent colours come with the Supporter license. Become a Supporter to use them.'

export interface AccountServiceOptions {
  client: CloudAuthClient
  keyStore: AiKeyStore
  /** F-15.9: where the cached license token and the chosen accent live (`app-state.json`). */
  appState: AppStateStore
  /** F-15.9: the key every license token is verified against (`licensePublicKey(process.env)`). */
  licensePublicKey: LicensePublicKeyJwk
  onChange: (status: AccountStatus) => void
  /**
   * F-15.9: the license changed without the renderer asking — a background refresh, a sign-in, or
   * a sign-out (`account:supporterChanged`).
   */
  onSupporterChange: (status: SupporterStatus) => void
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
  /** F-15.9: the daily license refresh; separate from the poll, which is a sign-in only. */
  private cancelLicenseTimer: (() => void) | null = null
  /**
   * F-15.9: the product the last `/license` answer named, for the Buy button. Not persisted: the
   * price is the Worker's to say, and a fresh launch learns it from the refresh on construction.
   */
  private product: CreditPack | null = null
  /** Bumped by every state change, so an answer from an abandoned poll is dropped. */
  private generation = 0
  private disposed = false

  private readonly client: CloudAuthClient
  private readonly keyStore: AiKeyStore
  private readonly appState: AppStateStore
  private readonly licensePublicKey: LicensePublicKeyJwk
  private readonly onChange: (status: AccountStatus) => void
  private readonly onSupporterChange: (status: SupporterStatus) => void
  private readonly now: () => number
  private readonly schedule: Schedule
  private readonly pollIntervalMs: number

  constructor(options: AccountServiceOptions) {
    this.client = options.client
    this.keyStore = options.keyStore
    this.appState = options.appState
    this.licensePublicKey = options.licensePublicKey
    this.onChange = options.onChange
    this.onSupporterChange = options.onSupporterChange
    this.now = options.now ?? (() => Date.now())
    this.schedule = options.schedule ?? defaultSchedule
    this.pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS
    this.signedIn = this.restore()
    // F-15.9: a signed-in app checks the license at once, so a purchase made on another machine
    // (or a refund) is seen on the next launch, and then once a day. A failure is silent.
    if (this.signedIn !== null) this.startLicenseRefresh()
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
    // The license goes with the session (F-15.9); the renderer hears that as `supporterChanged`.
    this.forget()
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
      if (!this.sameSession(current)) return this.status()
      this.signedIn = {
        session: { ...current.session, email: me.email, userId: me.userId },
        since: me.since
      }
      return this.status()
    } catch (err) {
      if (err instanceof AccountError && err.code === 'UNAUTHORIZED') {
        if (this.sameSession(current)) this.forget()
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
   * The Supporter license (F-15.9) as the renderer sees it, read from the cache alone: the token
   * is verified against the embedded public key and the signed-in account, so nothing here waits
   * on the network. `offline` means no refresh has reached the Worker inside the refresh interval
   * and the cached token is being trusted on its own.
   */
  supporter(): SupporterStatus {
    const settings = this.appState.get().supporter
    const claims = this.verifiedClaims(settings.token)
    if (claims === null) {
      return {
        licensed: false,
        since: null,
        validUntil: null,
        offline: false,
        product: this.product,
        accent: 'default'
      }
    }
    const { refreshedAt } = settings
    return {
      licensed: true,
      since: new Date(claims.iat).toISOString(),
      validUntil: new Date(claims.exp).toISOString(),
      offline: refreshedAt === null || this.now() - refreshedAt >= LICENSE_REFRESH_INTERVAL_MS,
      // Nothing to buy while the license is held; the Buy button belongs to the unlicensed state.
      product: null,
      accent: settings.accent
    }
  }

  /**
   * Asks the Worker for a fresh license token (F-15.9) and answers the status it leaves behind.
   * The author asked for this one, so a failure is thrown rather than swallowed; the cached token
   * is left exactly as it was, which is what makes the grace period work.
   */
  async refreshLicense(): Promise<SupporterStatus> {
    return this.runLicenseRefresh(false)
  }

  /**
   * The Lemon Squeezy checkout URL for the Supporter license (F-15.9). The Worker builds it from
   * the variant it published in the last `/license` answer; the handler opens it.
   */
  async supporterCheckoutUrl(): Promise<string> {
    const current = this.requireSignedIn(SIGN_IN_TO_BUY_LICENSE_MESSAGE)
    const product = this.product
    if (product === null) throw new AppError('VALIDATION', LICENSE_NOT_ON_SALE_MESSAGE)
    try {
      const { url } = await this.client.checkout(current.session.token, product.variantId)
      return url
    } catch (err) {
      throw this.callFailed(err, current)
    }
  }

  /**
   * Picks the app-wide accent (F-15.9). `default` is every install's; the rest are the cosmetic
   * extra the license unlocks, so they are refused without one rather than stored and ignored.
   */
  setAccent(accent: AccentId): SupporterStatus {
    if (accent !== 'default' && !this.supporter().licensed) {
      throw new AppError('VALIDATION', ACCENT_NEEDS_LICENSE_MESSAGE)
    }
    this.writeSupporter({ accent })
    return this.supporter()
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

  /** The app is quitting: drop the poll and license timers. Nothing stored changes. */
  dispose(): void {
    this.disposed = true
    this.stopPolling()
    this.stopLicenseRefresh()
  }

  /**
   * Drops the signed-in state, the stored session, and the cached license; the caller decides who
   * to tell about the account, but the license change is pushed here, because the calls that
   * forget a session answer an account status and have nothing else to carry it.
   */
  private forget(): void {
    this.signedIn = null
    this.keyStore.clearKey(SECRET_ID)
    this.clearLicense()
  }

  /** One license refresh. `push` is for the ones nobody asked for (construction, sign-in, timer). */
  private async runLicenseRefresh(push: boolean): Promise<SupporterStatus> {
    const current = this.requireSignedIn(SIGN_IN_FOR_LICENSE_MESSAGE)
    const before = this.supporter()
    let result: LicenseResult
    try {
      result = await this.client.license(current.session.token)
    } catch (err) {
      throw this.callFailed(err, current)
    }
    // Signed out (or into another account) while the request was in flight: store nothing.
    if (!this.sameSession(current)) return this.supporter()
    this.product = result.product
    if (result.token === null) {
      // No license, or a refunded one: the Worker is the authority, so the cache goes.
      this.writeSupporter({ token: null, refreshedAt: this.now() })
    } else if (verifyLicenseToken(result.token, this.licensePublicKey, this.now()) === null) {
      // A token this build cannot verify is worth nothing, and overwriting a good cached one with
      // it would end the extras for no reason: refuse it and say so once.
      console.warn('Refused a Supporter license token that does not verify against the app key')
    } else {
      this.writeSupporter({ token: result.token, refreshedAt: this.now() })
    }
    const after = this.supporter()
    if (push && !sameSupporter(before, after)) this.onSupporterChange(after)
    return after
  }

  /** The claims of a cached token, or null: only a verified token for the signed-in account counts. */
  private verifiedClaims(token: string | null): LicenseClaims | null {
    const signedIn = this.signedIn
    if (token === null || signedIn === null) return null
    const claims = verifyLicenseToken(token, this.licensePublicKey, this.now())
    // A token for another account is no better than an unsigned one.
    return claims?.sub === signedIn.session.userId ? claims : null
  }

  private writeSupporter(patch: Partial<SupporterSettings>): void {
    this.appState.update((state) => ({
      ...state,
      supporter: { ...state.supporter, ...patch }
    }))
  }

  /** The first refresh of a signed-in session, then one every `LICENSE_REFRESH_INTERVAL_MS`. */
  private startLicenseRefresh(): void {
    this.refreshLicenseQuietly()
    this.armLicenseRefresh()
  }

  private armLicenseRefresh(): void {
    if (this.disposed) return
    this.stopLicenseRefresh()
    this.cancelLicenseTimer = this.schedule(() => {
      this.cancelLicenseTimer = null
      if (this.signedIn === null || this.disposed) return
      this.refreshLicenseQuietly()
      this.armLicenseRefresh()
    }, LICENSE_REFRESH_INTERVAL_MS)
  }

  private stopLicenseRefresh(): void {
    this.cancelLicenseTimer?.()
    this.cancelLicenseTimer = null
  }

  /**
   * A refresh nobody is waiting for. Nothing about the license is urgent: an unreachable Worker
   * leaves the cached token, which stays good for the rest of its grace period, and the author is
   * told nothing.
   */
  private refreshLicenseQuietly(): void {
    void this.runLicenseRefresh(true).catch((err: unknown) => {
      console.warn(
        `Could not check the Supporter license: ${err instanceof Error ? err.message : String(err)}`
      )
    })
  }

  /** The session is gone, so the license is too (F-15.9); the accent choice is kept for next time. */
  private clearLicense(): void {
    this.stopLicenseRefresh()
    this.product = null
    const { token, refreshedAt } = this.appState.get().supporter
    if (token === null && refreshedAt === null) return
    this.writeSupporter({ token: null, refreshedAt: null })
    this.onSupporterChange(this.supporter())
  }

  /**
   * Whether the session a call started with is still the one signed in. Compared by token, not
   * by object: `refresh()` replaces the state object with the Worker's copy of the account, and a
   * license or credits answer that was in flight at the time must still count for it.
   */
  private sameSession(state: SignedInState): boolean {
    return this.signedIn !== null && this.signedIn.session.token === state.session.token
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
    if (err instanceof AccountError && err.code === 'UNAUTHORIZED' && this.sameSession(state)) {
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
    // F-15.9: whatever license this account holds is asked for straight away, so the Account tab
    // shows the badge without the author refreshing anything.
    this.startLicenseRefresh()
    this.onChange(this.status())
  }

  private expire(): void {
    this.stopPolling()
    this.onChange(this.status())
  }
}

/** Whether two license statuses say the same thing, so a background refresh pushes only changes. */
function sameSupporter(a: SupporterStatus, b: SupporterStatus): boolean {
  return (
    a.licensed === b.licensed &&
    a.since === b.since &&
    a.validUntil === b.validUntil &&
    a.offline === b.offline &&
    a.accent === b.accent &&
    a.product?.variantId === b.product?.variantId &&
    a.product?.priceCents === b.product?.priceCents
  )
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
