/**
 * `POST /api/sync`: the browser keeps every Desk document in IndexedDB and copies it here.
 * One call pushes the browser's unsent writes, then returns every change after the client's
 * cursor (its own pushes included). Last writer wins, per document.
 *
 * Body:   { since: number, push: [{ path, data: object | null }] }   (data null = deleted)
 * Answer: { cursor: number, more: boolean, changes: [{ path, data: object | null, rev }] }
 */
import { type Caller, fail, isRecord, json, readJson } from './http'

export const MAX_PUSH = 300
export const MAX_PULL = 500
/** The db contract's cap on one document body. */
export const MAX_DOC_BYTES = 256 * 1024
const MAX_BODY_BYTES = 24 * 1024 * 1024

export type PushItem = { path: string; data: Record<string, unknown> | null }

/** A document path: an even number of non-empty segments, nothing odd in them. */
export function validPath(path: unknown): path is string {
  if (typeof path !== 'string' || path.length === 0 || path.length > 512) return false
  const segs = path.split('/')
  return segs.length % 2 === 0 && segs.every((s) => s.length > 0 && s !== '.' && s !== '..' && !/[\s\\]/.test(s))
}

/** The checked push list, or an error message for the first bad item. */
export function parsePush(push: unknown): PushItem[] | string {
  if (push === undefined) return []
  if (!Array.isArray(push)) return 'push must be a list'
  if (push.length > MAX_PUSH) return `push at most ${MAX_PUSH} documents at a time`
  const out: PushItem[] = []
  for (const item of push) {
    if (!isRecord(item) || !validPath(item.path)) return 'each push item needs a document path'
    if (item.data !== null && !isRecord(item.data)) return `${item.path}: data must be an object or null`
    if (item.data !== null && JSON.stringify(item.data).length > MAX_DOC_BYTES) return `${item.path}: document is over 256 KiB`
    out.push({ path: item.path, data: item.data })
  }
  return out
}

export async function handleSync(request: Request, db: D1Database, who: Caller): Promise<Response> {
  const body = await readJson(request, MAX_BODY_BYTES)
  if (!isRecord(body)) return fail(400, 'invalid_argument', 'Send JSON: { since, push }.')
  const since = typeof body.since === 'number' && Number.isInteger(body.since) && body.since >= 0 ? body.since : 0
  const push = parsePush(body.push)
  if (typeof push === 'string') return fail(400, 'invalid_argument', push)

  const now = Date.now()
  if (push.length) {
    // D1 runs a batch as one transaction, statement by statement, so each subquery sees the
    // rev the previous statement wrote.
    const stmt = db.prepare(
      `INSERT INTO docs (user_id, path, data, deleted, rev, updated_at)
       VALUES (?1, ?2, ?3, ?4, (SELECT COALESCE(MAX(rev), 0) + 1 FROM docs WHERE user_id = ?1), ?5)
       ON CONFLICT (user_id, path) DO UPDATE SET
         data = excluded.data, deleted = excluded.deleted, rev = excluded.rev, updated_at = excluded.updated_at`
    )
    await db.batch(
      push.map((p) => stmt.bind(who.userId, p.path, p.data === null ? null : JSON.stringify(p.data), p.data === null ? 1 : 0, now))
    )
  }

  const rows = await db
    .prepare('SELECT path, data, deleted, rev FROM docs WHERE user_id = ?1 AND rev > ?2 ORDER BY rev LIMIT ?3')
    .bind(who.userId, since, MAX_PULL + 1)
    .all<{ path: string; data: string | null; deleted: number; rev: number }>()
  const list = rows.results ?? []
  const more = list.length > MAX_PULL
  const page = more ? list.slice(0, MAX_PULL) : list
  const changes = page.map((r) => ({
    path: r.path,
    rev: r.rev,
    data: r.deleted || r.data === null ? null : (JSON.parse(r.data) as Record<string, unknown>)
  }))
  const cursor = page.length ? page[page.length - 1]!.rev : since
  return json({ cursor, more, changes })
}
