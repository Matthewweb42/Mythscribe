import type { AccessToken, AuthRefreshResult } from '@shared/cloudApi'
import { AccountError, type CloudAuthClient } from './cloudAuthClient'

/**
 * Short-lived access tokens (AI-BILLING-SPEC A5, S6; slice B3b). The session token the account
 * keeps in the OS keychain is the revocable refresh token; every bearer call sends a 15-minute
 * access token minted from it by `POST /auth/refresh` instead. The access token lives in memory
 * only and is never written anywhere; a restart simply mints a new one.
 *
 * A Worker deployed before `/auth/refresh` existed answers it NOT_FOUND; the session token itself
 * is then the bearer, exactly as before, so an app update never signs anyone out of an older
 * Worker.
 */

/** An access token this close to its expiry is replaced before use, so no call races the clock. */
export const ACCESS_TOKEN_MARGIN_MS = 60_000

export interface CloudAccessTokensOptions {
  refresh: (refreshToken: string) => Promise<AuthRefreshResult>
  now?: () => number
}

interface CachedAccess {
  refreshToken: string
  token: string
  expiresAtMs: number
}

export class CloudAccessTokens {
  private cached: CachedAccess | null = null
  private inflight: { refreshToken: string; promise: Promise<string> } | null = null
  private readonly now: () => number

  constructor(private readonly options: CloudAccessTokensOptions) {
    this.now = options.now ?? Date.now
  }

  /** Keeps an access token the Worker handed over with the session (a finished sign-in). */
  seed(refreshToken: string, access: AccessToken): void {
    const expiresAtMs = Date.parse(access.expiresAt)
    if (Number.isNaN(expiresAtMs)) return
    this.cached = { refreshToken, token: access.token, expiresAtMs }
  }

  /**
   * The bearer for a call made with the session `refreshToken`: the cached access token while it
   * has more than `ACCESS_TOKEN_MARGIN_MS` left, else a fresh one. Concurrent calls share one
   * refresh. Throws the refresh's `AccountError` (UNAUTHORIZED: the session is gone).
   */
  bearer(refreshToken: string): Promise<string> {
    const cached = this.cached
    if (
      cached !== null &&
      cached.refreshToken === refreshToken &&
      cached.expiresAtMs - ACCESS_TOKEN_MARGIN_MS > this.now()
    ) {
      return Promise.resolve(cached.token)
    }
    if (this.inflight?.refreshToken === refreshToken) return this.inflight.promise
    const promise = this.mint(refreshToken).finally(() => {
      if (this.inflight?.promise === promise) this.inflight = null
    })
    this.inflight = { refreshToken, promise }
    return promise
  }

  /** Forgets the cached access token, so the next call mints one (a 401, a sign-out). */
  invalidate(): void {
    this.cached = null
  }

  private async mint(refreshToken: string): Promise<string> {
    try {
      const { access } = await this.options.refresh(refreshToken)
      this.seed(refreshToken, access)
      return access.token
    } catch (err) {
      if (err instanceof AccountError && err.code === 'NOT_FOUND') return refreshToken
      throw err
    }
  }
}

/**
 * The Cloud client with every bearer call sent with an access token rather than the session
 * token. The callers (`AccountService`) keep passing the session token; this swaps it, and on a
 * 401 mints a fresh access token and tries once more before the UNAUTHORIZED reaches them. Sign
 * out still sends the session token, which revokes the session and every access token with it.
 */
export function withAccessTokens(
  client: CloudAuthClient,
  tokens: CloudAccessTokens
): CloudAuthClient {
  const authed = async <T>(
    refreshToken: string,
    call: (bearer: string) => Promise<T>
  ): Promise<T> => {
    const bearer = await tokens.bearer(refreshToken)
    try {
      return await call(bearer)
    } catch (err) {
      const unauthorized = err instanceof AccountError && err.code === 'UNAUTHORIZED'
      if (!unauthorized || bearer === refreshToken) throw err
      tokens.invalidate()
      return call(await tokens.bearer(refreshToken))
    }
  }

  return {
    start: (email) => client.start(email),
    refresh: (refreshToken) => client.refresh(refreshToken),
    async poll(body) {
      const result = await client.poll(body)
      if (result.status === 'ready' && result.access !== undefined) {
        tokens.seed(result.session.token, result.access)
      }
      return result
    },
    me: (token) => authed(token, (bearer) => client.me(bearer)),
    async signOut(token) {
      tokens.invalidate()
      await client.signOut(token)
    },
    credits: (token) => authed(token, (bearer) => client.credits(bearer)),
    checkout: (token, variantId) => authed(token, (bearer) => client.checkout(bearer, variantId)),
    license: (token) => authed(token, (bearer) => client.license(bearer)),
    usage: (token, cursor) => authed(token, (bearer) => client.usage(bearer, cursor)),
    refund: (token, orderId) => authed(token, (bearer) => client.refund(bearer, orderId))
  }
}
