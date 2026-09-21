import { beforeEach, describe, expect, it } from 'vitest'
import { DIAGNOSTICS_BODY_MAX, type DiagnosticsBody } from '@shared/cloudApi'
import {
  CRASH_FRAME_MAX,
  CRASH_MESSAGE_MAX,
  CRASH_STACK_FRAMES,
  DIAGNOSTIC_QUEUE_MAX,
  type CrashReport
} from '@shared/diagnostics'
import type { FetchLike } from '../ai/providers/openai'
import { createDiagnosticsSend } from './diagnosticsClient'

const BASE = 'http://127.0.0.1:8787'

const ENVIRONMENT = {
  appVersion: '0.3.0',
  platform: 'linux',
  arch: 'arm64',
  electron: '44.3.0'
}

const body = (over: Partial<DiagnosticsBody> = {}): DiagnosticsBody => ({
  ...ENVIRONMENT,
  counts: [{ day: '2026-09-20', counter: 'app.launch', n: 2 }],
  crashes: [],
  ...over
})

/** A crash at its schema maximum: the largest one report may carry ten of. */
const bigCrash = (name: string): CrashReport => ({
  ...ENVIRONMENT,
  kind: 'main',
  name,
  message: 'x'.repeat(CRASH_MESSAGE_MAX),
  stack: Array.from({ length: CRASH_STACK_FRAMES }, (_, i) =>
    `out/main/${'deep/'.repeat(30)}index.js:${i}:1`.slice(0, CRASH_FRAME_MAX)
  )
})

interface Call {
  url: string
  init: RequestInit | undefined
}

let calls: Call[]
let answers: (Response | Error)[]

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url

const fetchFake: FetchLike = (input, init) => {
  calls.push({ url: urlOf(input), init })
  const next = answers.shift()
  if (next === undefined) throw new Error(`No fake answer left for ${urlOf(input)}`)
  return next instanceof Error ? Promise.reject(next) : Promise.resolve(next)
}

/** Never answers, but honours the abort the timeout raises. */
const hangingFetch: FetchLike = (_input, init) =>
  new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
  })

/** The exact bytes that were posted; the client always sends JSON as a string. */
const postedText = (call: Call | undefined): string => {
  const body = call?.init?.body
  if (typeof body !== 'string') throw new Error('Expected a JSON string body')
  return body
}

const sentBody = (call: Call | undefined): DiagnosticsBody =>
  JSON.parse(postedText(call)) as DiagnosticsBody

beforeEach(() => {
  calls = []
  answers = []
})

describe('createDiagnosticsSend (F-15.8)', () => {
  it('posts the report to /diagnostics with no credentials of any kind', async () => {
    answers = [new Response(null, { status: 204 })]
    const send = createDiagnosticsSend({ baseUrl: `${BASE}/`, fetch: fetchFake })

    await expect(send(body())).resolves.toBeUndefined()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(`${BASE}/diagnostics`)
    expect(calls[0]?.init?.method).toBe('POST')
    expect(calls[0]?.init?.headers).toEqual({ 'content-type': 'application/json' })
    expect(sentBody(calls[0])).toEqual(body())
  })

  it('refuses a body the shared schema does not accept, before anything leaves', async () => {
    const send = createDiagnosticsSend({ baseUrl: BASE, fetch: fetchFake })
    const invented = { counter: 'project.title', day: '2026-09-20', n: 1 }
    await expect(
      send({ ...body(), counts: [invented] } as unknown as DiagnosticsBody)
    ).rejects.toThrow()
    expect(calls).toEqual([])
  })

  it('fails on a refusal, so the service keeps what it tried to send', async () => {
    answers = [
      new Response(JSON.stringify({ code: 'BAD_REQUEST', message: 'no' }), { status: 400 })
    ]
    const send = createDiagnosticsSend({ baseUrl: BASE, fetch: fetchFake })
    await expect(send(body())).rejects.toThrow('answered 400')
  })

  it('fails when the endpoint cannot be reached', async () => {
    answers = [new Error('offline')]
    const send = createDiagnosticsSend({ baseUrl: BASE, fetch: fetchFake })
    await expect(send(body())).rejects.toThrow('Could not reach the diagnostics endpoint')
  })

  it('gives up rather than holding the request open forever', async () => {
    const send = createDiagnosticsSend({ baseUrl: BASE, fetch: hangingFetch, timeoutMs: 1 })
    await expect(send(body())).rejects.toThrow('did not answer in time')
  })

  it('trims an over-sized report to the cap: oldest counts first, then the later crashes', async () => {
    answers = [new Response(null, { status: 204 })]
    const counts = Array.from({ length: 50 }, (_, i) => ({
      day: `2026-08-${String(i + 1).padStart(2, '0')}`,
      counter: 'app.launch' as const,
      n: i + 1
    }))
    const crashes = Array.from({ length: DIAGNOSTIC_QUEUE_MAX }, (_, i) => bigCrash(`Error${i}`))
    const send = createDiagnosticsSend({ baseUrl: BASE, fetch: fetchFake })

    await send(body({ counts, crashes }))

    expect(Buffer.byteLength(postedText(calls[0]), 'utf8')).toBeLessThanOrEqual(
      DIAGNOSTICS_BODY_MAX
    )
    const sent = sentBody(calls[0])
    // The counts went first, and the crash that is usually the cause is the one kept.
    expect(sent.counts).toEqual([])
    expect(sent.crashes.length).toBeGreaterThan(0)
    expect(sent.crashes.length).toBeLessThan(DIAGNOSTIC_QUEUE_MAX)
    expect(sent.crashes[0]?.name).toBe('Error0')
  })

  it('leaves a report that already fits exactly as it was', async () => {
    answers = [new Response(null, { status: 204 })]
    const full = body({ crashes: [bigCrash('Error0')] })
    const send = createDiagnosticsSend({ baseUrl: BASE, fetch: fetchFake })

    await send(full)

    expect(sentBody(calls[0])).toEqual(full)
  })
})
