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
  CreditsResult,
  SESSION_TTL_MS
} from '../../src/shared/cloudApi'
import { sha256Hex } from './crypto'
import type { Mailer } from './email'
import { handleRequest, runScheduledSweep, type WorkerDeps } from './index'
import {
  type FetchLike,
  openRouterUpstream,
  type Upstream,
  type UpstreamAnswer,
  type UpstreamChunk,
  type UpstreamParams,
  UpstreamError
} from './openai'
import { plainEntry } from './store'
import { testStore, type TestStore } from './testing/sqliteD1'

/**
 * The hosted AI proxy (F-15.4, AI-BILLING-SPEC A6, L5-L8, P2-P6, S3, S4) through the real router
 * and the real SQL: what it refuses before anything leaves, the hold it places, and that every
 * answer — streamed or not — is charged exactly once at cost + markup, never above its hold. The
 * gateway is a fake `Upstream`, so no test touches a network. The spec's acceptance checks that
 * concern the server are named as such.
 */

const ORIGIN = 'https://api.mythscribe.app'
const EMAIL = 'author@example.com'
const USER_ID = 'user-1'
const TOKEN = 'session-token'
const MODEL = 'openai/gpt-5.4-mini'
const START = new Date('2026-10-07T12:00:00.000Z')
const MINUTE = 60_000
const QUESTION = 'Why is Mara on the ridge?'
const ANSWER: UpstreamAnswer = {
  text: 'The storm broke at dusk.',
  model: MODEL,
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }
}
/**
 * GPT-5.4 mini at $0.75 in / $4.50 out per million: 100 in + 20 out cost 75 + 90 = 165 micro-USD;
 * plus 20 % that is 198 (P2, P3).
 */
const COST = 165
const CHARGE = 198
/**
 * The hold for `validBody()` (P4): the question is 25 bytes, so at most 25 + 16 + 16 = 57 input
 * tokens, and the answer at most 200: ceil((57 × 0.75 + 200 × 4.5) × 1.2) = 1132 micro-USD.
 */
const HOLD = 1132

const silentMailer: Mailer = { send: () => Promise.resolve() }

let deps: WorkerDeps
let store: TestStore
let clock: number
let counter: number
let seen: UpstreamParams[]
let logs: string[]

/** A fake gateway: it records what it was asked for and answers what the test set up. */
function fakeUpstream(
  options: {
    answer?: UpstreamAnswer
    chunks?: UpstreamChunk[]
    fail?: UpstreamError
    failAfter?: number
    /** Hold the answer until the test resolves it, to keep a request in flight. */
    gate?: Promise<void>
  } = {}
): Upstream {
  return {
    async complete(params) {
      seen.push(params)
      if (options.gate) await options.gate
      if (options.fail) throw options.fail
      return options.answer ?? ANSWER
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

/** A promise the test resolves by hand. */
function gate(): { promise: Promise<void>; open: () => void } {
  let open = (): void => undefined
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

function makeDeps(overrides: Partial<WorkerDeps> = {}): WorkerDeps {
  return {
    store,
    mailer: silentMailer,
    now: () => new Date(clock),
    random: () => `id-${(counter += 1)}`,
    revealLink: false,
    packs: [],
    supporter: null,
    appLicense: null,
    starter: null,
    lemonSqueezy: null,
    webhookSecret: null,
    upstream: fakeUpstream(),
    signingKey: null,
    ...overrides
  }
}

async function signIn(): Promise<void> {
  await store.insertUser({ id: USER_ID, email: EMAIL, createdAt: clock })
  await store.insertSession({
    tokenHash: await sha256Hex(TOKEN),
    userId: USER_ID,
    createdAt: clock,
    expiresAt: clock + SESSION_TTL_MS,
    lastSeenAt: clock,
    revokedAt: null
  })
}

let topups = 0

/** Put `micros` on the account, the way a paid order does. */
async function topUp(micros: number): Promise<void> {
  topups += 1
  await store.appendLedgerEntry(
    plainEntry({
      id: `topup-${topups}`,
      userId: USER_ID,
      type: micros >= 0 ? 'topup' : 'adjustment',
      amountMicros: micros,
      idempotencyKey: `seed:${topups}`,
      createdAt: clock
    })
  )
}

/** What can be spent now. */
async function available(): Promise<number> {
  const balance = await store.getBalance(USER_ID, clock)
  return balance.ledgerMicros - balance.heldMicros
}

async function charges(): Promise<{ amountMicros: number; requestId: string | null }[]> {
  return (await store.ledger()).filter((row) => row.type === 'charge')
}

interface CompleteOptions {
  token?: string | null
  body?: unknown
  key?: string
}

function completeRequest({ token = TOKEN, body, key }: CompleteOptions = {}): Request {
  return new Request(`${ORIGIN}/ai/complete`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...(key === undefined ? {} : { 'Idempotency-Key': key })
    },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? validBody())
  })
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    feature: 'chat',
    model: MODEL,
    messages: [{ role: 'user', content: QUESTION }],
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
  expect(await charges()).toHaveLength(0)
  expect(await store.holds()).toHaveLength(0)
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
  topups = 0
  seen = []
  logs = []
  store = testStore()
  // The hand-computed figures above are at cost + 20 %; the default markup is 25 % since
  // 2026-10-08, and what that default is belongs to `credits.test.ts` (`GET /pricing`).
  store.setConfig('markup', 0.2)
  deps = makeDeps()
  // The one log line per request is part of the contract; the console is not.
  for (const method of ['log', 'warn', 'error'] as const) {
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      logs.push(args.map((arg) => String(arg)).join(' '))
    })
  }
  await signIn()
  await topUp(2_500_000)
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

  it('refuses a body it cannot read, and a malformed Idempotency-Key', async () => {
    const response = await handleRequest(completeRequest({ body: 'not json' }), deps)
    expect(response.status).toBe(400)
    await expectRefusal(response, 'BAD_REQUEST')
    const badKey = await handleRequest(completeRequest({ key: 'no spaces allowed' }), deps)
    expect(badKey.status).toBe(400)
    await expectRefusal(badKey, 'BAD_REQUEST')
  })

  it('refuses a model outside the price table as MODEL_UNAVAILABLE', async () => {
    const response = await handleRequest(
      completeRequest({ body: validBody({ model: 'made/up-model' }) }),
      deps
    )
    expect(response.status).toBe(422)
    await expectRefusal(response, 'MODEL_UNAVAILABLE')
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

  it('refuses messages over the input cap as REQUEST_TOO_LARGE (S4)', async () => {
    const over = await handleRequest(
      completeRequest({
        body: validBody({
          messages: [{ role: 'user', content: 'x'.repeat(AI_COMPLETE_MAX_CHARS + 1) }]
        })
      }),
      deps
    )
    expect(over.status).toBe(413)
    await expectRefusal(over, 'REQUEST_TOO_LARGE')
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

  it('takes the input cap from the config', async () => {
    store.setConfig('max_input_chars', 10)
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(413)
    await expectRefusal(response, 'REQUEST_TOO_LARGE')
  })

  it('answers 503 while no gateway key is configured', async () => {
    deps = { ...deps, upstream: null }
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(503)
    await expectRefusal(response, 'NOT_CONFIGURED')
  })

  it('limits requests per account per minute (S4)', async () => {
    store.setConfig('requests_per_minute', 2)
    expect((await handleRequest(completeRequest(), deps)).status).toBe(200)
    expect((await handleRequest(completeRequest(), deps)).status).toBe(200)
    const third = await handleRequest(completeRequest(), deps)
    expect(third.status).toBe(429)
    expect((await errorOf(third)).code).toBe('RATE_LIMITED')
    expect(seen).toHaveLength(2)

    clock += MINUTE
    expect((await handleRequest(completeRequest(), deps)).status).toBe(200)
  })

  it('refuses at a zero balance and at one short of the hold, forwarding nothing', async () => {
    await topUp(-2_500_000)
    const empty = await handleRequest(completeRequest(), deps)
    expect(empty.status).toBe(402)
    await expectRefusal(empty, 'INSUFFICIENT_CREDITS')

    await topUp(HOLD - 1)
    const short = await handleRequest(completeRequest(), deps)
    expect(short.status).toBe(402)
    await expectRefusal(short, 'INSUFFICIENT_CREDITS')

    await topUp(1)
    expect((await handleRequest(completeRequest(), deps)).status).toBe(200)
  })
})

describe('POST /ai/complete, not streamed', () => {
  it('answers, charges once at cost + 20 %, settles the hold, and logs no content', async () => {
    const before = await available()
    const response = await handleRequest(completeRequest(), deps)
    expect(response.status).toBe(200)
    const result = AiCompleteResult.parse(await response.json())
    expect(result).toEqual({
      text: ANSWER.text,
      model: MODEL,
      usage: ANSWER.usage,
      chargeMicros: CHARGE,
      balanceMicros: before - CHARGE,
      requestId: 'id-1'
    })
    expect(await available()).toBe(before - CHARGE)

    expect(await charges()).toEqual([
      expect.objectContaining({
        type: 'charge',
        amountMicros: -CHARGE,
        idempotencyKey: 'charge:id-1',
        requestId: 'id-1',
        feature: 'chat',
        model: MODEL,
        tokensIn: 100,
        tokensOut: 20,
        tokensCached: 0,
        providerCostMicros: COST,
        markupBps: 2000
      })
    ])
    expect(await store.holds()).toEqual([
      expect.objectContaining({ status: 'settled', amountMicros: HOLD, chargeMicros: CHARGE })
    ])
    expect(logs).toEqual([
      `ai id-1 user=${USER_ID} feature=chat model=${MODEL} in=100 out=20 cached=0 ` +
        `cost=${COST} charge=${CHARGE} hold=${HOLD} status=ok ms=0`
    ])
  })

  it('bills cached input at the cached price (R6)', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({
        answer: {
          ...ANSWER,
          usage: { inputTokens: 1000, outputTokens: 100, cachedInputTokens: 800 }
        }
      })
    }
    // 200 × 0.75 + 800 × 0.075 + 100 × 4.5 = 150 + 60 + 450 = 660; plus 20 % = 792.
    const result = AiCompleteResult.parse(
      await (await handleRequest(completeRequest(), deps)).json()
    )
    expect(result.chargeMicros).toBe(792)
    expect(await charges()).toEqual([
      expect.objectContaining({ providerCostMicros: 660, tokensCached: 800 })
    ])
  })

  it('takes the markup from the config', async () => {
    store.setConfig('markup', 0.5)
    const result = AiCompleteResult.parse(
      await (await handleRequest(completeRequest(), deps)).json()
    )
    // ceil(165 × 1.5) = 248.
    expect(result.chargeMicros).toBe(248)
  })

  it('accepts the bare model name an older app sends and bills the price table id', async () => {
    const response = await handleRequest(
      completeRequest({ body: validBody({ model: 'gpt-5.4-mini' }) }),
      deps
    )
    const result = AiCompleteResult.parse(await response.json())
    expect(result.model).toBe(MODEL)
    expect(seen[0]?.model).toBe(MODEL)
  })

  it('forwards the caps, JSON mode, and the temperature to the gateway', async () => {
    await handleRequest(
      completeRequest({ body: validBody({ json: true, temperature: 0.7, maxTokens: 60 }) }),
      deps
    )
    expect(seen).toEqual([
      {
        model: MODEL,
        messages: [{ role: 'user', content: QUESTION }],
        maxTokens: 60,
        json: true,
        temperature: 0.7
      }
    ])
  })

  it('bills the requested model when the gateway answers with a snapshot id', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({ answer: { ...ANSWER, model: `${MODEL}-2026-09-01` } })
    }
    const result = AiCompleteResult.parse(
      await (await handleRequest(completeRequest(), deps)).json()
    )
    expect(result.model).toBe(MODEL)
    expect(result.chargeMicros).toBe(CHARGE)
  })

  it.each([
    [new UpstreamError(429, 'rate_limit'), 429, 'RATE_LIMITED'],
    [new UpstreamError(404, 'model_unavailable'), 422, 'MODEL_UNAVAILABLE'],
    [new UpstreamError(500, 'other'), 502, 'UPSTREAM']
  ] as const)(
    'leaves the balance unchanged once a failed upstream releases its hold (acceptance check): %s',
    async (fail, status, code) => {
      deps = { ...deps, upstream: fakeUpstream({ fail }) }
      const before = await available()
      const response = await handleRequest(completeRequest(), deps)
      expect(response.status).toBe(status)
      const failure = await errorOf(response)
      expect(failure.code).toBe(code)
      expect(failure.message).not.toContain('Mara')
      expect(await charges()).toHaveLength(0)
      expect(await store.holds()).toEqual([expect.objectContaining({ status: 'released' })])
      expect(await available()).toBe(before)
    }
  )
})

describe('the spec acceptance checks on the proxy', () => {
  it('lets exactly one of two simultaneous requests succeed when the balance covers one', async () => {
    await topUp(-2_500_000)
    await topUp(HOLD + 500)
    const held = gate()
    deps = { ...deps, upstream: fakeUpstream({ gate: held.promise }) }

    const first = handleRequest(completeRequest(), deps)
    const second = handleRequest(completeRequest(), deps)
    // Both are in flight before either answer is released.
    await vi.waitFor(() => expect(seen.length).toBeGreaterThanOrEqual(1))
    held.open()
    const statuses = (await Promise.all([first, second])).map((response) => response.status)

    expect(statuses.sort()).toEqual([200, 402])
    expect(seen).toHaveLength(1)
    expect(await charges()).toHaveLength(1)
    expect(await available()).toBe(HOLD + 500 - CHARGE)
  })

  it('charges a request retried with the same Idempotency-Key once', async () => {
    const key = 'job-7:chunk-3'
    const first = await handleRequest(completeRequest({ key }), deps)
    expect(first.status).toBe(200)

    const retry = await handleRequest(completeRequest({ key }), deps)
    expect(retry.status).toBe(409)
    const failure = await errorOf(retry)
    expect(failure.code).toBe('DUPLICATE_REQUEST')
    expect(failure.message).toContain('already answered')

    expect(seen).toHaveLength(1)
    expect(await charges()).toHaveLength(1)
    expect(await available()).toBe(2_500_000 - CHARGE)
  })

  it('refuses a retry while the first attempt with that key is still running', async () => {
    const held = gate()
    deps = { ...deps, upstream: fakeUpstream({ gate: held.promise }) }
    const first = handleRequest(completeRequest({ key: 'job-7:chunk-4' }), deps)
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    const retry = await handleRequest(completeRequest({ key: 'job-7:chunk-4' }), deps)
    expect(retry.status).toBe(409)
    expect((await errorOf(retry)).message).toContain('still running')

    held.open()
    expect((await first).status).toBe(200)
    expect(await charges()).toHaveLength(1)
  })

  it('runs a key again after its first attempt failed and was not charged', async () => {
    deps = { ...deps, upstream: fakeUpstream({ fail: new UpstreamError(500, 'other') }) }
    expect((await handleRequest(completeRequest({ key: 'job-8:chunk-1' }), deps)).status).toBe(502)

    deps = { ...deps, upstream: fakeUpstream() }
    expect((await handleRequest(completeRequest({ key: 'job-8:chunk-1' }), deps)).status).toBe(200)
    expect((await handleRequest(completeRequest({ key: 'job-8:chunk-1' }), deps)).status).toBe(409)
    expect(await charges()).toHaveLength(1)
    expect(await store.holds()).toHaveLength(1)
  })

  it('never charges more than the hold, even when the gateway over-reports', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({
        answer: {
          ...ANSWER,
          usage: { inputTokens: 5_000, outputTokens: 9_000, cachedInputTokens: 0 }
        }
      })
    }
    const result = AiCompleteResult.parse(
      await (await handleRequest(completeRequest(), deps)).json()
    )
    expect(result.chargeMicros).toBe(HOLD)
    expect(logs.some((line) => line.includes('charge clamped to the hold'))).toBe(true)
  })

  it('keeps the ledger sum equal to the displayed balance plus active holds', async () => {
    const held = gate()
    deps = { ...deps, upstream: fakeUpstream({ gate: held.promise }) }
    const pending = handleRequest(completeRequest(), deps)
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    const ledgerSum = async (): Promise<number> =>
      (await store.ledger()).reduce((sum, row) => sum + row.amountMicros, 0)
    const shown = async (): Promise<CreditsResult> =>
      CreditsResult.parse(
        await (
          await handleRequest(
            new Request(`${ORIGIN}/credits`, { headers: { Authorization: `Bearer ${TOKEN}` } }),
            deps
          )
        ).json()
      )

    const during = await shown()
    expect(during.heldMicros).toBe(HOLD)
    expect(during.balanceMicros + (during.heldMicros ?? 0)).toBe(await ledgerSum())

    held.open()
    await pending
    const after = await shown()
    expect(after.heldMicros).toBe(0)
    expect(after.balanceMicros + (after.heldMicros ?? 0)).toBe(await ledgerSum())
  })

  it('charges a request at the prices it was held at, not a price changed mid-flight (P6)', async () => {
    const held = gate()
    deps = { ...deps, upstream: fakeUpstream({ gate: held.promise }) }
    const pending = handleRequest(completeRequest(), deps)
    await vi.waitFor(() => expect(seen).toHaveLength(1))

    store.setConfig('markup', 1)
    held.open()
    expect(AiCompleteResult.parse(await (await pending).json()).chargeMicros).toBe(CHARGE)
    // The next request pays the new markup: ceil(165 × 2) = 330.
    expect(
      AiCompleteResult.parse(await (await handleRequest(completeRequest(), deps)).json())
        .chargeMicros
    ).toBe(330)
  })

  it('releases a hold nothing settled once it expires (L5)', async () => {
    const never = gate()
    deps = { ...deps, upstream: fakeUpstream({ gate: never.promise }) }
    void handleRequest(completeRequest(), deps)
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    expect(await available()).toBe(2_500_000 - HOLD)

    clock += 10 * MINUTE
    expect(await runScheduledSweep(store, clock)).toBe(1)
    expect(await store.holds()).toEqual([expect.objectContaining({ status: 'released' })])
    expect(await available()).toBe(2_500_000)
  })

  it('logs no manuscript text and no provider key, even when the gateway fails', async () => {
    const KEY = 'sk-or-v1-operator-secret'
    const answers: Response[] = [
      new Response(
        JSON.stringify({
          model: MODEL,
          choices: [{ message: { content: 'Mara hides the ferry key.' } }],
          usage: { prompt_tokens: 100, completion_tokens: 20 }
        }),
        { status: 200 }
      ),
      // A failing gateway may echo the request back; none of it may reach a log line.
      new Response(`{"error":"bad request: ${QUESTION}"}`, { status: 500 })
    ]
    const fetchImpl: FetchLike = () =>
      Promise.resolve(answers.shift() ?? new Response('', { status: 500 }))
    deps = { ...deps, upstream: openRouterUpstream(KEY, fetchImpl) }

    expect((await handleRequest(completeRequest(), deps)).status).toBe(200)
    expect((await handleRequest(completeRequest(), deps)).status).toBe(502)

    const logged = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(logged).not.toContain('Mara')
    expect(logged).not.toContain('ferry')
    expect(logged).not.toContain(KEY)
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
          { usage: ANSWER.usage, model: MODEL }
        ]
      })
    }
    const before = await available()
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe(AI_STREAM_CONTENT_TYPE)
    // The router's no-store wrapper must not break a streamed body.
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await streamEvents(response)).toEqual([
      { type: 'delta', delta: 'The storm ' },
      { type: 'delta', delta: 'broke at dusk.' },
      {
        type: 'done',
        model: MODEL,
        usage: ANSWER.usage,
        chargeMicros: CHARGE,
        balanceMicros: before - CHARGE,
        requestId: 'id-1'
      }
    ])
    expect(await charges()).toHaveLength(1)
    expect(await available()).toBe(before - CHARGE)
  })

  it('closes with a done event charged from an estimate when the gateway reports no usage', async () => {
    deps = { ...deps, upstream: fakeUpstream({ chunks: [{ delta: 'The storm broke.' }] }) }
    const before = await available()
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    // 25 characters in ≈ 7 tokens, 16 out ≈ 4: ceil((7 × 0.75 + 4 × 4.5) × 1.2) = 28.
    expect(await streamEvents(response)).toEqual([
      { type: 'delta', delta: 'The storm broke.' },
      {
        type: 'done',
        model: MODEL,
        usage: { inputTokens: 7, outputTokens: 4, cachedInputTokens: 0 },
        chargeMicros: 28,
        balanceMicros: before - 28,
        requestId: 'id-1'
      }
    ])
    expect(await available()).toBe(before - 28)
  })

  it('ends a gateway failure mid-stream as an error event and releases the hold', async () => {
    deps = {
      ...deps,
      upstream: fakeUpstream({
        chunks: [{ delta: 'The storm ' }],
        fail: new UpstreamError(500, 'other'),
        failAfter: 1
      })
    }
    const before = await available()
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(200)
    const streamed = await streamEvents(response)
    expect(streamed[0]).toEqual({ type: 'delta', delta: 'The storm ' })
    expect(streamed[1]).toMatchObject({ type: 'error', code: 'UPSTREAM' })
    expect(await charges()).toHaveLength(0)
    expect(await store.holds()).toEqual([expect.objectContaining({ status: 'released' })])
    expect(await available()).toBe(before)
  })

  it('refuses a streamed request with no balance before any byte is written', async () => {
    await topUp(-2_500_000)
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
        ...store,
        settleHold: () => Promise.reject(new Error('D1_ERROR: database is locked'))
      },
      upstream: fakeUpstream({
        chunks: [{ delta: 'The storm broke.' }, { usage: ANSWER.usage, model: MODEL }]
      })
    }
    const before = await available()
    const response = await handleRequest(
      completeRequest({ body: validBody({ stream: true }) }),
      deps
    )
    expect(response.status).toBe(200)
    const streamed = await streamEvents(response)
    expect(streamed).toHaveLength(2)
    expect(streamed[0]).toEqual({ type: 'delta', delta: 'The storm broke.' })
    expect(streamed[1]).toMatchObject({ type: 'error', code: 'INTERNAL' })
    expect(await available()).toBe(before)
    expect(await store.holds()).toEqual([expect.objectContaining({ status: 'released' })])
    expect(logs.some((line) => line.includes('failed after the provider answered'))).toBe(true)
    expect(logs.join('\n')).not.toContain('The storm broke.')
  })

  it('aborts the gateway, releases the hold, and charges nothing when the app stops reading', async () => {
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
    const before = await available()
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
    await vi.waitFor(async () =>
      expect(await store.holds()).toEqual([expect.objectContaining({ status: 'released' })])
    )
    expect(await charges()).toHaveLength(0)
    expect(await available()).toBe(before)
  })
})
