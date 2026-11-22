-- Mythscribe web: Desk's documents, one row per document path per author, and the AI meter.

-- Every Desk document (books, chapters, codex, lore, prefs...) as the browser last pushed it.
-- `rev` is a per-author counter: a client asks for everything after the last rev it saw.
-- A deleted document keeps its row (deleted = 1, data NULL) so other devices learn of it.
CREATE TABLE docs (
  user_id TEXT NOT NULL,
  path TEXT NOT NULL,
  data TEXT,
  deleted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, path)
);
CREATE INDEX docs_by_rev ON docs (user_id, rev);

-- One row per Anthropic API call: tokens and cost in micro-USD, for the monthly cap.
CREATE TABLE ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL
);
CREATE INDEX ai_usage_by_month ON ai_usage (user_id, at);
