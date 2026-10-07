/**
 * The MythScribe hosted AI proxy (F-15.4, AI-BILLING-SPEC A6, A9, L5-L8, P1-P6, S3, S4): one
 * route, `POST /ai/complete`, behind the bearer. Per request, in order:
 *
 * 1. authenticate, validate, and check the configured limits (input size, model, requests per
 *    minute) — each refusal has its own code and forwards nothing;
 * 2. place a hold for the worst case (P4: every input token uncached, the answer at `maxTokens`)
 *    in the same statement that checks the available balance (L7), keyed by the request's
 *    `Idempotency-Key` (L8) — a balance short of the hold is refused with nothing forwarded;
 * 3. forward to the gateway (OpenRouter) on the operator's key and relay the answer;
 * 4. settle: one `charge` ledger row for the real usage at the prices locked on the hold (P2,
 *    P3, P6), never more than the hold; or, when the upstream failed or the app stopped reading,
 *    release the hold with no charge. A hold nothing settles is released by the scheduled sweep.
 *
 * Nothing here stores or logs content: the messages and the answer pass through memory and a
 * stream and are gone. The one log line per request carries ids, a model, token counts, the
 * cost, the status, and the time taken — never a message, never an answer.
 */
import {
  AI_STREAM_CONTENT_TYPE,
  AiCompleteFields,
  type AiCompleteResult,
  type AiStreamEvent,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
  TOKEN_BYTES
} from '../../src/shared/cloudApi'
import {
  chargeMicros,
  estimateTokensFromChars,
  findHostedModel,
  holdMicros,
  inputTokenUpperBound,
  lockPrices,
  providerCostMicros
} from '../../src/shared/cloudBilling'
import { authenticate, jsonError, jsonResponse, readJson, UNAUTHORIZED_MESSAGE } from './auth'
import { loadBillingConfig } from './config'
import type { CreditsDeps } from './credits'
import type { Upstream, UpstreamParams, UpstreamUsage } from './openai'
import { UpstreamError } from './openai'
import type { HoldRow } from './store'

export interface AiDeps extends CreditsDeps {
  /** Built from `OPENROUTER_API_KEY` (or `OPENAI_API_KEY`); absent → 503 NOT_CONFIGURED. */
  upstream: Upstream | null
}

/** Bytes of randomness in the id that ties a log line to a hold and a ledger row. */
const REQUEST_ID_BYTES = 16
const MINUTE_MS = 60_000

const UNKNOWN_MODEL = 'That model is not available on MythScribe hosted AI.'
const NOT_CONFIGURED = 'The AI proxy is not configured on the server yet.'
const NO_BALANCE = 'Your MythScribe balance does not cover this request. Add to it to continue.'
const BAD_BODY = 'MythScribe could not read that request.'
const BAD_KEY = 'The Idempotency-Key header is not valid.'
const TOO_LARGE = 'This request is longer than MythScribe hosted AI accepts. Send less text.'
const TOO_MANY = 'Too many AI requests in the last minute. Wait a moment and try again.'
const RUNNING = 'This request is still running. Wait for it to finish.'
const ALREADY_CHARGED = 'This request was already answered and charged. Send it as a new request.'
const UPSTREAM_FAILED = 'The AI provider did not answer. Try again in a moment.'
const UPSTREAM_BUSY = 'MythScribe hosted AI is busy right now. Try again in a moment.'
const MODEL_GONE = 'The AI provider no longer serves that model. Choose another.'
const METER_FAILED = 'MythScribe could not record this answer. Try again in a moment.'

/** What is logged per request (S3): ids, the model, token counts, money, status, and timing. */
function logRequest(input: {
  requestId: string
  userId: string
  feature: string
  model: string
  usage: UpstreamUsage
  providerCostMicros: number
  chargeMicros: number
  holdMicros: number
  status: 'ok' | 'error' | 'cancelled'
  ms: number
}): void {
  console.log(
    `ai ${input.requestId} user=${input.userId} feature=${input.feature} model=${input.model} ` +
      `in=${input.usage.inputTokens} out=${input.usage.outputTokens} ` +
      `cached=${input.usage.cachedInputTokens} cost=${input.providerCostMicros} ` +
      `charge=${input.chargeMicros} hold=${input.holdMicros} status=${input.status} ms=${input.ms}`
  )
}

const NO_USAGE: UpstreamUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }

/** The error answer for an upstream failure before any byte was sent. */
function upstreamFailure(err: UpstreamError): {
  code: 'RATE_LIMITED' | 'MODEL_UNAVAILABLE' | 'UPSTREAM'
  message: string
} {
  if (err.kind === 'rate_limit') return { code: 'RATE_LIMITED', message: UPSTREAM_BUSY }
  if (err.kind === 'model_unavailable') return { code: 'MODEL_UNAVAILABLE', message: MODEL_GONE }
  return { code: 'UPSTREAM', message: UPSTREAM_FAILED }
}

function logUpstream(err: UpstreamError, requestId: string): void {
  // The operator's key is wrong, revoked, or out of gateway credit; the author can do nothing.
  if (err.kind === 'auth') console.error(`ai ${requestId}: the gateway rejected the operator's key`)
  if (err.status === 402) console.error(`ai ${requestId}: the gateway account is out of credit`)
}

/** One request's state between the hold and the settlement. */
interface Metered {
  deps: AiDeps
  hold: HoldRow
  userId: string
  maxTokens: number
  /** Characters of message content, for the estimate when the gateway reports no usage. */
  inputChars: number
  startedAt: number
}

/** The receipt of a settled request. */
interface Receipt {
  usage: UpstreamUsage
  chargeMicros: number
  balanceMicros: number
}

/**
 * Charge the request and close its hold (flow step 6). The charge is the real usage at the
 * hold's locked prices plus the locked markup, at least 1 micro-USD for an answer, and never more
 * than the hold (P4) — a gateway that over-reports is clamped and logged. With no usage reported
 * for an answer that arrived, the tokens are estimated from the text (within the hold's bounds).
 */
async function settle(
  m: Metered,
  reported: UpstreamUsage | null,
  answerChars: number
): Promise<Receipt> {
  const { deps, hold } = m
  const usage: UpstreamUsage = reported ?? {
    inputTokens: estimateTokensFromChars(m.inputChars),
    outputTokens: Math.min(estimateTokensFromChars(answerChars), m.maxTokens),
    cachedInputTokens: 0
  }
  const raw = chargeMicros(hold.prices, usage)
  if (raw > hold.amountMicros) {
    console.error(`ai ${hold.requestId}: usage over the hold; charge clamped to the hold`)
  }
  const charge = Math.min(Math.max(raw, 1), hold.amountMicros)
  const cost = providerCostMicros(hold.prices, usage)
  const now = deps.now().getTime()
  await deps.store.settleHold(
    hold,
    {
      id: deps.random(TOKEN_BYTES),
      userId: m.userId,
      type: 'charge',
      amountMicros: -charge,
      idempotencyKey: `charge:${hold.requestId}`,
      createdAt: now,
      orderId: null,
      requestId: hold.requestId,
      feature: hold.feature,
      model: hold.model,
      tokensIn: usage.inputTokens,
      tokensOut: usage.outputTokens,
      tokensCached: usage.cachedInputTokens,
      providerCostMicros: cost,
      markupBps: hold.prices.markupBps
    },
    now
  )
  const balance = await deps.store.getBalance(m.userId, now)
  logRequest({
    requestId: hold.requestId,
    userId: m.userId,
    feature: hold.feature,
    model: hold.model,
    usage,
    providerCostMicros: cost,
    chargeMicros: charge,
    holdMicros: hold.amountMicros,
    status: 'ok',
    ms: now - m.startedAt
  })
  return { usage, chargeMicros: charge, balanceMicros: balance.ledgerMicros - balance.heldMicros }
}

/** Close the hold with no charge (flow step 7); a store failure here is left to the sweep. */
async function release(m: Metered, status: 'error' | 'cancelled'): Promise<void> {
  const now = m.deps.now().getTime()
  try {
    await m.deps.store.releaseHold(m.hold, now)
  } catch (err) {
    console.error(`ai ${m.hold.requestId}: could not release the hold; the sweep will`, err)
  }
  logRequest({
    requestId: m.hold.requestId,
    userId: m.userId,
    feature: m.hold.feature,
    model: m.hold.model,
    usage: NO_USAGE,
    providerCostMicros: 0,
    chargeMicros: 0,
    holdMicros: m.hold.amountMicros,
    status,
    ms: now - m.startedAt
  })
}

export async function handleAiComplete(request: Request, deps: AiDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)
  const userId = caller.user.id

  const parsed = AiCompleteFields.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('BAD_REQUEST', BAD_BODY)
  const body = parsed.data
  const offeredKey = request.headers.get(IDEMPOTENCY_KEY_HEADER)
  if (offeredKey !== null && !IdempotencyKey.safeParse(offeredKey).success) {
    return jsonError('BAD_REQUEST', BAD_KEY)
  }

  const config = await loadBillingConfig(deps.store)
  const inputChars = body.messages.reduce((sum, message) => sum + message.content.length, 0)
  if (inputChars > config.maxInputChars) return jsonError('REQUEST_TOO_LARGE', TOO_LARGE)
  const price = findHostedModel(config.models, body.model)
  if (!price) return jsonError('MODEL_UNAVAILABLE', UNKNOWN_MODEL)
  const { upstream } = deps
  if (upstream === null) return jsonError('NOT_CONFIGURED', NOT_CONFIGURED)

  const startedAt = deps.now().getTime()
  const windowStart = Math.floor(startedAt / MINUTE_MS) * MINUTE_MS
  if ((await deps.store.hitRateLimit(userId, windowStart)) > config.requestsPerMinute) {
    return jsonError('RATE_LIMITED', TOO_MANY)
  }

  const prices = lockPrices(price, config.markup)
  const requestId = deps.random(REQUEST_ID_BYTES)
  const placed = await deps.store.placeHold(
    {
      id: deps.random(REQUEST_ID_BYTES),
      userId,
      idempotencyKey: offeredKey ?? `auto:${requestId}`,
      requestId,
      feature: body.feature,
      model: price.id,
      amountMicros: holdMicros(prices, inputTokenUpperBound(body.messages), body.maxTokens),
      prices,
      status: 'active',
      createdAt: startedAt,
      expiresAt: startedAt + config.holdExpiryMinutes * MINUTE_MS,
      closedAt: null,
      chargeMicros: null
    },
    startedAt
  )
  if (placed.status === 'insufficient') return jsonError('INSUFFICIENT_CREDITS', NO_BALANCE)
  if (placed.status === 'duplicate') {
    return jsonError(
      'DUPLICATE_REQUEST',
      placed.hold.status === 'settled' ? ALREADY_CHARGED : RUNNING
    )
  }

  const metered: Metered = {
    deps,
    hold: placed.hold,
    userId,
    maxTokens: body.maxTokens,
    inputChars,
    startedAt
  }
  const params: UpstreamParams = {
    model: price.id,
    messages: body.messages,
    maxTokens: body.maxTokens,
    ...(body.json === undefined ? {} : { json: body.json }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature })
  }

  if (body.stream) return streamAnswer(metered, upstream, params)

  let answer: Awaited<ReturnType<Upstream['complete']>>
  try {
    answer = await upstream.complete(params)
  } catch (err) {
    await release(metered, 'error')
    if (!(err instanceof UpstreamError)) throw err
    logUpstream(err, requestId)
    const failure = upstreamFailure(err)
    return jsonError(failure.code, failure.message)
  }

  let receipt: Receipt
  try {
    receipt = await settle(metered, answer.usage, answer.text.length)
  } catch (err) {
    // The settlement batch rolled back: nothing was charged, so the hold is released too.
    console.error(`ai ${requestId}: failed after the provider answered`, err)
    await release(metered, 'error')
    return jsonError('INTERNAL', METER_FAILED)
  }
  return jsonResponse({
    text: answer.text,
    model: price.id,
    usage: receipt.usage,
    chargeMicros: receipt.chargeMicros,
    balanceMicros: receipt.balanceMicros,
    requestId
  } satisfies AiCompleteResult)
}

/**
 * The streamed answer: NDJSON, one event per line, deltas as they arrive and exactly one
 * terminal event. A failure after the headers were sent is an `error` event (the status is
 * already 200) and releases the hold; an author who stops mid-answer cancels this stream, which
 * aborts the gateway call and charges nothing — the tokens already generated are bounded by
 * `maxTokens` and are the operator's cost.
 */
function streamAnswer(m: Metered, upstream: Upstream, params: UpstreamParams): Response {
  const abort = new AbortController()
  const encoder = new TextEncoder()
  const { requestId } = m.hold
  /** Set by `cancel`: the app stopped reading, so nothing more can be enqueued or closed. */
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: AiStreamEvent): void => {
        if (cancelled) return
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      const finish = async (usage: UpstreamUsage | null, answerChars: number): Promise<void> => {
        const receipt = await settle(m, usage, answerChars)
        write({
          type: 'done',
          model: m.hold.model,
          usage: receipt.usage,
          chargeMicros: receipt.chargeMicros,
          balanceMicros: receipt.balanceMicros,
          requestId
        })
      }

      let settled = false
      let answerChars = 0
      try {
        for await (const chunk of upstream.stream(params, abort.signal)) {
          if ('delta' in chunk) {
            answerChars += chunk.delta.length
            write({ type: 'delta', delta: chunk.delta })
            continue
          }
          await finish(chunk.usage, answerChars)
          settled = true
        }
        if (!settled) {
          if (cancelled) {
            await release(m, 'cancelled')
          } else {
            // A gateway that sent no usage still answered: close with a `done` so the app never
            // waits, charged from an estimate of the text, within the hold.
            await finish(null, answerChars)
            settled = true
          }
        }
      } catch (err) {
        // Every failure after the headers went out ends the stream with exactly one `error`
        // event: the gateway's (mapped like the JSON route's), or the meter's (the settlement
        // rolled back after the provider answered: the answer is on the wire but unbilled; the
        // cause goes to the log, the app hears INTERNAL and nothing is charged).
        if (!settled) await release(m, cancelled ? 'cancelled' : 'error')
        const upstreamError = err instanceof UpstreamError ? err : null
        if (upstreamError === null) {
          if (!cancelled) console.error(`ai ${requestId}: failed after the provider answered`, err)
          write({ type: 'error', code: 'INTERNAL', message: METER_FAILED })
        } else {
          logUpstream(upstreamError, requestId)
          write({ type: 'error', ...upstreamFailure(upstreamError) })
        }
      } finally {
        if (!cancelled) controller.close()
      }
    },
    cancel() {
      cancelled = true
      abort.abort()
    }
  })

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': AI_STREAM_CONTENT_TYPE }
  })
}
