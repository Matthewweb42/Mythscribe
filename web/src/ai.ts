/**
 * `POST /api/ai`: one round of Ms Scribe's conversation on the Anthropic API, streamed back as
 * server-sent events. The tool loop stays in the browser, as in Desk: when the answer stops for
 * tools, the shim runs them against the books in IndexedDB and calls again with the results.
 *
 * Body:   { tier: "quick" | "default" | "complex", messages: MessageParam[], tools?: [{ name, description, input_schema }] }
 * Events: `text` { d }            a piece of the answer
 *         `done` { content, stop_reason, model }   the whole assistant turn, to echo back verbatim
 *         `error` { code, message }
 *
 * Models (the plan's picks): quick = Claude Haiku 5.5 (fact filing, summaries), default and
 * complex = Claude Sonnet 5.5 at medium and high effort. Every request turns on automatic prompt
 * caching, so the long book context Desk sends first is read from cache on the next round.
 * Sonnet requests also turn on the API's server-side refusal fallback.
 */
import Anthropic from '@anthropic-ai/sdk'
import { type Caller, fail, isRecord, readJson } from './http'

export type Tier = 'quick' | 'default' | 'complex'

type Route = {
  model: string
  effort: 'low' | 'medium' | 'high'
  maxTokens: number
  fallbacks: boolean
}

export const ROUTES: Record<Tier, Route> = {
  quick: { model: 'claude-haiku-5-5', effort: 'low', maxTokens: 16000, fallbacks: false },
  default: { model: 'claude-sonnet-5-5', effort: 'medium', maxTokens: 32000, fallbacks: true },
  complex: { model: 'claude-sonnet-5-5', effort: 'high', maxTokens: 32000, fallbacks: true }
}

/** US dollars per million tokens (Anthropic list prices; 5-minute cache writes are 1.25x input). */
type Price = { input: number; output: number; cacheRead: number; cacheWrite: number }
const SONNET: Price = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }
const HAIKU: Price = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
/** Haiku 5.5 prompts over 100K tokens bill at five times the rate. */
const HAIKU_LONG: Price = { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number }

/** Cost in micro-USD: one dollar per million tokens is one micro-dollar per token. */
export function costMicros(model: string, u: Usage): number {
  const prompt = u.input + u.cacheRead + u.cacheWrite
  const p = model.startsWith('claude-haiku') ? (prompt > 100_000 ? HAIKU_LONG : HAIKU) : SONNET
  return Math.ceil(u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite)
}

const MAX_BODY_BYTES = 4 * 1024 * 1024
const MAX_MESSAGES = 400
const MAX_TOOLS = 16

type ToolDef = { name: string; description: string; input_schema: Record<string, unknown> }
export type AiBody = { tier: Tier; messages: Anthropic.Beta.BetaMessageParam[]; tools: ToolDef[] }

/** The checked body, or an error message. Content blocks pass through as the API defines them. */
export function parseAiBody(body: unknown): AiBody | string {
  if (!isRecord(body)) return 'Send JSON: { tier, messages, tools? }.'
  const tier = body.tier ?? 'default'
  if (tier !== 'quick' && tier !== 'default' && tier !== 'complex') return 'tier must be quick, default or complex'
  const messages = body.messages
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > MAX_MESSAGES) return 'messages must be a non-empty list'
  for (const m of messages) {
    if (!isRecord(m) || (m.role !== 'user' && m.role !== 'assistant')) return 'each message needs role user or assistant'
    if (typeof m.content !== 'string' && !Array.isArray(m.content)) return 'each message needs content'
  }
  const first = messages[0] as { role: string }
  const last = messages[messages.length - 1] as { role: string }
  if (first.role !== 'user' || last.role !== 'user') return 'messages must start and end with the user'
  const tools: ToolDef[] = []
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOLS) return `tools must be a list of at most ${MAX_TOOLS}`
    for (const t of body.tools) {
      if (!isRecord(t) || typeof t.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) return 'each tool needs a name'
      const schema = isRecord(t.input_schema) ? t.input_schema : { type: 'object', properties: {} }
      tools.push({ name: t.name, description: typeof t.description === 'string' ? t.description : '', input_schema: schema })
    }
  }
  return { tier, messages: messages as Anthropic.Beta.BetaMessageParam[], tools }
}

/** The request the API gets for one round. */
export function buildParams(b: AiBody): Anthropic.Beta.MessageCreateParamsStreaming {
  const r = ROUTES[b.tier]
  const params: Anthropic.Beta.MessageCreateParamsStreaming = {
    model: r.model,
    max_tokens: r.maxTokens,
    stream: true,
    messages: b.messages,
    cache_control: { type: 'ephemeral' },
    output_config: { effort: r.effort }
  }
  if (b.tools.length) {
    params.tools = b.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: { ...t.input_schema, type: 'object' } as Anthropic.Beta.BetaTool.InputSchema
    }))
  }
  if (r.fallbacks) {
    params.betas = ['server-side-fallback-2026-07-01']
    params.fallbacks = 'default'
  }
  return params
}

/** The shim's error codes, from the SDK's typed errors. */
export function errorCode(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof Anthropic.RateLimitError) return { status: 429, code: 'rate_limited', message: 'Ms Scribe is busy. Try again in a minute.' }
  if (e instanceof Anthropic.APIUserAbortError) return { status: 499, code: 'cancelled', message: 'Stopped.' }
  if (e instanceof Anthropic.BadRequestError)
    return /too long|too many tokens|context window/i.test(e.message)
      ? { status: 400, code: 'prompt_too_large', message: 'That’s too much at once.' }
      : { status: 400, code: 'invalid_request', message: e.message }
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError)
    return { status: 502, code: 'upstream_error', message: 'The AI key on the server is missing or wrong.' }
  if (e instanceof Anthropic.APIError && (e.status === 529 || (e.status ?? 0) >= 500))
    return { status: 502, code: 'upstream_error', message: 'The AI service had a problem. Try again.' }
  if (e instanceof Anthropic.APIConnectionError) return { status: 502, code: 'upstream_error', message: 'Couldn’t reach the AI service.' }
  return { status: 500, code: 'upstream_error', message: e instanceof Error ? e.message : 'Something went wrong.' }
}

/** ANTHROPIC_BASE_URL is for tests only: it points the SDK at a local stand-in. */
export type AiEnv = { ANTHROPIC_API_KEY?: string; ANTHROPIC_BASE_URL?: string; AI_MONTHLY_CAP_USD?: string; DB: D1Database }

function monthStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
}

/** This calendar month's spend for one author, in micro-USD. */
export async function monthSpend(db: D1Database, userId: string, now = new Date()): Promise<number> {
  const row = await db
    .prepare('SELECT COALESCE(SUM(cost_micros), 0) AS spent FROM ai_usage WHERE user_id = ?1 AND at >= ?2')
    .bind(userId, monthStart(now))
    .first<{ spent: number }>()
  return row?.spent ?? 0
}

export async function handleAi(
  request: Request,
  env: AiEnv,
  who: Caller,
  ctx: ExecutionContext,
  makeClient: (key: string) => Anthropic = (key) =>
    new Anthropic({ apiKey: key, ...(env.ANTHROPIC_BASE_URL ? { baseURL: env.ANTHROPIC_BASE_URL } : {}) })
): Promise<Response> {
  if (!env.ANTHROPIC_API_KEY) return fail(503, 'unavailable', 'Ms Scribe isn’t set up on this server yet (no ANTHROPIC_API_KEY).')
  const parsed = parseAiBody(await readJson(request, MAX_BODY_BYTES))
  if (typeof parsed === 'string') return fail(400, 'invalid_argument', parsed)
  const capUsd = Number(env.AI_MONTHLY_CAP_USD ?? '10')
  if (Number.isFinite(capUsd) && capUsd > 0 && (await monthSpend(env.DB, who.userId)) >= capUsd * 1_000_000)
    return fail(402, 'quota', `This account has used its $${capUsd} of Ms Scribe for this month.`)

  const client = makeClient(env.ANTHROPIC_API_KEY)
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const enc = new TextEncoder()
  const send = (event: string, data: unknown) => writer.write(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))

  const run = async () => {
    try {
      const stream = client.beta.messages.stream(buildParams(parsed), { signal: request.signal })
      for await (const ev of stream) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta') await send('text', { d: ev.delta.text })
      }
      const msg = await stream.finalMessage()
      await send('done', { content: msg.content, stop_reason: msg.stop_reason, model: msg.model })
      const u = msg.usage
      const usage: Usage = {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0
      }
      ctx.waitUntil(
        env.DB.prepare(
          `INSERT INTO ai_usage (user_id, at, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_micros)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`
        )
          .bind(who.userId, Date.now(), msg.model, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, costMicros(msg.model, usage))
          .run()
          .then(() => undefined)
      )
    } catch (e) {
      const { code, message } = errorCode(e)
      await send('error', { code, message }).catch(() => undefined)
    } finally {
      await writer.close().catch(() => undefined)
    }
  }
  ctx.waitUntil(run())
  return new Response(readable, {
    headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' }
  })
}
