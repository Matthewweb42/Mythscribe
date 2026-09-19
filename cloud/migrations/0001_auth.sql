-- F-15.2: MythScribe accounts (email magic link). Timestamps are epoch milliseconds.
-- Secrets are stored as SHA-256 hex digests only.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE login_attempts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  poll_secret_hash TEXT NOT NULL,
  link_token_hash TEXT NOT NULL,
  -- 'pending' -> 'approved' (link opened) -> 'claimed' (session handed to the app, once).
  status TEXT NOT NULL,
  session_token TEXT,
  user_id TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- The rate limit counts attempts per address within the attempt lifetime.
CREATE INDEX login_attempts_email_created_at ON login_attempts (email, created_at);
-- /auth/verify looks the attempt up by the hash of the link token.
CREATE INDEX login_attempts_link_token_hash ON login_attempts (link_token_hash);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);
