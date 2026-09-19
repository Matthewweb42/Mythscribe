/**
 * The MythScribe Cloud AI proxy (F-15.4): one route, `POST /ai/complete`, behind the session
 * bearer. It checks the balance before the request leaves (F-15.3's `hasCredit`), relays the
 * messages to the provider on the operator's key, and charges the account after the answer
 * (`meterRequest`), at the same published rate the app shows.
 *
 * Nothing here stores or logs content: the messages and the answer pass through memory and a
 * stream and are gone. The one log line per answered request carries ids, a model, token
 * counts, and the charge — never a message, never an answer.
 */
import {
  AI_STREAM_CONTENT_TYPE,
  AiCompleteBody,
  type AiCompleteResult,
  type AiStreamEvent
} from '../../src/shared/cloudApi'
import { cloudRateFor } from '../../src/shared/cloudRates'
import { authenticate, jsonError, jsonResponse, readJson, UNAUTHORIZED_MESSAGE } from './auth'
import { type CreditsDeps, hasCredit, meterRequest } from './credits'
import type { Upstream, UpstreamAnswer, UpstreamParams, UpstreamUsage } from './openai'
import { UpstreamError } from './openai'

export interface AiDeps extends CreditsDeps {
  /** Built from `OPENAI_API_KEY`; absent → the route answers 503 NOT_CONFIGURED. */
  upstream: Upstream | null
}

/** Bytes of randomness in the id that ties a log line to a `credit_events` row. */
const REQUEST_ID_BYTES = 16

const UNKNOWN_MODEL = 'That model is not available on MythScribe Cloud.'
const NOT_CONFIGURED = 'The AI proxy is not configured on the server yet.'
const NO_CREDIT = 'Your MythScribe Cloud balance is used up.'
const BAD_BODY = 'MythScribe Cloud could not read that request.'
const UPSTREAM_FAILED = 'The AI provider did not answer. Try again in a moment.'
const UPSTREAM_BUSY = 'MythScribe Cloud is busy right now. Try again in a moment.'
const METER_FAILED = 'MythScribe Cloud could not record this answer. Try again in a moment.'

/** What is logged per answered request: ids and numbers only. */
function logAnswer(input: {
  requestId: string
  userId: string
  feature: string
  model: string
  usage: UpstreamUsage
  chargeMicros: number
  status: 'ok' | 'error'
}): void {
  console.log(
    `ai ${input.requestId} user=${input.userId} feature=${input.feature} model=${input.model} ` +
      `in=${input.usage.inputTokens} out=${input.usage.outputTokens} ` +
      `charge=${input.chargeMicros} status=${input.status}`
  )
}

/** A provider failure before any byte was sent: busy is a 429, everything else a 502. */
function upstreamError(err: UpstreamError, requestId: string): Response {
  if (err.kind === 'auth') {
    // The operator's key is wrong or revoked; the author can do nothing about it.
    console.error(`ai ${requestId}: the provider rejected the operator's key`)
  }
  if (err.kind === 'rate_limit') return jsonError('RATE_LIMITED', UPSTREAM_BUSY)
  return jsonError('UPSTREAM', UPSTREAM_FAILED)
}

/**
 * The model the charge is booked against: what the provider answered with when that has a
 * published rate (it may be a dated snapshot id the table does not know), else what was asked
 * for, which was checked against the table before the request left.
 */
function billedModel(answered: string, requested: string): string {
  return cloudRateFor(answered).priced ? answered : requested
}

export async function handleAiComplete(request: Request, deps: AiDeps): Promise<Response> {
  const caller = await authenticate(request, deps)
  if (!caller) return jsonError('UNAUTHORIZED', UNAUTHORIZED_MESSAGE)

  const parsed = AiCompleteBody.safeParse(await readJson(request))
  if (!parsed.success) return jsonError('BAD_REQUEST', BAD_BODY)
  const body = parsed.data

  if (!cloudRateFor(body.model).priced) return jsonError('BAD_REQUEST', UNKNOWN_MODEL)
  const { upstream } = deps
  if (upstream === null) return jsonError('NOT_CONFIGURED', NOT_CONFIGURED)
  if (!(await hasCredit(deps.store, caller.user.id))) {
    return jsonError('INSUFFICIENT_CREDITS', NO_CREDIT)
  }

  const requestId = deps.random(REQUEST_ID_BYTES)
  const params: UpstreamParams = {
    model: body.model,
    messages: body.messages,
    maxTokens: body.maxTokens,
    ...(body.json === undefined ? {} : { json: body.json }),
    ...(body.temperature === undefined ? {} : { temperature: body.temperature })
  }

  if (body.stream) return streamAnswer(deps, upstream, params, body, caller.user.id, requestId)

  let answer: UpstreamAnswer
  try {
    answer = await upstream.complete(params)
  } catch (err) {
    if (err instanceof UpstreamError) return upstreamError(err, requestId)
    throw err
  }

  const model = billedModel(answer.model, body.model)
  const charge = await meterRequest(deps, caller.user.id, {
    feature: body.feature,
    model,
    tokensIn: answer.usage.inputTokens,
    tokensOut: answer.usage.outputTokens,
    requestId
  })
  logAnswer({
    requestId,
    userId: caller.user.id,
    feature: body.feature,
    model,
    usage: answer.usage,
    chargeMicros: charge.micros,
    status: 'ok'
  })
  return jsonResponse({
    text: answer.text,
    model,
    usage: answer.usage,
    chargeMicros: charge.micros,
    balanceMicros: charge.balanceMicros
  } satisfies AiCompleteResult)
}

/**
 * The streamed answer: NDJSON, one event per line, deltas as they arrive and exactly one
 * terminal event. A provider failure after the headers were sent is an `error` event (the
 * status is already 200); an author who stops mid-answer cancels this stream, which aborts the
 * provider call and charges nothing — the tokens already generated are bounded by `maxTokens`
 * and are the operator's cost.
 */
function streamAnswer(
  deps: AiDeps,
  upstream: Upstream,
  params: UpstreamParams,
  body: { feature: string; model: string },
  userId: string,
  requestId: string
): Response {
  const abort = new AbortController()
  const encoder = new TextEncoder()
  /** Set by `cancel`: the app stopped reading, so nothing more can be enqueued or closed. */
  let cancelled = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: AiStreamEvent): void => {
        if (cancelled) return
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`))
      }
      /** The answer is metered once, from the provider's usage chunk (or zeros, if it sent none). */
      const finish = async (usage: UpstreamUsage, answered: string): Promise<void> => {
        const model = billedModel(answered, body.model)
        const charge = await meterRequest(deps, userId, {
          feature: body.feature,
          model,
          tokensIn: usage.inputTokens,
          tokensOut: usage.outputTokens,
          requestId
        })
        write({
          type: 'done',
          model,
          usage,
          chargeMicros: charge.micros,
          balanceMicros: charge.balanceMicros
        })
        logAnswer({
          requestId,
          userId,
          feature: body.feature,
          model,
          usage,
          chargeMicros: charge.micros,
          status: 'ok'
        })
      }

      let metered = false
      try {
        for await (const chunk of upstream.stream(params, abort.signal)) {
          if ('delta' in chunk) {
            write({ type: 'delta', delta: chunk.delta })
            continue
          }
          await finish(chunk.usage, chunk.model)
          metered = true
        }
        // A provider that sent no usage chunk still answered: close the stream with a `done` so
        // the app never waits, and charge the minimum rather than nothing.
        if (!metered) await finish({ inputTokens: 0, outputTokens: 0 }, body.model)
      } catch (err) {
        // Every failure after the headers went out ends the stream with exactly one `error`
        // event: the provider's (mapped like the JSON route's), or the meter's (the store
        // failed after the provider answered, so the answer is on the wire but unbilled; the
        // cause goes to the log, the app hears INTERNAL and nothing is charged).
        const upstreamError = err instanceof UpstreamError ? err : null
        if (upstreamError === null) {
          console.error(`ai ${requestId}: failed after the provider answered`, err)
        } else if (upstreamError.kind === 'auth') {
          console.error(`ai ${requestId}: the provider rejected the operator's key`)
        }
        write(
          upstreamError === null
            ? { type: 'error', code: 'INTERNAL', message: METER_FAILED }
            : {
                type: 'error',
                code: upstreamError.kind === 'rate_limit' ? 'RATE_LIMITED' : 'UPSTREAM',
                message: upstreamError.kind === 'rate_limit' ? UPSTREAM_BUSY : UPSTREAM_FAILED
              }
        )
        logAnswer({
          requestId,
          userId,
          feature: body.feature,
          model: body.model,
          usage: { inputTokens: 0, outputTokens: 0 },
          chargeMicros: 0,
          status: 'error'
        })
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
