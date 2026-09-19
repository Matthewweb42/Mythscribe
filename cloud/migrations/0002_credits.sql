-- F-15.3: MythScribe Cloud credits. Amounts are integers in micro-USD (1e-6 USD, `MICROS_PER_USD`
-- in src/shared/cloudRates.ts); timestamps are epoch milliseconds, like 0001.

-- The running balance, one row per user. It may go slightly negative: a request is charged only
-- after the provider answered, so the last one can overdraw and the next one is refused.
CREATE TABLE credits (
  user_id TEXT PRIMARY KEY,
  balance_micros INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- Every change to a balance, so the balance is auditable and per-feature spend is a GROUP BY.
CREATE TABLE credit_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- 'purchase' (webhook, positive) | 'refund' (webhook, negative) | 'charge' (metered request, negative).
  kind TEXT NOT NULL,
  amount_micros INTEGER NOT NULL,
  -- Charges only: which AI feature spent it and on what.
  feature TEXT,
  model TEXT,
  tokens_in INTEGER,
  tokens_out INTEGER,
  -- Webhook events only: '<event_name>:<lemon squeezy id>'. UNIQUE makes a replayed delivery a
  -- no-op; NULL repeats freely in SQLite, so charges are unaffected.
  order_ref TEXT UNIQUE,
  request_id TEXT,
  created_at INTEGER NOT NULL
);

-- Spend by feature and the event history are both read for one user, newest first.
CREATE INDEX credit_events_user_created_at ON credit_events (user_id, created_at);
