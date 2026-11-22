/** Small helpers shared by the routes. */

export type Caller = { userId: string }

/** A JSON answer with no caching. */
export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers }
  })
}

/** The error shape the browser shim reads: `{ code, message }`. */
export function fail(status: number, code: string, message: string): Response {
  return json({ code, message }, status)
}

/** Reads a JSON body no larger than `maxBytes`; null when it's too big or not JSON. */
export async function readJson(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (declared > maxBytes) return null
  const text = await request.text()
  if (text.length > maxBytes) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
