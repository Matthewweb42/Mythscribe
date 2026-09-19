/**
 * Storage for the account routes (F-15.2) and the credit ledger (F-15.3): the `Store` interface
 * the handlers use, the D1 implementation behind it, and an in-memory one for the unit tests.
 * Timestamps are epoch milliseconds so expiry is a plain SQL comparison; the handlers format
 * them for the wire. Every secret arrives here already hashed.
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

/** One feature's lifetime spend, as `GET /credits` reports it; `micros` is positive. */
export interface SpendByFeatureRow {
  feature: string
  micros: number
  requests: number
  tokens: number
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
  /** Lifetime spend per feature, charges only, positive amounts. */
  spendByFeature(userId: string): Promise<SpendByFeatureRow[]>
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

/**
 * D1 reports a constraint failure as a thrown error carrying SQLite's message; the only UNIQUE
 * index a credit event can trip is `order_ref`, which means "already applied".
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

    async spendByFeature(userId: string): Promise<SpendByFeatureRow[]> {
      const result = await db
        .prepare(
          `SELECT feature,
                  SUM(-amount_micros) AS micros,
                  COUNT(*) AS requests,
                  SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
             FROM credit_events
            WHERE user_id = ? AND kind = 'charge' AND feature IS NOT NULL
            GROUP BY feature
            ORDER BY micros DESC`
        )
        .bind(userId)
        .all<RawSpend>()
      return result.results.map((row) => ({
        feature: row.feature,
        micros: row.micros,
        requests: row.requests,
        tokens: row.tokens
      }))
    }
  }
}

/** The test store: the same semantics in a handful of maps, no SQL. */
export function memoryStore(): Store {
  const users = new Map<string, UserRow>()
  const attempts = new Map<string, LoginAttemptRow>()
  const sessions = new Map<string, SessionRow>()
  const balances = new Map<string, number>()
  const creditEvents: CreditEventRow[] = []

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

    spendByFeature(userId: string): Promise<SpendByFeatureRow[]> {
      const byFeature = new Map<string, SpendByFeatureRow>()
      for (const event of creditEvents) {
        if (event.userId !== userId || event.kind !== 'charge' || event.feature === null) continue
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
    }
  }
}
