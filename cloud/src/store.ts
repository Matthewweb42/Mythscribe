/**
 * Storage for the account routes (F-15.2), the credit ledger (F-15.3), the diagnostics
 * aggregates (F-15.8), and the Supporter licenses (F-15.9): the `Store` interface the handlers
 * use, the D1 implementation behind it, and an in-memory one for the unit tests. Timestamps are
 * epoch milliseconds so expiry is a plain SQL comparison; the handlers format them for the wire.
 * Every secret arrives here already hashed.
 */

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

/** A purchase and a refund come from the webhook; a charge from an answered Cloud request. */
export type CreditEventKind = 'purchase' | 'refund' | 'charge'

export interface CreditEventRow {
  id: string
  userId: string
  kind: CreditEventKind
  /** Signed micro-USD: a purchase adds, a refund and a charge subtract. */
  amountMicros: number
  /** Charges only: the `AiFeatureId` that spent it and what answered. */
  feature: string | null
  model: string | null
  tokensIn: number | null
  tokensOut: number | null
  /** Webhook events only: `<event_name>:<lemon squeezy id>`; UNIQUE, so a replay is a duplicate. */
  orderRef: string | null
  requestId: string | null
  createdAt: number
}

/**
 * The Supporter license of one account (F-15.9), as `supporter_licenses` holds it. The order it
 * was bought with stays in the table only for idempotency, so it is not reported here.
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

  insertSession(session: SessionRow): Promise<void>
  findSessionByHash(tokenHash: string): Promise<SessionRow | null>
  touchSession(tokenHash: string, at: number): Promise<void>
  revokeSession(tokenHash: string, at: number): Promise<void>

  /** The user's balance in micro-USD; 0 for a user who never bought or spent anything. */
  getBalance(userId: string): Promise<number>
  /**
   * Record the event and move the balance by the same amount, both or neither. `'duplicate'`
   * means an event with this `orderRef` was already applied (a replayed webhook delivery):
   * nothing changed and the caller answers 200 anyway.
   */
  applyCreditEvent(event: CreditEventRow): Promise<'applied' | 'duplicate'>
  /**
   * Spend per feature, charges only, positive amounts. `since` (epoch ms) bounds the window:
   * the default 0 is lifetime, the usage meter (F-15.5) passes the start of the period.
   */
  spendByFeature(userId: string, since?: number): Promise<SpendByFeatureRow[]>
  /** When the oldest charge at or after `since` was made (epoch ms); null when there is none. */
  firstChargeAt(userId: string, since: number): Promise<number | null>

  /**
   * F-15.9: record the Supporter license one order paid for. `'duplicate'` means an order with
   * this `orderRef` was already recorded (a replayed webhook delivery): nothing changed. A *new*
   * order for an account that already has a row re-grants it, which is how a purchase after a
   * refund lands.
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
 * index a credit event or a Supporter grant can trip is its `order_ref`, which means "already
 * applied".
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

/** The production store: prepared statements against the `mythscribe` D1 database. */
export function d1Store(db: D1Database): Store {
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
             (id, email, poll_secret_hash, link_token_hash, status, session_token, user_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          attempt.id,
          attempt.email,
          attempt.pollSecretHash,
          attempt.linkTokenHash,
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

    async getBalance(userId: string): Promise<number> {
      const row = await db
        .prepare('SELECT balance_micros FROM credits WHERE user_id = ?')
        .bind(userId)
        .first<{ balance_micros: number }>()
      return row ? row.balance_micros : 0
    },

    async applyCreditEvent(event: CreditEventRow): Promise<'applied' | 'duplicate'> {
      const insertEvent = db
        .prepare(
          `INSERT INTO credit_events
             (id, user_id, kind, amount_micros, feature, model, tokens_in, tokens_out, order_ref, request_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          event.id,
          event.userId,
          event.kind,
          event.amountMicros,
          event.feature,
          event.model,
          event.tokensIn,
          event.tokensOut,
          event.orderRef,
          event.requestId,
          event.createdAt
        )
      const moveBalance = db
        .prepare(
          `INSERT INTO credits (user_id, balance_micros, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE
             SET balance_micros = balance_micros + excluded.balance_micros,
                 updated_at = excluded.updated_at`
        )
        .bind(event.userId, event.amountMicros, event.createdAt)

      try {
        // One batch is one transaction: a replayed webhook trips the `order_ref` UNIQUE index
        // and neither statement lands, so the balance cannot be credited twice.
        await db.batch([insertEvent, moveBalance])
        return 'applied'
      } catch (error) {
        if (isUniqueViolation(error)) return 'duplicate'
        throw error
      }
    },

    async spendByFeature(userId: string, since = 0): Promise<SpendByFeatureRow[]> {
      // The `(user_id, created_at)` index covers both the lifetime and the windowed read.
      const result = await db
        .prepare(
          `SELECT feature,
                  SUM(-amount_micros) AS micros,
                  COUNT(*) AS requests,
                  SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
             FROM credit_events
            WHERE user_id = ? AND kind = 'charge' AND feature IS NOT NULL AND created_at >= ?
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
             FROM credit_events
            WHERE user_id = ? AND kind = 'charge' AND created_at >= ?`
        )
        .bind(userId, since)
        .first<{ first_at: number | null }>()
      return row?.first_at ?? null
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

/**
 * The in-memory store plus the read-backs the unit tests assert on. The D1 store has no
 * equivalent of those: no handler reads a diagnostics aggregate back — the operator queries them
 * with `wrangler d1 execute` (see `README.md`).
 */
export interface MemoryStore extends Store {
  diagnosticCounts(): StoredDiagnosticCount[]
  diagnosticCrashes(): StoredDiagnosticCrash[]
}

/** The test store: the same semantics in a handful of maps, no SQL. */
export function memoryStore(): MemoryStore {
  const users = new Map<string, UserRow>()
  const attempts = new Map<string, LoginAttemptRow>()
  const sessions = new Map<string, SessionRow>()
  const balances = new Map<string, number>()
  const creditEvents: CreditEventRow[] = []
  const supporters = new Map<string, SupporterLicenseRow & { orderRef: string }>()
  const counts = new Map<string, StoredDiagnosticCount>()
  const crashes = new Map<string, StoredDiagnosticCrash>()

  /** The composite primary key of `diagnostic_counts`, as one map key. */
  const countKey = (delta: Omit<DiagnosticCountDelta, 'n'>): string =>
    [delta.day, delta.appVersion, delta.platform, delta.counter].join(' ')

  return {
    findUserByEmail(email: string): Promise<UserRow | null> {
      const found = [...users.values()].find((user) => user.email === email)
      return Promise.resolve(found ? { ...found } : null)
    },

    findUserById(id: string): Promise<UserRow | null> {
      const found = users.get(id)
      return Promise.resolve(found ? { ...found } : null)
    },

    insertUser(user: UserRow): Promise<void> {
      users.set(user.id, { ...user })
      return Promise.resolve()
    },

    countAttemptsSince(email: string, since: number): Promise<number> {
      const n = [...attempts.values()].filter(
        (attempt) => attempt.email === email && attempt.createdAt >= since
      ).length
      return Promise.resolve(n)
    },

    insertLoginAttempt(attempt: LoginAttemptRow): Promise<void> {
      attempts.set(attempt.id, { ...attempt })
      return Promise.resolve()
    },

    findAttemptById(id: string): Promise<LoginAttemptRow | null> {
      const found = attempts.get(id)
      return Promise.resolve(found ? { ...found } : null)
    },

    findAttemptByLinkHash(linkTokenHash: string): Promise<LoginAttemptRow | null> {
      const found = [...attempts.values()].find(
        (attempt) => attempt.linkTokenHash === linkTokenHash
      )
      return Promise.resolve(found ? { ...found } : null)
    },

    approveAttempt(id: string, userId: string, sessionToken: string): Promise<void> {
      const found = attempts.get(id)
      if (found?.status === 'pending') {
        attempts.set(id, { ...found, status: 'approved', userId, sessionToken })
      }
      return Promise.resolve()
    },

    claimAttempt(id: string): Promise<void> {
      const found = attempts.get(id)
      if (found) attempts.set(id, { ...found, status: 'claimed', sessionToken: null })
      return Promise.resolve()
    },

    insertSession(session: SessionRow): Promise<void> {
      sessions.set(session.tokenHash, { ...session })
      return Promise.resolve()
    },

    findSessionByHash(tokenHash: string): Promise<SessionRow | null> {
      const found = sessions.get(tokenHash)
      return Promise.resolve(found ? { ...found } : null)
    },

    touchSession(tokenHash: string, at: number): Promise<void> {
      const found = sessions.get(tokenHash)
      if (found) sessions.set(tokenHash, { ...found, lastSeenAt: at })
      return Promise.resolve()
    },

    revokeSession(tokenHash: string, at: number): Promise<void> {
      const found = sessions.get(tokenHash)
      if (found?.revokedAt === null) sessions.set(tokenHash, { ...found, revokedAt: at })
      return Promise.resolve()
    },

    getBalance(userId: string): Promise<number> {
      return Promise.resolve(balances.get(userId) ?? 0)
    },

    applyCreditEvent(event: CreditEventRow): Promise<'applied' | 'duplicate'> {
      // Mirrors the D1 UNIQUE index: a NULL `orderRef` (every charge) never collides.
      if (event.orderRef !== null && creditEvents.some((row) => row.orderRef === event.orderRef)) {
        return Promise.resolve('duplicate')
      }
      creditEvents.push({ ...event })
      balances.set(event.userId, (balances.get(event.userId) ?? 0) + event.amountMicros)
      return Promise.resolve('applied')
    },

    spendByFeature(userId: string, since = 0): Promise<SpendByFeatureRow[]> {
      const byFeature = new Map<string, SpendByFeatureRow>()
      for (const event of creditEvents) {
        if (event.userId !== userId || event.kind !== 'charge' || event.feature === null) continue
        if (event.createdAt < since) continue
        const row = byFeature.get(event.feature) ?? {
          feature: event.feature,
          micros: 0,
          requests: 0,
          tokens: 0
        }
        row.micros += -event.amountMicros
        row.requests += 1
        row.tokens += (event.tokensIn ?? 0) + (event.tokensOut ?? 0)
        byFeature.set(event.feature, row)
      }
      return Promise.resolve([...byFeature.values()].sort((a, b) => b.micros - a.micros))
    },

    firstChargeAt(userId: string, since: number): Promise<number | null> {
      const times = creditEvents
        .filter(
          (event) => event.userId === userId && event.kind === 'charge' && event.createdAt >= since
        )
        .map((event) => event.createdAt)
      return Promise.resolve(times.length === 0 ? null : Math.min(...times))
    },

    grantSupporter(userId: string, orderRef: string, at: number): Promise<'applied' | 'duplicate'> {
      // Mirrors the UNIQUE `order_ref`: one order grants once, whoever it was for.
      if ([...supporters.values()].some((row) => row.orderRef === orderRef)) {
        return Promise.resolve('duplicate')
      }
      supporters.set(userId, { orderRef, grantedAt: at, revokedAt: null })
      return Promise.resolve('applied')
    },

    revokeSupporter(userId: string, at: number): Promise<void> {
      const found = supporters.get(userId)
      if (found?.revokedAt === null) supporters.set(userId, { ...found, revokedAt: at })
      return Promise.resolve()
    },

    findSupporter(userId: string): Promise<SupporterLicenseRow | null> {
      const found = supporters.get(userId)
      return Promise.resolve(
        found ? { grantedAt: found.grantedAt, revokedAt: found.revokedAt } : null
      )
    },

    addDiagnosticCounts(deltas: DiagnosticCountDelta[]): Promise<void> {
      for (const delta of deltas) {
        const key = countKey(delta)
        const existing = counts.get(key)
        counts.set(key, {
          day: delta.day,
          appVersion: delta.appVersion,
          platform: delta.platform,
          counter: delta.counter,
          total: (existing?.total ?? 0) + delta.n
        })
      }
      return Promise.resolve()
    },

    recordDiagnosticCrashes(inputs: DiagnosticCrashInput[]): Promise<void> {
      for (const { at, ...crash } of inputs) {
        const existing = crashes.get(crash.fingerprint)
        // Mirrors the D1 upsert: the stored message and stack are the first one's.
        crashes.set(
          crash.fingerprint,
          existing
            ? { ...existing, count: existing.count + 1, lastSeen: at }
            : { ...crash, count: 1, firstSeen: at, lastSeen: at }
        )
      }
      return Promise.resolve()
    },

    diagnosticCounts(): StoredDiagnosticCount[] {
      return [...counts.values()].map((row) => ({ ...row }))
    },

    diagnosticCrashes(): StoredDiagnosticCrash[] {
      return [...crashes.values()].map((row) => ({ ...row }))
    }
  }
}
