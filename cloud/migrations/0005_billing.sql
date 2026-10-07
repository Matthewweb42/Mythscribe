-- AI-BILLING-SPEC (2026-10-07): the append-only ledger, holds, server-held billing config,
-- per-user rate limits, short-lived access tokens, and sign-in codes. Amounts are integers in
-- micro-USD and timestamps epoch milliseconds, like 0001-0004.

-- The ledger (A7, L1-L4): the source of truth for money. A balance is never stored; it is the sum
-- of the account's entries (L6), so no row is ever updated or deleted — the triggers below refuse
-- it, and a correction is a new `adjustment` row.
CREATE TABLE ledger_entries (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('topup', 'trial_grant', 'charge', 'refund', 'adjustment')),
  amount_micros INTEGER NOT NULL,
  -- L8: a replayed webhook or a retried request carries the same key and lands nowhere.
  -- Top-ups: '<event_name>:<order id>' (the 0002 `order_ref`, so a webhook replayed across this
  -- migration is still a duplicate); refunds: 'order_refunded:<order id>:<refunded cents>';
  -- charges: 'charge:<request id>'; trial grants: 'trial_grant:<sha-256 of the email>'.
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  -- Top-ups and refunds: the Lemon Squeezy order, so a partial refund knows what was refunded.
  order_id TEXT,
  -- Charges only (L4).
  request_id TEXT,
  feature TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  tokens_cached INTEGER,
  provider_cost_micros INTEGER,
  markup_bps INTEGER,
  CHECK (
    (type IN ('topup', 'trial_grant') AND amount_micros > 0)
    OR (type IN ('charge', 'refund') AND amount_micros <= 0)
    OR type = 'adjustment'
  )
);

CREATE INDEX ledger_entries_user_created ON ledger_entries (user_id, created_at, id);
CREATE INDEX ledger_entries_order ON ledger_entries (order_id);

CREATE TRIGGER ledger_entries_no_update BEFORE UPDATE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

CREATE TRIGGER ledger_entries_no_delete BEFORE DELETE ON ledger_entries
BEGIN
  SELECT RAISE(ABORT, 'ledger_entries is append-only');
END;

-- Every 0002 credit event becomes a ledger entry with the same id and amount, so every balance is
-- unchanged: 'purchase' -> 'topup', 'refund' -> 'refund', 'charge' -> 'charge'. `credits` and
-- `credit_events` stay in place, unread from here on (nothing is dropped).
INSERT INTO ledger_entries
  (id, user_id, type, amount_micros, idempotency_key, created_at, order_id,
   request_id, feature, model, tokens_in, tokens_out)
SELECT
  id,
  user_id,
  CASE kind WHEN 'purchase' THEN 'topup' WHEN 'refund' THEN 'refund' ELSE 'charge' END,
  amount_micros,
  COALESCE(order_ref, 'legacy:' || id),
  created_at,
  CASE WHEN order_ref IS NULL THEN NULL ELSE substr(order_ref, instr(order_ref, ':') + 1) END,
  request_id,
  feature,
  model,
  tokens_in,
  tokens_out
FROM credit_events;

-- Holds (L5): the worst-case cost of a request in flight (P4), reserved before it is forwarded and
-- closed when it ends: 'settled' with a charge, or 'released' with none (a failed upstream, or
-- the scheduled sweep once `expires_at` passes). Not money rows, so their status moves. The
-- prices are locked here (P6): a price change applies to the next request, not this one.
CREATE TABLE holds (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- The `Idempotency-Key` (L8): one hold per key and account.
  idempotency_key TEXT NOT NULL,
  -- The attempt that currently owns the hold; a retry of a released hold takes it over.
  request_id TEXT NOT NULL,
  feature TEXT NOT NULL,
  model TEXT NOT NULL,
  amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
  input_micros_per_m INTEGER NOT NULL,
  output_micros_per_m INTEGER NOT NULL,
  cached_micros_per_m INTEGER,
  markup_bps INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'settled', 'released')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  closed_at INTEGER,
  charge_micros INTEGER,
  UNIQUE (user_id, idempotency_key)
);

CREATE INDEX holds_user_status ON holds (user_id, status, expires_at);
CREATE INDEX holds_status_expires ON holds (status, expires_at);

-- Server-held config (AI-BILLING-SPEC "Config defaults", P1): one JSON value per key, overriding
-- the Worker's built-in default for that key. Changed with `wrangler d1 execute`, no release.
CREATE TABLE billing_config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Requests per user per minute (S4): one counter per fixed window, swept by the scheduled job.
CREATE TABLE rate_limits (
  user_id TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (user_id, window_start)
);

-- Short-lived access tokens (A5, S6), minted from a session (the refresh token). Hashes only; a
-- revoked session ends every access token minted from it.
CREATE TABLE access_tokens (
  token_hash TEXT PRIMARY KEY,
  session_hash TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE INDEX access_tokens_expires_at ON access_tokens (expires_at);

-- The sign-in code beside the link (A5): its hash, and the wrong guesses spent on it.
ALTER TABLE login_attempts ADD COLUMN code_hash TEXT;
ALTER TABLE login_attempts ADD COLUMN code_failures INTEGER NOT NULL DEFAULT 0;
