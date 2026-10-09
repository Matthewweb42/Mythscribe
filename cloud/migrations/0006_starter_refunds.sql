-- 2026-10-08 (author): the free trial grant is gone; new accounts try hosted AI with a $5 starter
-- pack instead — one per account ever (kept after a refund), exempt from the $10 minimum, and only
-- for an account whose email is verified. Unused balance is refundable from the app within 30 days
-- of a purchase; that refund reuses `holds` (key 'refund:<order id>') and writes a `refund` ledger
-- row like the webhook's, so no new money table is needed. Timestamps are epoch milliseconds.

-- When the address was proven by a sign-in link or code. Every existing account was created by a
-- verified sign-in (0001-0005 have no other way to make one), so each is verified as of its creation.
ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
UPDATE users SET email_verified_at = created_at;

-- One starter purchase per account, ever: the primary key is the account, so a second order for
-- the same account finds the first and is not credited. Never deleted, not even on a refund.
CREATE TABLE starter_purchases (
  user_id TEXT PRIMARY KEY,
  -- The Lemon Squeezy order; UNIQUE makes a replayed delivery a no-op.
  order_id TEXT NOT NULL UNIQUE,
  purchased_at INTEGER NOT NULL
);

-- Paid orders and their refunds are read per account and order (refund limits, `/credits`).
CREATE INDEX ledger_entries_user_order ON ledger_entries (user_id, order_id, type);
