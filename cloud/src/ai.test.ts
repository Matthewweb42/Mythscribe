import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  AI_COMPLETE_MAX_CHARS,
  AI_COMPLETE_MAX_MESSAGES,
  AI_COMPLETE_MAX_TOKENS,
  AI_STREAM_CONTENT_TYPE,
  AiCompleteResult,
  AiStreamEvent,
  CloudApiError,
  type CloudErrorCode,
  SESSION_TTL_MS
} from '../../src/shared/cloudApi'
import { cloudChargeMicros } from '../../src/shared/cloudRates'
import type { AiDeps } from './ai'
import { sha256Hex } from './crypto'
import type { Mailer } from './email'
import { handleRequest } from './index'
import {
  type Upstream,
  type UpstreamAnswer,
  type UpstreamChunk,
  type UpstreamParams,
  UpstreamError
} from './openai'
import { type CreditEventRow, memoryStore, type Store } from './store'

/**
 * The AI proxy (F-15.4) through the real router: who may call it, what it refuses before
 * anything leaves, and that every answer — streamed or not — is charged exactly once at the
 * published rate. The provider is a fake `Upstream`, so no test touches a network.
 */

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const USER_ID = 'user-1'
const TOKEN = 'session-token'
const MODEL = 'gpt-5.4-mini'
const START = new Date('2026-09-19T12:00:00.000Z')
const ANSWER: UpstreamAnswer = {
  text: 'The storm broke at dusk.',
  model: MODEL,
  usage: { inputTokens: 100, outputTokens: 20 }
}

const silentMailer: Mailer = { send: () => Promise.resolve() }

let deps: AiDeps
let clock: number
let counter: number
let events: CreditEventRow[]
let seen: UpstreamParams[]
let logs: string[]

/** A fake provider: it records what it was asked for and answers what the test set up. */
function fakeUpstream(
  options: {
    answer?: UpstreamAnswer
    chunks?: UpstreamChunk[]
    fail?: UpstreamError
    failAfter?: number
  } = {}
): Upstream {
  return {
    complete(params) {
      seen.push(params)
      if (options.fail) return Promise.reject(options.fail)
      return Promise.resolve(options.answer ?? ANSWER)
    },
    async *stream(params) {
      seen.push(params)
      if (options.fail && options.failAfter === undefined) throw options.fail
      let sent = 0
      for (const chunk of options.chunks ?? []) {
        if (options.fail && sent === options.failAfter) throw options.fail
        yield chunk
        sent += 1
      }
      if (options.fail && sent === options.failAfter) throw options.fail
    }
  }
}

/** The memory store, with every credit event it applied kept for the assertions. */
function recordingStore(): Store {
  const base = memoryStore()
  return {
    ...base,
    applyCreditEvent: async (event) => {
      events.push(event)
      return base.applyCreditEvent(event)
    }
  }
}

function makeDeps(overrides: Partial<AiDeps> = {}): AiDeps {
  return {
    store: recordingStore(),
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => `id-${(counter += 1)}`,
    revealLink: false,
    packs: [],
    webhookSecret: null,
    upstream: fakeUpstream(),
    ...overrides
  }
}

async function signIn(): Promise<void> {
  await deps.store.insertUser({ id: USER_ID, email: EMAIL, createdAt: clock })
  await deps.store.insertSession({
    tokenHash: await sha256Hex(TOKEN),
    userId: USER_ID,
    createdAt: clock,
    expiresAt: clock + SESSION_TTL_MS,
    lastSeenAt: clock,
    revokedAt: null
  })
}

/** Put `micros` of credit on the account, the way a paid order does. */
async function credit(micros: number): Promise<void> {
  await deps.store.applyCreditEvent({
    id: `purchase-${micros}`,
    userId: USER_ID,
    kind: micros >= 0 ? 'purchase' : 'charge',
    amountMicros: micros,
    feature: null,
    model: null,
    tokensIn: null,
    tokensOut: null,
    orderRef: `seed:${micros}`,
    requestId: null,
    createdAt: clock
  })
  events.length = 0
}

interface CompleteOptions {
  token?: string | null
  body?: unknown
}

function completeRequest({ token = TOKEN, body }: CompleteOptions = {}): Request {
  return new Request(`${ORIGIN}/ai/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` })
    },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? validBody())
  })
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feature: 'chat',
    model: MODEL,
    messages: [{ role: 'user', content: 'Why is Mara on the ridge?' }],
    maxTokens: 200,
    stream: false,
    ...overrides
  }
}

async function errorOf(response: Response): Promise<CloudApiError> {
  return CloudApiError.parse(await response.json())
}

async function expectRefusal(response: Response, code: CloudErrorCode): Promise<void> {
  expect((await errorOf(response)).code).toBe(code)
  expect(seen).toHaveLength(0)
  expect(events).toHaveLength(0)
}

/** The NDJSON lines of a streamed answer, parsed as the events they must be. */
async function streamEvents(response: Response): Promise<AiStreamEvent[]> {
  const text = await response.text()
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => AiStreamEvent.parse(JSON.parse(line)))
}

beforeEach(async () => {
  clock = START.getTime()
  counter = 0
  events = []
  seen = []
  logs = []
  deps = makeDeps()
  // The one log line per answered request is part of the contract; the console is not.
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '))
  })
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    logs.push(args.map((arg) => String(arg)).join(' '))
  })
  await signIn()
  await credit(2_500_000)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('POST /ai/complete refusals', () => {
  it('refuses a call with no bearer', async () => {
    const response = await handleRequest(completeRequest({ token: null }), deps)
    expect(response.status).toBe(401)
    await expectRefusal(response, 'UNAUTHORIZED')
  })

  it('refuses a body it cannot read', async () => {
    const response = await handleRequest(completeRequest({ body: 'not json' }), deps)
    expect(response.status).toBe(400)
    await expectRefusal(response, 'BAD_REQUEST')
  })

  it('refuses a model outside the published rate table', async () => {
    const response = await handleRequest(
      completeRequest({ body: validBody({ model: 'gpt-unknown' }) }),
      deps
    )
    expect(response.status).toBe(400)
    expect(seen).toHaveLength(0)
    expect(events).toHaveLength(0)
    const failure = await errorOf(response)
    expect(failure.code).toBe('BAD_REQUEST')
    expect(failure.message).toContain('not available on MythScribe Cloud')
  })

  it('refuses a request over the output cap or the message count', async () => {
    const tooMany = await handleRequest(
      completeRequest({ body: validBody({ maxTokens: AI_COMPLETE_MAX_TOKENS + 1 }) }),
      deps
    )
    expect(tooMany.status).toBe(400)
    await expectRefusal(tooMany, 'BAD_REQUEST')
    const messages = Array.from({ length: AI_COMPLETE_MAX_MESSAGES + 1 }, () => ({
      role: 'user',
      content: 'x'
    }))
    const tooLong = await handleRequest(completeRequest({ body: validBody({ messages }) }), deps)
    expect(tooLong.status).toBe(400)
    await expectRefusal(tooLong, 'BAD_REQUEST')
  })

  it('refuses a request whose messages are longer than the character cap', async () => {
    const over = await handleRequest(
      completeRequest({
        body: validBody({
          messages: [{ role: 'user', content: 'x'.repeat(AI_COMPLETE_MAX_CHARS + 1) }]
        })
      }),
      deps
    )
    expect(over.status).toBe(400)
    await expectRefusal(over, 'BAD_REQUEST')
    const atCap = await handleRequest(
      completeRequest({
        body: validBody({
          messages: [{ role: 'user', content: 'x'.repeat(AI_COMPLETE_MAX_CHARS) }]
        })
      }),
      deps
    )
    expect(atCap.status).toBe(200)
  })

  it('answers 503 while no provider key is configured', async () => {
    deps = { ...deps, upstream: null }
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(503)
    await expectRefusal(response, 'NOT_CONFIGURED')
  })

  it('refuses at a zero and at a negative balance', async () => {
    await credit(-2_500_000)
    const empty = await handleRequest(completeRequest(), deps)
    expect(empty.status).toBe(402)
    await expectRefusal(empty, 'INSUFFICIENT_CREDITS')
    await credit(-10)
    const overdrawn = await handleRequest(completeRequest(), deps)
    expect(overdrawn.status).toBe(402)
    await expectRefusal(overdrawn, 'INSUFFICIENT_CREDITS')
  })
})

describe('POST /ai/complete, not streamed', () => {
  it('answers, charges the account once at the Cloud rate, and logs no content', async () => {
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(200)
    const result = AiCompleteResult.parse(await response.json())
    const expected = cloudChargeMicros(MODEL, 100, 20)
    expect(result).toEqual({
      text: ANSWER.text,
      model: MODEL,
      usage: { inputTokens: 100, outputTokens: 20 },
      chargeMicros: expected,
      balanceMicros: before - expected
    })
    expect(await deps.store.getBalance(USER_ID)).toBe(before - expected)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      kind: 'charge',
      feature: 'chat',
      model: MODEL,
      tokensIn: 100,
      tokensOut: 20,
      amountMicros: -expected,
      requestId: 'id-1'
    })
    expect(logs).toEqual([
      `ai id-1 user=${USER_ID} feature=chat model=${MODEL} in=100 out=20 charge=${expected} status=ok`
    ])
    expect(logs.join(' ')).not.toContain('Mara')
  })

  it('forwards the caps, JSON mode, and the temperature to the provider', async () => {
    await handleRequest(
      completeRequest({ body: validBody({ json: true, temperature: 0.7, maxTokens: 60 }) }),
      deps
    )
    expect(seen).toEqual([
      {
        model: MODEL,
        messages: [{ role: 'user', content: 'Why is Mara on the ridge?' }],
        maxTokens: 60,
        json: true,
        temperature: 0.7
      }
    ])
  })

  it('charges the requested model when the provider answers with a snapshot id it cannot price', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({ answer: { ...ANSWER, model: 'gpt-5.4-mini-2026-09-01' } })
    }
    const response = await handleRequest(completeRequest(), deps)
    const result = AiCompleteResult.parse(await response.json())
    expect(result.model).toBe(MODEL)
    expect(result.chargeMicros).toBe(cloudChargeMicros(MODEL, 100, 20))
  })

  it('answers 429 for a rate-limited provider and charges nothing', async () => {
    deps = { ...deps, upstream: fakeUpstream({ fail: new UpstreamError(429, 'rate_limit') }) }
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(429)
    expect((await errorOf(response)).code).toBe('RATE_LIMITED')
    expect(events).toHaveLength(0)
    expect(await deps.store.getBalance(USER_ID)).toBe(before)
  })

  it('answers 502 for any other provider failure, without echoing the request', async () => {
    deps = { ...deps, upstream: fakeUpstream({ fail: new UpstreamError(500, 'other') }) }
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(502)
    const failure = await errorOf(response)
    expect(failure.code).toBe('UPSTREAM')
    expect(failure.message).not.toContain('Mara')
    expect(events).toHaveLength(0)
  })
})

describe('POST /ai/complete, streamed', () => {
  it('streams the deltas, then one done event carrying the charge', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({
        chunks: [
          { delta: 'The storm ' },
          { delta: 'broke at dusk.' },
          { usage: { inputTokens: 100, outputTokens: 20 }, model: MODEL }
        ]
      })
    }
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(AI_STREAM_CONTENT_TYPE)
    // The router's no-store wrapper must not break a streamed body.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const expected = cloudChargeMicros(MODEL, 100, 20)
    expect(await streamEvents(response)).toEqual([
      { type: 'delta', delta: 'The storm ' },
      { type: 'delta', delta: 'broke at dusk.' },
      {
        type: 'done',
        model: MODEL,
        usage: { inputTokens: 100, outputTokens: 20 },
        chargeMicros: expected,
        balanceMicros: before - expected
      }
    ])
    expect(events).toHaveLength(1)
    expect(await deps.store.getBalance(USER_ID)).toBe(before - expected)
  })

  it('still closes with a done event and the 1-micro minimum when the provider sends no usage chunk', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({ chunks: [{ delta: 'The storm broke.' }] })
    }
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(await streamEvents(response)).toEqual([
      { type: 'delta', delta: 'The storm broke.' },
      {
        type: 'done',
        model: MODEL,
        usage: { inputTokens: 0, outputTokens: 0 },
        chargeMicros: 1,
        balanceMicros: before - 1
      }
    ])
    expect(events).toHaveLength(1)
    expect(await deps.store.getBalance(USER_ID)).toBe(before - 1)
  })

  it('ends a provider failure mid-stream as an error event and charges nothing', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({
        chunks: [{ delta: 'The storm ' }],
        fail: new UpstreamError(500, 'other'),
        failAfter: 1
      })
    }
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(200)
    const streamed = await streamEvents(response)
    expect(streamed[0]).toEqual({ type: 'delta', delta: 'The storm ' })
    expect(streamed[1]).toMatchObject({ type: 'error', code: 'UPSTREAM' })
    expect(events).toHaveLength(0)
    expect(await deps.store.getBalance(USER_ID)).toBe(before)
  })

  it('refuses a streamed request with no credit before any byte is written', async () => {
    await credit(-2_500_000)
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(402)
    await expectRefusal(response, 'INSUFFICIENT_CREDITS')
  })

  it('ends a metering failure as one INTERNAL error event, charges nothing, and logs no content', async () => {
    deps = {
      ...deps,
      store: {
        ...deps.store,
        applyCreditEvent: () => Promise.reject(new Error('D1_ERROR: database is locked'))
      },
      upstream: fakeUpstream({
        chunks: [
          { delta: 'The storm broke.' },
          { usage: { inputTokens: 100, outputTokens: 20 }, model: MODEL }
        ]
      })
    }
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(200)
    const streamed = await streamEvents(response)
    expect(streamed).toHaveLength(2)
    expect(streamed[0]).toEqual({ type: 'delta', delta: 'The storm broke.' })
    expect(streamed[1]).toMatchObject({ type: 'error', code: 'INTERNAL' })
    expect(await deps.store.getBalance(USER_ID)).toBe(before)
    expect(logs.some((line) => line.includes('failed after the provider answered'))).toBe(true)
    expect(logs.join('\n')).not.toContain('The storm broke.')
  })

  it('aborts the provider and charges nothing when the app stops reading', async () => {
    let aborted = false
    const upstream: Upstream = {
      complete: () => Promise.reject(new Error('not used')),
      async *stream(params, signal) {
        seen.push(params)
        yield { delta: 'The storm ' }
        if (!signal?.aborted) {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true })
          })
        }
        aborted = true
        throw new UpstreamError(null, 'network')
      }
    }
    deps = { ...deps, upstream }
    const before = await deps.store.getBalance(USER_ID)
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    // The generated Worker types declare `Response.body` as `ReadableStream<any>`; name the
    // two calls this test makes so the chunk stays typed (like `ByteStream` in openai.ts).
    const body: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>
        cancel(): Promise<void>
      }
    } | null = response.body
    if (!body) throw new Error('expected a streamed body')
    const reader = body.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('"delta":"The storm "')
    await reader.cancel()
    await vi.waitFor(() => expect(aborted).toBe(true))
    expect(events).toHaveLength(0)
    expect(await deps.store.getBalance(USER_ID)).toBe(before)
  })
})
