-- F-15.8: opt-in diagnostics. Both tables are aggregates on purpose: there is no per-report row,
-- no install id, no account, and no IP, so two reports from the same machine cannot be told
-- apart. Timestamps are epoch milliseconds, like 0001 and 0002; `day` is the app's local calendar
-- day as `YYYY-MM-DD`, which is all the app sends about when something happened.

-- Usage counts, summed. One row per day, build, platform, and counter; a report adds to `total`
-- rather than inserting anything of its own. The counter is one of the fixed enum in
-- `src/shared/diagnostics.ts`, so a row can never be named after content.
CREATE TABLE diagnostic_counts (
  day TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  counter TEXT NOT NULL,
  total INTEGER NOT NULL,
  PRIMARY KEY (day, app_version, platform, counter)
);

-- Crashes, grouped. `fingerprint` is the SHA-256 of the error name, the top frames, and the app
-- version, so the same fault reported by many installs is one row with a count — the message is
-- already scrubbed by the app (`scrubMessage`) and the stack holds app-relative frames only
-- (`scrubStack`), never a path on someone's machine. `electron` is accepted on the wire but not
-- stored: the app version identifies the build.
CREATE TABLE diagnostic_crashes (
  fingerprint TEXT PRIMARY KEY,
  -- 'main' | 'renderer' | 'processGone'; never a native minidump.
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  message TEXT NOT NULL,
  -- The scrubbed frames, newline-separated, as they arrived.
  stack TEXT NOT NULL,
  app_version TEXT NOT NULL,
  platform TEXT NOT NULL,
  arch TEXT NOT NULL,
  count INTEGER NOT NULL,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);

-- The operator reads crashes newest first, and prunes by age.
CREATE INDEX diagnostic_crashes_last_seen ON diagnostic_crashes (last_seen);
