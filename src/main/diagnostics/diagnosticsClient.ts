import { DIAGNOSTICS_BODY_MAX, DiagnosticsBody } from '@shared/cloudApi'
import type { FetchLike } from '../ai/providers/openai'
import type { DiagnosticsSend } from './diagnosticsService'

/**
 * Where a diagnostics report goes (F-15.8): one `POST /diagnostics` on the MythScribe Cloud
 * Worker, with no `Authorization` header and no install id, so two reports from the same machine
 * cannot be told apart. The body is the shared schema, parsed here before it leaves, so nothing
 * outside the counter enum and the scrubbed crash fields can reach the wire even if app-state.json
 * was edited by hand.
 *
 * Nothing here is ever shown to the author: a failed report is the service's problem (it keeps
 * what it has and tries again later), never a dialog, so the failures are plain `Error`s rather
 * than the `AccountError` copy the Cloud routes carry.
 */

/** The route; the base URL comes from `cloudApiUrl(process.env)`, like every other Cloud call. */
const DIAGNOSTICS_PATH = '/diagnostics'

/** A report is background work, but it must not hold a socket open for the whole session. */
export const DIAGNOSTICS_REQUEST_TIMEOUT_MS = 15_000

export interface DiagnosticsClientOptions {
  /** The Cloud API root, from `cloudApiUrl(process.env)`; a trailing slash is tolerated. */
  baseUrl: string
  fetch: FetchLike
  timeoutMs?: number
}

/** Builds the `send` the `DiagnosticsService` flushes through. */
export function createDiagnosticsSend({
  baseUrl,
  fetch,
  timeoutMs = DIAGNOSTICS_REQUEST_TIMEOUT_MS
}: DiagnosticsClientOptions): DiagnosticsSend {
  const root = baseUrl.replace(/\/+$/, '')
  return async (body) => {
    const payload = fitToCap(DiagnosticsBody.parse(body))
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
    let response: Response
    try {
      response = await fetch(`${root}${DIAGNOSTICS_PATH}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
        signal: controller.signal
      })
    } catch (err) {
      const reason = timedOut
        ? 'The diagnostics endpoint did not answer in time'
        : 'Could not reach the diagnostics endpoint'
      throw new Error(reason, { cause: err })
    } finally {
      clearTimeout(timer)
    }
    // The answer is 204 with no body; reading it anyway releases the connection either way.
    await response.text().catch(() => '')
    if (!response.ok) {
      throw new Error(`The diagnostics endpoint answered ${response.status}`)
    }
  }
}

/**
 * The bytes to post, inside `DIAGNOSTICS_BODY_MAX` (the Worker refuses a longer body outright).
 * The oldest count rows go first, then all but the first crash — which is usually the cause of
 * the ones after it. What is dropped here is not sent later: the service treats the report it
 * handed over as gone, and losing the tail of one report beats never sending any of it.
 */
function fitToCap(body: DiagnosticsBody): string {
  let counts = body.counts
  let crashes = body.crashes
  let text = JSON.stringify({ ...body, counts, crashes })
  while (overCap(text) && counts.length > 0) {
    counts = counts.slice(1)
    text = JSON.stringify({ ...body, counts, crashes })
  }
  while (overCap(text) && crashes.length > 1) {
    crashes = crashes.slice(0, -1)
    text = JSON.stringify({ ...body, counts, crashes })
  }
  return text
}

/** One crash is capped well below `DIAGNOSTICS_BODY_MAX` by the shared schema, so this ends. */
function overCap(text: string): boolean {
  return Buffer.byteLength(text, 'utf8') > DIAGNOSTICS_BODY_MAX
}
