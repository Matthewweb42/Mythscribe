-- F-15.9: the Supporter license — the one-time purchase that unlocks the cosmetic extras for
-- authors who bring their own key. One row per account that bought it; timestamps are epoch
-- milliseconds, like 0001-0003. No token is stored: `GET /license` signs a fresh one from this row
-- every time it is asked (see `src/license.ts`), so revoking is enough to stop renewing it.
CREATE TABLE supporter_licenses (
  user_id TEXT PRIMARY KEY,
  -- The Lemon Squeezy order that paid for it, '<event_name>:<order id>' as in `credit_events`.
  -- UNIQUE makes a replayed webhook delivery a no-op; a later order re-grants the same account
  -- (a re-purchase after a refund), which is why the order — not the user — is the unique column.
  order_ref TEXT UNIQUE NOT NULL,
  granted_at INTEGER NOT NULL,
  -- Set by an `order_refunded` delivery. A revoked row answers no token, so the app's cached one
  -- simply expires at the end of its grace period.
  revoked_at INTEGER
);
