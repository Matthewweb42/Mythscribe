/**
 * Reader links. Desk already makes a reading page for one reader (Send to a reader) and brings a
 * reader's notes into Review (Bring in notes). On the web the page is kept here and opened by a
 * link, and the reader's notes come back here instead of as a file.
 *
 * Author (signed in):
 *   POST /api/rooms                  { bookId, book, reader, file, html }  ->  { token }
 *   GET  /api/rooms?book=<bookId>    ->  { rooms: [{ token, reader, book, file, createdAt, closed, count, updatedAt }] }
 *   GET  /api/rooms/<token>/notes    ->  Desk's notes file: { kind: "mythscribe-reader-notes", reader, file, notes }
 *   POST /api/rooms/<token>/close    ->  the link stops working
 * Reader (the link is the key; no account):
 *   GET  /r/<token>                  ->  the reading page, sandboxed so it can't reach the author's session
 *   GET  /api/r/<token>/notes        ->  { notes }
 *   PUT  /api/r/<token>/notes        { notes }  ->  { count }
 */
import { type Caller, fail, isRecord, json } from './http'

/** One piece of the stored page; D1 caps a value at about 2 MB. */
const PART_CHARS = 900_000
export const MAX_PAGE_CHARS = 30_000_000
export const MAX_NOTES = 2000
const MAX_NOTES_BYTES = 2_000_000
const MAX_ROOMS_PER_BOOK = 200

export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(24))
  return btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const validToken = (t: string): boolean => /^[A-Za-z0-9_-]{32}$/.test(t)

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.slice(0, max) : '')

/** A reader's notes, checked and cut to the sizes Desk's importer keeps. */
export function cleanNotes(list: unknown): Record<string, unknown>[] | string {
  if (!Array.isArray(list)) return 'notes must be a list'
  if (list.length > MAX_NOTES) return `at most ${MAX_NOTES} notes`
  const out: Record<string, unknown>[] = []
  for (const n of list) {
    if (!isRecord(n)) return 'each note must be an object'
    out.push({
      i: typeof n.i === 'number' && Number.isInteger(n.i) ? n.i : null,
      lid: str(n.lid, 80),
      id: str(n.id, 80),
      scope: n.scope === 'chapter' || n.scope === 'book' ? n.scope : 'scene',
      quote: str(n.quote, 1200),
      text: str(n.text, 4000),
      kind: str(n.kind, 24) || 'other',
      chTitle: str(n.chTitle, 200),
      at: typeof n.at === 'number' && Number.isFinite(n.at) ? n.at : 0
    })
  }
  return out
}

async function ownRoom(db: D1Database, who: Caller, token: string) {
  if (!validToken(token)) return null
  return db
    .prepare('SELECT token, book, reader, file, closed FROM rooms WHERE token = ?1 AND user_id = ?2')
    .bind(token, who.userId)
    .first<{ token: string; book: string; reader: string; file: string; closed: number }>()
}

/** A JSON body: `too_big` past `maxBytes`, null when it isn't JSON. */
async function readBody(request: Request, maxBytes: number): Promise<unknown> {
  if (Number(request.headers.get('content-length') ?? '0') > maxBytes) return TOO_BIG
  const text = await request.text()
  if (text.length > maxBytes) return TOO_BIG
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}
const TOO_BIG = Symbol('too_big')

/** /api/rooms*, for the signed-in author. */
export async function handleRooms(request: Request, db: D1Database, who: Caller, rest: string): Promise<Response> {
  const url = new URL(request.url)
  if (rest === '' && request.method === 'POST') {
    const body = await readBody(request, MAX_PAGE_CHARS + 100_000)
    if (body === TOO_BIG) return fail(413, 'too_large', 'That reading page is too big for a link. Send fewer chapters.')
    if (!isRecord(body)) return fail(400, 'invalid_argument', 'Send JSON: { bookId, book, reader, file, html }.')
    const html = typeof body.html === 'string' ? body.html : ''
    const bookId = str(body.bookId, 80), reader = str(body.reader, 60).trim()
    if (!html.startsWith('<!doctype html>') || !bookId || !reader) return fail(400, 'invalid_argument', 'The reading page, the book and the reader are needed.')
    if (html.length > MAX_PAGE_CHARS) return fail(413, 'too_large', 'That reading page is too big for a link. Send fewer chapters.')
    const have = await db.prepare('SELECT COUNT(*) AS n FROM rooms WHERE user_id = ?1 AND book_id = ?2').bind(who.userId, bookId).first<{ n: number }>()
    if ((have?.n ?? 0) >= MAX_ROOMS_PER_BOOK) return fail(429, 'rate_limited', 'This book has too many reader links. Stop some first.')
    const token = newToken()
    const parts: string[] = []
    for (let i = 0; i < html.length; i += PART_CHARS) parts.push(html.slice(i, i + PART_CHARS))
    const now = Date.now()
    await db.batch([
      db
        .prepare('INSERT INTO rooms (token, user_id, book_id, book, reader, file, parts, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(token, who.userId, bookId, str(body.book, 200) || 'Manuscript', reader, str(body.file, 40), parts.length, now),
      ...parts.map((p, n) => db.prepare('INSERT INTO room_parts (token, n, data) VALUES (?1, ?2, ?3)').bind(token, n, p))
    ])
    return json({ token })
  }
  if (rest === '' && request.method === 'GET') {
    const bookId = url.searchParams.get('book') ?? ''
    const rows = await db
      .prepare(
        `SELECT r.token, r.reader, r.book, r.file, r.created_at, r.closed, COALESCE(n.count, 0) AS count, n.updated_at
         FROM rooms r LEFT JOIN room_notes n ON n.token = r.token
         WHERE r.user_id = ?1 AND (?2 = '' OR r.book_id = ?2) ORDER BY r.created_at DESC LIMIT 500`
      )
      .bind(who.userId, bookId)
      .all<{ token: string; reader: string; book: string; file: string; created_at: number; closed: number; count: number; updated_at: number | null }>()
    return json({
      rooms: (rows.results ?? []).map((r) => ({
        token: r.token, reader: r.reader, book: r.book, file: r.file, createdAt: r.created_at, closed: Boolean(r.closed), count: r.count, updatedAt: r.updated_at ?? null
      }))
    })
  }
  const m = /^\/([A-Za-z0-9_-]+)\/(notes|close)$/.exec(rest)
  if (!m) return fail(404, 'not_found', 'No such route.')
  const room = await ownRoom(db, who, m[1]!)
  if (!room) return fail(404, 'not_found', 'No such reader link.')
  if (m[2] === 'notes' && request.method === 'GET') {
    const row = await db.prepare('SELECT notes, updated_at FROM room_notes WHERE token = ?1').bind(room.token).first<{ notes: string; updated_at: number }>()
    return json({ kind: 'mythscribe-reader-notes', v: 1, file: room.file, book: room.book, reader: room.reader, saved: row?.updated_at ?? null, notes: row ? (JSON.parse(row.notes) as unknown) : [] })
  }
  if (m[2] === 'close' && request.method === 'POST') {
    await db.prepare('UPDATE rooms SET closed = 1 WHERE token = ?1').bind(room.token).run()
    return json({ closed: true })
  }
  return fail(404, 'not_found', 'No such route.')
}

/** The reader's side. CORS is open because the sandboxed page has no origin of its own; the token is the key. */
const READER_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, PUT, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400'
}
const withCors = (r: Response): Response => {
  const h = new Headers(r.headers)
  for (const [k, v] of Object.entries(READER_CORS)) h.set(k, v)
  return new Response(r.body, { status: r.status, headers: h })
}

async function openRoom(db: D1Database, token: string) {
  if (!validToken(token)) return null
  return db.prepare('SELECT token, parts FROM rooms WHERE token = ?1 AND closed = 0').bind(token).first<{ token: string; parts: number }>()
}

/** `GET /r/<token>`: the reading page, in a sandbox (no same-origin), so its script can't read this site's storage. */
export async function serveRoomPage(request: Request, db: D1Database, token: string): Promise<Response> {
  const room = await openRoom(db, token)
  const headers: Record<string, string> = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'x-robots-tag': 'noindex'
  }
  if (!room) return new Response('<!doctype html><meta charset=utf-8><title>Link not found</title><p style="font:16px system-ui;margin:2em">This reading link isn’t working. Ask the author for a new one.', { status: 404, headers })
  const rows = await db.prepare('SELECT data FROM room_parts WHERE token = ?1 ORDER BY n').bind(room.token).all<{ data: string }>()
  const origin = new URL(request.url).origin
  headers['content-security-policy'] =
    `sandbox allow-scripts allow-modals allow-downloads; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src ${origin}; base-uri 'none'; form-action 'none'`
  return new Response((rows.results ?? []).map((r) => r.data).join(''), { headers })
}

/** `/api/r/<token>/notes`: the reader's notes, read and saved by the reading page. */
export async function handleReaderNotes(request: Request, db: D1Database, token: string): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: READER_CORS })
  const room = await openRoom(db, token)
  if (!room) return withCors(fail(404, 'not_found', 'This reading link isn’t working.'))
  if (request.method === 'GET') {
    const row = await db.prepare('SELECT notes FROM room_notes WHERE token = ?1').bind(room.token).first<{ notes: string }>()
    return withCors(json({ notes: row ? (JSON.parse(row.notes) as unknown) : [] }))
  }
  if (request.method === 'PUT') {
    const body = await readBody(request, MAX_NOTES_BYTES)
    if (body === TOO_BIG) return withCors(fail(413, 'too_large', 'Too many notes at once.'))
    if (!isRecord(body)) return withCors(fail(400, 'invalid_argument', 'Send JSON: { notes }.'))
    const notes = cleanNotes(body.notes)
    if (typeof notes === 'string') return withCors(fail(400, 'invalid_argument', notes))
    const text = JSON.stringify(notes)
    if (text.length > MAX_NOTES_BYTES) return withCors(fail(413, 'too_large', 'Too many notes at once.'))
    await db
      .prepare(
        `INSERT INTO room_notes (token, notes, count, updated_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (token) DO UPDATE SET notes = excluded.notes, count = excluded.count, updated_at = excluded.updated_at`
      )
      .bind(room.token, text, notes.length, Date.now())
      .run()
    return withCors(json({ count: notes.length }))
  }
  return withCors(fail(405, 'invalid_argument', 'Use GET or PUT.'))
}
