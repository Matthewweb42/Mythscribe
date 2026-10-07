/**
 * Storage for the account routes (F-15.2), the billing ledger and holds (AI-BILLING-SPEC A7,
 * L1-L8), the diagnostics aggregates (F-15.8), and the licenses (F-15.9): the `Store` interface
 * the handlers use and its one implementation, SQL over D1. The unit tests run the very same SQL
 * on an in-memory SQLite database with every migration applied (`testing/sqliteD1.ts`), so what
 * is tested is what ships. Timestamps are epoch milliseconds so expiry is a plain SQL comparison;
 * the handlers format them for the wire. Every secret arrives here already hashed.
 *
 * Money: a balance is never stored. It is the sum of the account's `ledger_entries` (append-only,
 * enforced by triggers in 0005) minus its active holds (L6). The balance check and the hold are
 * one conditional `INSERT … SELECT … WHERE available >= amount` statement (L7): D1 runs every
 * write against one SQLite database, one statement at a time, so no second request can read the
 * balance between another's check and its hold — the statement itself is the lock.
 */
import type { LedgerEntryType } from '../../src/shared/cloudApi'
import type { LockedPrices } from '../../src/shared/cloudBilling'

/**
 * The slice of D1 this module uses, so the tests can hand it an SQLite database of their own.
 * `D1Database` satisfies it as is.
 */
export type SqlValue = string | number | null

export interface SqlResult<T> {
  results: T[]
  meta: { changes: number }
}

export interface SqlStatement {
  bind(...values: SqlValue[]): SqlStatement
  first<T>(): Promise<T | null>
  all<T>(): Promise<SqlResult<T>>
  run(): Promise<SqlResult<unknown>>
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement
  /** One transaction: every statement lands, or none does. */
  batch(statements: SqlStatement[]): Promise<SqlResult<unknown>[]>
}

export interface UserRow {
  id: string
  email: string
  createdAt: number
}

export type LoginAttemptStatus = 'pending' | 'approved' | 'claimed'

export interface LoginAttemptRow {
  id: string
  email: string
  pollSecretHash: string
  linkTokenHash: string
  /** The hash of the code mailed beside the link; null on attempts started before 0005. */
  codeHash: string | null
  /** Wrong codes tried so far; the attempt is spent at `LOGIN_CODE_MAX_FAILURES`. */
  codeFailures: number
  status: LoginAttemptStatus
  /** The minted session token, parked here between `/auth/verify` and the one `/auth/poll`. */
  sessionToken: string | null
  userId: string | null
  createdAt: number
  expiresAt: number
}

export interface SessionRow {
  tokenHash: string
  userId: string
  createdAt: number
  expiresAt: number
  lastSeenAt: number
  revokedAt: number | null
}

/** A short-lived access token (A5), minted from the session whose hash it carries. */
export interface AccessTokenRow {
  tokenHash: string
  sessionHash: string
  userId: string
  createdAt: number
  expiresAt: number
}

/** One money row (L3, L4). Never updated, never deleted. */
export interface LedgerEntryRow {
  id: string
  userId: string
  type: LedgerEntryType
  /** Signed micro-USD: a top-up or a trial grant adds, a charge or a refund subtracts. */
  amountMicros: number
  /** UNIQUE: a replay with the same key lands nowhere (L8). */
  idempotencyKey: string
  createdAt: number
  /** Top-ups and refunds: the Lemon Squeezy order id. */
  orderId: string | null
  /** Charges only (L4). */
  requestId: string | null
  feature: string | null
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  tokensCached: number | null
  providerCostMicros: number | null
  markupBps: number | null
}

/** A ledger row with every charge-only and order-only field empty, for top-ups and grants. */
export function plainEntry(
  entry: Pick<
    LedgerEntryRow,
    'id' | 'userId' | 'type' | 'amountMicros' | 'idempotencyKey' | 'createdAt'
  > &
    Partial<Pick<LedgerEntryRow, 'orderId'>>
): LedgerEntryRow {
  return {
    orderId: null,
    requestId: null,
    feature: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    tokensCached: null,
    providerCostMicros: null,
    markupBps: null,
    ...entry
  }
}

/** The two sums the available balance is made of (L6): available = ledger − held. */
export interface BalanceRow {
  ledgerMicros: number
  heldMicros: number
}

export type HoldStatus = 'active' | 'settled' | 'released'

/** A reservation for one request in flight (L5), with its prices locked (P6). */
export interface HoldRow {
  id: string
  userId: string
  idempotencyKey: string
  /** The attempt that owns the hold now; a retry of a released hold takes it over. */
  requestId: string
  feature: string
  model: string
  amountMicros: number
  prices: LockedPrices
  status: HoldStatus
  createdAt: number
  expiresAt: number
  closedAt: number | null
  chargeMicros: number | null
}

/**
 * The outcome of a hold: placed (forward the request), insufficient (refuse, forward nothing), or
 * a duplicate of an `Idempotency-Key` that is still running or already charged.
 */
export type PlaceHoldResult =
  | { status: 'placed'; hold: HoldRow }
  | { status: 'insufficient' }
  | { status: 'duplicate'; hold: HoldRow }

/** A refund of (part of) one order; `refundedMicros` is the order's cumulative refunded amount. */
export interface OrderRefund {
  id: string
  userId: string
  orderId: string
  refundedMicros: number
  idempotencyKey: string
  createdAt: number
}

/**
 * The license of one account (F-15.9; since 2026-10-07 also the $30 app license), as
 * `supporter_licenses` holds it. The order it was bought with stays in the table only for
 * idempotency, so it is not reported here.
 */
export interface SupporterLicenseRow {
  grantedAt: number
  /** Set by a refund; a revoked license is answered exactly like no license at all. */
  revokedAt: number | null
}

/** One feature's spend over one window, as `GET /credits` reports it; `micros` is positive. */
export interface SpendByFeatureRow {
  feature: string
  micros: number
  requests: number
  tokens: number
}

/** One `billing_config` row: a key and its JSON value, validated by `config.ts`. */
export interface ConfigRow {
  key: string
  value: string
}

/**
 * Diagnostics (F-15.8). Nothing below belongs to an account: a report carries no session and no
 * install id, so these are pure aggregates — a day, a build, a platform, and a number.
 */

/** One counter from one report: add `n` to this day, build, platform, and counter. */
export interface DiagnosticCountDelta {
  day: string
  appVersion: string
  platform: string
  counter: string
  n: number
}

/** One crash as it arrives; the message and the stack were scrubbed by the app before sending. */
export interface DiagnosticCrashInput {
  fingerprint: string
  kind: string
  name: string
  message: string
  /** The scrubbed frames, newline-separated. */
  stack: string
  appVersion: string
  platform: string
  arch: string
  /** When the Worker received it (epoch ms); the app never says when the crash happened. */
  at: number
}

/** A stored count row, as `diagnostic_counts` holds it. */
export interface StoredDiagnosticCount extends Omit<DiagnosticCountDelta, 'n'> {
  total: number
}

/** A stored crash group, as `diagnostic_crashes` holds it. */
export interface StoredDiagnosticCrash extends Omit<DiagnosticCrashInput, 'at'> {
  count: number
  firstSeen: number
  lastSeen: number
}

export interface Store {
  findUserByEmail(email: string): Promise<UserRow | null>
  findUserById(id: string): Promise<UserRow | null>
  insertUser(user: UserRow): Promise<void>

  /** How many attempts this address started since `since` (epoch ms); the rate limit. */
  countAttemptsSince(email: string, since: number): Promise<number>
  insertLoginAttempt(attempt: LoginAttemptRow): Promise<void>
  findAttemptById(id: string): Promise<LoginAttemptRow | null>
  findAttemptByLinkHash(linkTokenHash: string): Promise<LoginAttemptRow | null>
  /** The link was opened: park the session token on the attempt for the next poll. */
  approveAttempt(id: string, userId: string, sessionToken: string): Promise<void>
  /** The app collected the session: wipe the token so it is handed over exactly once. */
  claimAttempt(id: string): Promise<void>
  /** A wrong sign-in code: count it and answer the new total. */
  recordCodeFailure(id: string): Promise<number>

  insertSession(session: SessionRow): Promise<void>
  findSessionByHash(tokenHash: string): Promise<SessionRow | null>
  touchSession(tokenHash: string, at: number): Promise<void>
  revokeSession(tokenHash: string, at: number): Promise<void>

  insertAccessToken(token: AccessTokenRow): Promise<void>
  findAccessTokenByHash(tokenHash: string): Promise<AccessTokenRow | null>

  /** The ledger's sum and the active (unexpired) holds of one account at `now`. */
  getBalance(userId: string, now: number): Promise<BalanceRow>
  /** Append one money row; `'duplicate'` when its idempotency key already landed (L8). */
  appendLedgerEntry(entry: LedgerEntryRow): Promise<'applied' | 'duplicate'>
  /**
   * Refund (part of) an order: append the difference between `refundedMicros` and what was
   * already refunded for the order, in one statement. `'duplicate'` when nothing is left to add.
   */
  refundOrder(refund: OrderRefund): Promise<'applied' | 'duplicate'>
  /**
   * Check the available balance and reserve `hold.amountMicros` in one statement (L7). A key
   * whose earlier hold was released (nothing charged) is taken over by this attempt.
   */
  placeHold(hold: HoldRow, now: number): Promise<PlaceHoldResult>
  /** Charge the request (one ledger row keyed by its request id) and close its hold. */
  settleHold(hold: HoldRow, charge: LedgerEntryRow, at: number): Promise<void>
  /** Close the hold with no charge (a failed or cancelled request). */
  releaseHold(hold: HoldRow, at: number): Promise<void>
  /** The scheduled sweep (L5): release every active hold past its expiry; answers how many. */
  releaseExpiredHolds(now: number): Promise<number>

  /** Count one request in the account's window and answer the window's total (S4). */
  hitRateLimit(userId: string, windowStart: number): Promise<number>
  /** The scheduled sweep: drop rate windows and access tokens that ended before `before`. */
  pruneExpired(before: number): Promise<void>

  /** The account's ledger, newest first, strictly older than `before` when it is given (E7). */
  listLedger(
    userId: string,
    limit: number,
    before: { createdAt: number; id: string } | null
  ): Promise<LedgerEntryRow[]>
  /**
   * Spend per feature, charges only, positive amounts. `since` (epoch ms) bounds the window:
   * the default 0 is lifetime, the usage meter (F-15.5) passes the start of the period.
   */
  spendByFeature(userId: string, since?: number): Promise<SpendByFeatureRow[]>
  /** When the oldest charge at or after `since` was made (epoch ms); null when there is none. */
  firstChargeAt(userId: string, since: number): Promise<number | null>

  /** Every `billing_config` row; `config.ts` validates them over the built-in defaults. */
  readBillingConfig(): Promise<ConfigRow[]>

  /**
   * F-15.9: record the license one order paid for. `'duplicate'` means an order with this
   * `orderRef` was already recorded (a replayed webhook delivery): nothing changed. A *new* order
   * for an account that already has a row re-grants it, which is how a purchase after a refund
   * lands.
   */
  grantSupporter(userId: string, orderRef: string, at: number): Promise<'applied' | 'duplicate'>
  /** F-15.9: a refunded order; from here on `GET /license` answers no token. Idempotent. */
  revokeSupporter(userId: string, at: number): Promise<void>
  /** F-15.9: the account's license, revoked or not; null when it never bought one. */
  findSupporter(userId: string): Promise<SupporterLicenseRow | null>

  /**
   * F-15.8: add one report's counts to the aggregates. An upsert per row, so the report itself
   * leaves no trace — only `total` moves.
   */
  addDiagnosticCounts(deltas: DiagnosticCountDelta[]): Promise<void>
  /**
   * F-15.8: record crashes by fingerprint. The first sighting stores the group, every later one
   * bumps `count` and `last_seen` and keeps the message and stack that were stored first.
   */
  recordDiagnosticCrashes(crashes: DiagnosticCrashInput[]): Promise<void>
}

interface RawUser {
  id: string
  email: string
  created_at: number
}

interface RawAttempt {
  id: string
  email: string
  poll_secret_hash: string
  link_token_hash: string
  code_hash: string | null
  code_failures: number
  status: string
  session_token: string | null
  user_id: string | null
  created_at: number
  expires_at: number
}

interface RawSession {
  token_hash: string
  user_id: string
  created_at: number
  expires_at: number
  last_seen_at: number
  revoked_at: number | null
}

interface RawAccessToken {
  token_hash: string
  session_hash: string
  user_id: string
  created_at: number
  expires_at: number
}

interface RawLedgerEntry {
  id: string
  user_id: string
  type: LedgerEntryType
  amount_micros: number
  idempotency_key: string
  created_at: number
  order_id: string | null
  request_id: string | null
  feature: string | null
  model: string | null
  tokens_in: number | null
  tokens_out: number | null
  tokens_cached: number | null
  provider_cost_micros: number | null
  markup_bps: number | null
}

interface RawHold {
  id: string
  user_id: string
  idempotency_key: string
  request_id: string
  feature: string
  model: string
  amount_micros: number
  input_micros_per_m: number
  output_micros_per_m: number
  cached_micros_per_m: number | null
  markup_bps: number
  status: HoldStatus
  created_at: number
  expires_at: number
  closed_at: number | null
  charge_micros: number | null
}

interface RawSpend {
  feature: string
  micros: number
  requests: number
  tokens: number
}

interface RawSupporter {
  granted_at: number
  revoked_at: number | null
}

/**
 * D1 reports a constraint failure as a thrown error carrying SQLite's message; the only UNIQUE
 * index a Supporter grant can trip is its `order_ref`, which means "already applied".
 */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && error.message.includes('UNIQUE constraint failed')
}

function toUser(row: RawUser | null): UserRow | null {
  return row ? { id: row.id, email: row.email, createdAt: row.created_at } : null
}

function toStatus(status: string): LoginAttemptStatus {
  return status === 'approved' || status === 'claimed' ? status : 'pending'
}

function toAttempt(row: RawAttempt | null): LoginAttemptRow | null {
  if (!row) return null
  return {
    id: row.id,
    email: row.email,
    pollSecretHash: row.poll_secret_hash,
    linkTokenHash: row.link_token_hash,
    codeHash: row.code_hash,
    codeFailures: row.code_failures,
    status: toStatus(row.status),
    sessionToken: row.session_token,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }
}

function toSession(row: RawSession | null): SessionRow | null {
  if (!row) return null
  return {
    tokenHash: row.token_hash,
    userId: row.user_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at
  }
}

export function toLedgerEntry(row: RawLedgerEntry): LedgerEntryRow {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    amountMicros: row.amount_micros,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    orderId: row.order_id,
    requestId: row.request_id,
    feature: row.feature,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    tokensCached: row.tokens_cached,
    providerCostMicros: row.provider_cost_micros,
    markupBps: row.markup_bps
  }
}

export function toHold(row: RawHold): HoldRow {
  return {
    id: row.id,
    userId: row.user_id,
    idempotencyKey: row.idempotency_key,
    requestId: row.request_id,
    feature: row.feature,
    model: row.model,
    amountMicros: row.amount_micros,
    prices: {
      inputMicrosPerM: row.input_micros_per_m,
      outputMicrosPerM: row.output_micros_per_m,
      cachedMicrosPerM: row.cached_micros_per_m,
      markupBps: row.markup_bps
    },
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    chargeMicros: row.charge_micros
  }
}

export type { RawHold, RawLedgerEntry }

/**
 * The available balance of `?2` at `?12` (epoch ms), as an SQL expression: the ledger's sum minus
 * the active holds that have not expired. Shared by the hold and its takeover so both check the
 * same thing. An expired hold no longer counts even before the sweep marks it released.
 */
const AVAILABLE = `(
  (SELECT COALESCE(SUM(amount_micros), 0) FROM ledger_entries WHERE user_id = ?2)
  - (SELECT COALESCE(SUM(amount_micros), 0) FROM holds
      WHERE user_id = ?2 AND status = 'active' AND expires_at > ?12)
)`

/** The hold's 13 positional parameters, in the order `PLACE_HOLD` and `TAKE_OVER_HOLD` use. */
function holdParams(hold: HoldRow, now: number): SqlValue[] {
  return [
    hold.id,
    hold.userId,
    hold.idempotencyKey,
    hold.requestId,
    hold.feature,
    hold.model,
    hold.amountMicros,
    hold.prices.inputMicrosPerM,
    hold.prices.outputMicrosPerM,
    hold.prices.cachedMicrosPerM,
    hold.prices.markupBps,
    now,
    hold.expiresAt
  ]
}

/**
 * L7: the balance check and the hold as one statement. The `WHERE` reads the balance and the
 * `INSERT` reserves it with nothing in between, and D1 executes one statement at a time, so two
 * requests racing for the last dollar cannot both see it. A key that already has a hold inserts
 * nothing (`ON CONFLICT … DO NOTHING`, L8).
 */
const PLACE_HOLD = `
  INSERT INTO holds
    (id, user_id, idempotency_key, request_id, feature, model, amount_micros,
     input_micros_per_m, output_micros_per_m, cached_micros_per_m, markup_bps,
     status, created_at, expires_at)
  SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 'active', ?12, ?13
  WHERE ${AVAILABLE} >= ?7
  ON CONFLICT (user_id, idempotency_key) DO NOTHING`

/**
 * A retry of a key whose hold was released (the earlier attempt failed and charged nothing) takes
 * the hold over, with the same balance check in the same statement.
 */
const TAKE_OVER_HOLD = `
  UPDATE holds
     SET request_id = ?4, feature = ?5, model = ?6, amount_micros = ?7,
         input_micros_per_m = ?8, output_micros_per_m = ?9, cached_micros_per_m = ?10,
         markup_bps = ?11, status = 'active', created_at = ?12, expires_at = ?13,
         closed_at = NULL, charge_micros = NULL
   WHERE user_id = ?2 AND idempotency_key = ?3 AND status = 'released' AND id <> ?1
     AND ${AVAILABLE} >= ?7`

const INSERT_LEDGER_ENTRY = `
  INSERT INTO ledger_entries
    (id, user_id, type, amount_micros, idempotency_key, created_at, order_id, request_id,
     feature, model, tokens_in, tokens_out, tokens_cached, provider_cost_micros, markup_bps)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (idempotency_key) DO NOTHING`

function ledgerParams(entry: LedgerEntryRow): SqlValue[] {
  return [
    entry.id,
    entry.userId,
    entry.type,
    entry.amountMicros,
    entry.idempotencyKey,
    entry.createdAt,
    entry.orderId,
    entry.requestId,
    entry.feature,
    entry.model,
    entry.tokensIn,
    entry.tokensOut,
    entry.tokensCached,
    entry.providerCostMicros,
    entry.markupBps
  ]
}

/** The production store: prepared statements against the `mythscribe` D1 database. */
export function d1Store(db: SqlDatabase): Store {
  return {
    async findUserByEmail(email: string): Promise<UserRow | null> {
      const row = await db
        .prepare('SELECT id, email, created_at FROM users WHERE email = ?')
        .bind(email)
        .first<RawUser>()
      return toUser(row)
    },

    async findUserById(id: string): Promise<UserRow | null> {
      const row = await db
        .prepare('SELECT id, email, created_at FROM users WHERE id = ?')
        .bind(id)
        .first<RawUser>()
      return toUser(row)
    },

    async insertUser(user: UserRow): Promise<void> {
      await db
        .prepare('INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)')
        .bind(user.id, user.email, user.createdAt)
        .run()
    },

    async countAttemptsSince(email: string, since: number): Promise<number> {
      const row = await db
        .prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE email = ? AND created_at >= ?')
        .bind(email, since)
        .first<{ n: number }>()
      return row ? row.n : 0
    },

    async insertLoginAttempt(attempt: LoginAttemptRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO login_attempts
             (id, email, poll_secret_hash, link_token_hash, code_hash, code_failures, status,
              session_token, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          attempt.id,
          attempt.email,
          attempt.pollSecretHash,
          attempt.linkTokenHash,
          attempt.codeHash,
          attempt.codeFailures,
          attempt.status,
          attempt.sessionToken,
          attempt.userId,
          attempt.createdAt,
          attempt.expiresAt
        )
        .run()
    },

    async findAttemptById(id: string): Promise<LoginAttemptRow | null> {
      const row = await db
        .prepare('SELECT * FROM login_attempts WHERE id = ?')
        .bind(id)
        .first<RawAttempt>()
      return toAttempt(row)
    },

    async findAttemptByLinkHash(linkTokenHash: string): Promise<LoginAttemptRow | null> {
      const row = await db
        .prepare('SELECT * FROM login_attempts WHERE link_token_hash = ?')
        .bind(linkTokenHash)
        .first<RawAttempt>()
      return toAttempt(row)
    },

    async approveAttempt(id: string, userId: string, sessionToken: string): Promise<void> {
      await db
        .prepare(
          `UPDATE login_attempts SET status = 'approved', user_id = ?, session_token = ?
           WHERE id = ? AND status = 'pending'`
        )
        .bind(userId, sessionToken, id)
        .run()
    },

    async claimAttempt(id: string): Promise<void> {
      await db
        .prepare("UPDATE login_attempts SET status = 'claimed', session_token = NULL WHERE id = ?")
        .bind(id)
        .run()
    },

    async recordCodeFailure(id: string): Promise<number> {
      const row = await db
        .prepare(
          `UPDATE login_attempts SET code_failures = code_failures + 1 WHERE id = ?
           RETURNING code_failures`
        )
        .bind(id)
        .first<{ code_failures: number }>()
      return row ? row.code_failures : 0
    },

    async insertSession(session: SessionRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO sessions (token_hash, user_id, created_at, expires_at, last_seen_at, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .bind(
          session.tokenHash,
          session.userId,
          session.createdAt,
          session.expiresAt,
          session.lastSeenAt,
          session.revokedAt
        )
        .run()
    },

    async findSessionByHash(tokenHash: string): Promise<SessionRow | null> {
      const row = await db
        .prepare('SELECT * FROM sessions WHERE token_hash = ?')
        .bind(tokenHash)
        .first<RawSession>()
      return toSession(row)
    },

    async touchSession(tokenHash: string, at: number): Promise<void> {
      await db
        .prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?')
        .bind(at, tokenHash)
        .run()
    },

    async revokeSession(tokenHash: string, at: number): Promise<void> {
      await db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL')
        .bind(at, tokenHash)
        .run()
    },

    async insertAccessToken(token: AccessTokenRow): Promise<void> {
      await db
        .prepare(
          `INSERT INTO access_tokens (token_hash, session_hash, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?)`
        )
        .bind(token.tokenHash, token.sessionHash, token.userId, token.createdAt, token.expiresAt)
        .run()
    },

    async findAccessTokenByHash(tokenHash: string): Promise<AccessTokenRow | null> {
      const row = await db
        .prepare('SELECT * FROM access_tokens WHERE token_hash = ?')
        .bind(tokenHash)
        .first<RawAccessToken>()
      if (!row) return null
      return {
        tokenHash: row.token_hash,
        sessionHash: row.session_hash,
        userId: row.user_id,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      }
    },

    async getBalance(userId: string, now: number): Promise<BalanceRow> {
      const row = await db
        .prepare(
          `SELECT
             (SELECT COALESCE(SUM(amount_micros), 0) FROM ledger_entries WHERE user_id = ?1)
               AS ledger_micros,
             (SELECT COALESCE(SUM(amount_micros), 0) FROM holds
               WHERE user_id = ?1 AND status = 'active' AND expires_at > ?2) AS held_micros`
        )
        .bind(userId, now)
        .first<{ ledger_micros: number; held_micros: number }>()
      return { ledgerMicros: row?.ledger_micros ?? 0, heldMicros: row?.held_micros ?? 0 }
    },

    async appendLedgerEntry(entry: LedgerEntryRow): Promise<'applied' | 'duplicate'> {
      const result = await db
        .prepare(INSERT_LEDGER_ENTRY)
        .bind(...ledgerParams(entry))
        .run()
      return result.meta.changes > 0 ? 'applied' : 'duplicate'
    },

    async refundOrder(refund: OrderRefund): Promise<'applied' | 'duplicate'> {
      // The amount is computed in the statement from what the order already had refunded, so a
      // second delivery of a larger cumulative refund adds only the difference.
      const result = await db
        .prepare(
          `INSERT INTO ledger_entries
             (id, user_id, type, amount_micros, idempotency_key, created_at, order_id)
           SELECT ?1, ?2, 'refund', -(?3 - already), ?4, ?5, ?6
             FROM (SELECT COALESCE(-SUM(amount_micros), 0) AS already
                     FROM ledger_entries WHERE order_id = ?6 AND type = 'refund')
            WHERE ?3 > already
           ON CONFLICT (idempotency_key) DO NOTHING`
        )
        .bind(
          refund.id,
          refund.userId,
          refund.refundedMicros,
          refund.idempotencyKey,
          refund.createdAt,
          refund.orderId
        )
        .run()
      return result.meta.changes > 0 ? 'applied' : 'duplicate'
    },

    async placeHold(hold: HoldRow, now: number): Promise<PlaceHoldResult> {
      const params = holdParams(hold, now)
      // One batch, one transaction: the insert, the takeover of a released key, and the read
      // of what the key now holds, with no other write in between.
      const [, , found] = await db.batch([
        db.prepare(PLACE_HOLD).bind(...params),
        db.prepare(TAKE_OVER_HOLD).bind(...params),
        db
          .prepare('SELECT * FROM holds WHERE user_id = ? AND idempotency_key = ?')
          .bind(hold.userId, hold.idempotencyKey)
      ])
      const raw = (found?.results[0] ?? null) as RawHold | null
      if (raw === null) return { status: 'insufficient' }
      const row = toHold(raw)
      if (row.requestId === hold.requestId && row.status === 'active') {
        return { status: 'placed', hold: row }
      }
      // A released key that could not be taken over: the balance is short.
      if (row.status === 'released') return { status: 'insufficient' }
      return { status: 'duplicate', hold: row }
    },

    async settleHold(hold: HoldRow, charge: LedgerEntryRow, at: number): Promise<void> {
      // The charge is keyed by the request id, so settling twice charges once; the hold closes
      // only for the attempt that owns it.
      await db.batch([
        db.prepare(INSERT_LEDGER_ENTRY).bind(...ledgerParams(charge)),
        db
          .prepare(
            `UPDATE holds SET status = 'settled', closed_at = ?, charge_micros = ?
              WHERE id = ? AND request_id = ? AND status <> 'settled'`
          )
          .bind(at, -charge.amountMicros, hold.id, hold.requestId)
      ])
    },

    async releaseHold(hold: HoldRow, at: number): Promise<void> {
      await db
        .prepare(
          `UPDATE holds SET status = 'released', closed_at = ?
            WHERE id = ? AND request_id = ? AND status = 'active'`
        )
        .bind(at, hold.id, hold.requestId)
        .run()
    },

    async releaseExpiredHolds(now: number): Promise<number> {
      const result = await db
        .prepare(
          `UPDATE holds SET status = 'released', closed_at = ?1
            WHERE status = 'active' AND expires_at <= ?1`
        )
        .bind(now)
        .run()
      return result.meta.changes
    },

    async hitRateLimit(userId: string, windowStart: number): Promise<number> {
      const row = await db
        .prepare(
          `INSERT INTO rate_limits (user_id, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT (user_id, window_start) DO UPDATE SET count = count + 1
           RETURNING count`
        )
        .bind(userId, windowStart)
        .first<{ count: number }>()
      return row ? row.count : 1
    },

    async pruneExpired(before: number): Promise<void> {
      await db.batch([
        db.prepare('DELETE FROM rate_limits WHERE window_start < ?').bind(before),
        db.prepare('DELETE FROM access_tokens WHERE expires_at < ?').bind(before)
      ])
    },

    async listLedger(
      userId: string,
      limit: number,
      before: { createdAt: number; id: string } | null
    ): Promise<LedgerEntryRow[]> {
      const result = await db
        .prepare(
          `SELECT * FROM ledger_entries
            WHERE user_id = ?1
              AND (?2 IS NULL OR created_at < ?2 OR (created_at = ?2 AND id < ?3))
            ORDER BY created_at DESC, id DESC
            LIMIT ?4`
        )
        .bind(userId, before?.createdAt ?? null, before?.id ?? null, limit)
        .all<RawLedgerEntry>()
      return result.results.map(toLedgerEntry)
    },

    async spendByFeature(userId: string, since = 0): Promise<SpendByFeatureRow[]> {
      // The `(user_id, created_at, id)` index covers both the lifetime and the windowed read.
      const result = await db
        .prepare(
          `SELECT feature,
                  SUM(-amount_micros) AS micros,
                  COUNT(*) AS requests,
                  SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
             FROM ledger_entries
            WHERE user_id = ? AND type = 'charge' AND feature IS NOT NULL AND created_at >= ?
            GROUP BY feature
            ORDER BY micros DESC`
        )
        .bind(userId, since)
        .all<RawSpend>()
      return result.results.map((row) => ({
        feature: row.feature,
        micros: row.micros,
        requests: row.requests,
        tokens: row.tokens
      }))
    },

    async firstChargeAt(userId: string, since: number): Promise<number | null> {
      // MIN over no rows is a row holding NULL, so an account with no charges answers null.
      const row = await db
        .prepare(
          `SELECT MIN(created_at) AS first_at
             FROM ledger_entries
            WHERE user_id = ? AND type = 'charge' AND created_at >= ?`
        )
        .bind(userId, since)
        .first<{ first_at: number | null }>()
      return row?.first_at ?? null
    },

    async readBillingConfig(): Promise<ConfigRow[]> {
      const result = await db
        .prepare('SELECT key, value FROM billing_config ORDER BY key')
        .all<ConfigRow>()
      return result.results
    },

    async grantSupporter(
      userId: string,
      orderRef: string,
      at: number
    ): Promise<'applied' | 'duplicate'> {
      // `order_ref` is the idempotency key, but the upsert below would quietly re-grant on a
      // replayed delivery instead of tripping it, so a known order is recognised first.
      const seen = await db
        .prepare('SELECT 1 AS n FROM supporter_licenses WHERE order_ref = ?')
        .bind(orderRef)
        .first<{ n: number }>()
      if (seen) return 'duplicate'

      try {
        await db
          .prepare(
            `INSERT INTO supporter_licenses (user_id, order_ref, granted_at, revoked_at)
             VALUES (?, ?, ?, NULL)
             ON CONFLICT(user_id) DO UPDATE
               SET order_ref = excluded.order_ref,
                   granted_at = excluded.granted_at,
                   revoked_at = NULL`
          )
          .bind(userId, orderRef, at)
          .run()
        return 'applied'
      } catch (error) {
        // Two deliveries of the same order at once: the loser trips the UNIQUE index.
        if (isUniqueViolation(error)) return 'duplicate'
        throw error
      }
    },

    async revokeSupporter(userId: string, at: number): Promise<void> {
      await db
        .prepare(
          'UPDATE supporter_licenses SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL'
        )
        .bind(at, userId)
        .run()
    },

    async findSupporter(userId: string): Promise<SupporterLicenseRow | null> {
      const row = await db
        .prepare('SELECT granted_at, revoked_at FROM supporter_licenses WHERE user_id = ?')
        .bind(userId)
        .first<RawSupporter>()
      return row ? { grantedAt: row.granted_at, revokedAt: row.revoked_at } : null
    },

    async addDiagnosticCounts(deltas: DiagnosticCountDelta[]): Promise<void> {
      if (deltas.length === 0) return
      const statements = deltas.map((delta) =>
        db
          .prepare(
            `INSERT INTO diagnostic_counts (day, app_version, platform, counter, total)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(day, app_version, platform, counter) DO UPDATE
               SET total = total + excluded.total`
          )
          .bind(delta.day, delta.appVersion, delta.platform, delta.counter, delta.n)
      )
      // One batch is one transaction: a report's counts land together or not at all, so a
      // failure halfway cannot leave a day counted twice when the app retries.
      await db.batch(statements)
    },

    async recordDiagnosticCrashes(crashes: DiagnosticCrashInput[]): Promise<void> {
      if (crashes.length === 0) return
      const statements = crashes.map((crash) =>
        db
          .prepare(
            `INSERT INTO diagnostic_crashes
               (fingerprint, kind, name, message, stack, app_version, platform, arch,
                count, first_seen, last_seen)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
             ON CONFLICT(fingerprint) DO UPDATE
               SET count = count + 1, last_seen = excluded.last_seen`
          )
          .bind(
            crash.fingerprint,
            crash.kind,
            crash.name,
            crash.message,
            crash.stack,
            crash.appVersion,
            crash.platform,
            crash.arch,
            crash.at,
            crash.at
          )
      )
      await db.batch(statements)
    }
  }
}
