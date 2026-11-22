-- Reader links (week 2): an author shares Desk's reading page with one reader by a link.
-- The link's token is the room's key and the reader's only key, so it is long and random.
CREATE TABLE rooms (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  book_id TEXT NOT NULL,
  book TEXT NOT NULL,
  reader TEXT NOT NULL,
  file TEXT NOT NULL,
  parts INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX rooms_by_owner ON rooms (user_id, book_id);

-- The reading page Desk made, in pieces (a D1 value holds at most about 2 MB).
CREATE TABLE room_parts (
  token TEXT NOT NULL,
  n INTEGER NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (token, n)
);

-- The reader's notes, as the reading page last sent them (Desk's mythscribe-reader-notes list).
CREATE TABLE room_notes (
  token TEXT PRIMARY KEY,
  notes TEXT NOT NULL,
  count INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
