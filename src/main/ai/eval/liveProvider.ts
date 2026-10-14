import {
  DEFAULT_MODELS,
  OPENROUTER_BASE_URL,
  OPENROUTER_DEFAULT_MODELS,
  priceFor,
  type Tier
} from '@shared/ai'
import { autoTable, defaultAiRouting } from '@shared/aiRouting'
import type { CachedResponse } from '../cacheStore'
import { dayOf, defaultAiUsageState } from '../dailyCap'
import { buildOpenAiProvider, type FetchLike } from '../providers/openai'
import {
  AiProviderError,
  type AiMessage,
  type Provider,
  type StreamChunk
} from '../providers/types'
import type { AiRequestDeps } from '../request'
import type { UsageEntry } from '../usageStore'

/**
 * One key for every live path (F-16.22; plan P2b §3.1): the live prompt fidelity run
 * (`prompts.eval.ts`), the live planted-error run (`memory.eval.ts`), the live knows run
 * (`knows.eval.ts`), the live Ms Scribe run (`scribe.eval.ts`, P3), the live contradictions run
 * (`findings.eval.ts`, P4) and the price probe (`aiProbe.probe.ts`) all start from
 * `OPENROUTER_API_KEY` alone, so the author keeps one secret:
 *
 *     MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai             # fidelity, planted errors, knows, Ms Scribe, contradictions
 *     MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- memory   # planted errors only
 *     MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- knows    # who knows what only
 *     MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- scribe   # Ms Scribe only (stops at $1)
 *     MYTHSCRIBE_EVAL_LIVE=1 OPENROUTER_API_KEY=sk-or-… npm run eval:ai -- findings # contradictions only (stops at 50¢)
 *     OPENROUTER_API_KEY=sk-or-… npm run ai:probe                                  # the price probe
 *
 * `OPENROUTER_API_KEY` set: OpenRouter's base URL, its reasoning control (the app's "off" for
 * the story-memory reader and checker) and its reported cost; models `MYTHSCRIBE_EVAL_FAST_MODEL`
 * / `MYTHSCRIBE_EVAL_STRONG_MODEL`, else the OpenRouter defaults (V4 Flash, V4 Pro). Otherwise
 * `OPENAI_API_KEY` as before, with `OPENAI_BASE_URL` when set (an OpenRouter URL there is still
 * OpenRouter). Neither: one error naming both. Developer tools only: nothing in the app imports
 * this, and no key is ever written to a report.
 */

/**
 * OpenAI's own API root. The OpenAI-itself route pins it, so a shell's `OPENAI_BASE_URL` (which the
 * SDK would otherwise read on its own) never moves a run that says it is on OpenAI.
 */
export const OPENAI_API_URL = 'https://api.openai.com/v1'

/** The environment the live paths read (`process.env` in a run, a literal in tests). */
export type LiveEnv = Readonly<Record<string, string | undefined>>

/** Where a live run's requests go, read from the environment without a request. */
export interface LiveSettings {
  key: string
  /** The variable the key came from (reports name it, never the key). */
  keyVar: 'OPENROUTER_API_KEY' | 'OPENAI_API_KEY'
  /** The OpenAI-compatible base URL; undefined is OpenAI itself. */
  baseURL: string | undefined
  /** OpenRouter: its reasoning control, attribution headers and reported cost. */
  openRouter: boolean
  models: Record<Tier, string>
}

export const LIVE_KEY_MISSING =
  'The live runs need a key: OPENROUTER_API_KEY=sk-or-… (one key for every live run), or ' +
  'OPENAI_API_KEY (with OPENAI_BASE_URL for another OpenAI-compatible server).'

/** A set, non-blank variable's value; blank or unset is null. */
function variable(env: LiveEnv, name: string): string | null {
  const value = env[name]?.trim() ?? ''
  return value === '' ? null : value
}

/** Whether a base URL is OpenRouter's (any path on openrouter.ai). */
export function isOpenRouterUrl(url: string | undefined): boolean {
  if (url === undefined) return false
  try {
    const host = new URL(url).hostname
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai')
  } catch {
    return false
  }
}

/** Whether a base URL is this machine's (a local server, which charges nothing). */
export function isLoopbackUrl(url: string | undefined): boolean {
  if (url === undefined) return false
  try {
    const host = new URL(url).hostname
    return host === 'localhost' || host === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(host)
  } catch {
    return false
  }
}

/** The tier → model map: the eval's overrides, else the route's defaults. */
function modelsFor(env: LiveEnv, openRouter: boolean): Record<Tier, string> {
  const base = openRouter ? OPENROUTER_DEFAULT_MODELS : DEFAULT_MODELS
  return {
    fast: variable(env, 'MYTHSCRIBE_EVAL_FAST_MODEL') ?? base.fast,
    strong: variable(env, 'MYTHSCRIBE_EVAL_STRONG_MODEL') ?? base.strong
  }
}

/** The live settings the environment gives, or null when it holds no key. */
export function liveSettingsOrNull(env: LiveEnv = process.env): LiveSettings | null {
  const openRouterKey = variable(env, 'OPENROUTER_API_KEY')
  if (openRouterKey !== null) {
    return {
      key: openRouterKey,
      keyVar: 'OPENROUTER_API_KEY',
      baseURL: OPENROUTER_BASE_URL,
      openRouter: true,
      models: modelsFor(env, true)
    }
  }
  const openAiKey = variable(env, 'OPENAI_API_KEY')
  if (openAiKey === null) return null
  const baseURL = variable(env, 'OPENAI_BASE_URL') ?? undefined
  const openRouter = isOpenRouterUrl(baseURL)
  return {
    key: openAiKey,
    keyVar: 'OPENAI_API_KEY',
    baseURL,
    openRouter,
    models: modelsFor(env, openRouter)
  }
}

/** The live settings the environment gives; throws `LIVE_KEY_MISSING` when it holds no key. */
export function liveSettingsFromEnv(env: LiveEnv = process.env): LiveSettings {
  const settings = liveSettingsOrNull(env)
  if (settings === null) throw new Error(LIVE_KEY_MISSING)
  return settings
}

/**
 * The price probe's key (F-16.1): `OPENROUTER_API_KEY`, or `OPENAI_API_KEY` when
 * `OPENAI_BASE_URL` is OpenRouter's (the probe reads OpenRouter's model listing and endpoints, so
 * no other server will do); null otherwise.
 */
export function openRouterKeyFromEnv(env: LiveEnv = process.env): string | null {
  const settings = liveSettingsOrNull(env)
  return settings?.openRouter === true ? settings.key : null
}

/** A live provider and what a report may say about it (never the key). */
export interface LiveProvider {
  provider: Provider
  models: Record<Tier, string>
  openRouter: boolean
  /** "OpenRouter (OPENROUTER_API_KEY)": the route and the variable the key came from. */
  describe: string
  /** A server on this machine (`OPENAI_BASE_URL` on localhost): nothing it answers is charged. */
  local: boolean
}

/** The live provider the environment gives (no request is made); throws when it holds no key. */
export function liveProviderFromEnv(
  env: LiveEnv = process.env,
  options: { fetch?: FetchLike } = {}
): LiveProvider {
  const settings = liveSettingsFromEnv(env)
  const { models, openRouter } = settings
  const label = openRouter ? 'OpenRouter' : 'OpenAI'
  const provider = buildOpenAiProvider(settings.key, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(settings.baseURL === undefined
      ? { openAiURL: OPENAI_API_URL }
      : { baseURL: settings.baseURL }),
    openRouter,
    id: openRouter ? 'openrouter' : 'openai',
    label,
    resolveModel: (tier) => models[tier]
  })
  const where =
    !openRouter && settings.baseURL !== undefined ? ` at ${new URL(settings.baseURL).host}` : ''
  return {
    provider,
    models,
    openRouter,
    describe: `${label}${where} (${settings.keyVar})`,
    local: isLoopbackUrl(settings.baseURL)
  }
}

/** Request deps for a live run, with its ledger and what it has spent. */
export interface LiveRequestDeps {
  deps: AiRequestDeps
  /** Every request's ledger row (the reported cost when the provider gave one). */
  ledger: UsageEntry[]
  /** What the run has spent so far, in USD. */
  spent(): number
  /**
   * Why the run's cost stop cannot hold, or null: a request on a charged route came back with no
   * reported cost on a model the price tables do not list, so its row counts 0 USD and `spent()`
   * no longer bounds what the run costs. The live runs stop on it and say so in their reports.
   */
  costUnknown(): string | null
}

/**
 * The request path's deps for a live run: an in-memory ledger and cache, no daily cap to speak of,
 * and the Auto routing, so every request leaves as the app sends it (the reader and the checker
 * with no reasoning; OpenRouter's reported cost in the ledger).
 */
export function liveRequestDeps(live: Pick<LiveProvider, 'provider' | 'local'>): LiveRequestDeps {
  const { provider } = live
  const ledger: UsageEntry[] = []
  const cache = new Map<string, CachedResponse>()
  const deps: AiRequestDeps = {
    providers: { get: () => provider },
    ledger: { insert: (entry) => void ledger.push(entry) },
    cache: {
      get: (key) => cache.get(key),
      put: (entry) => void cache.set(entry.key, { text: entry.text, usage: entry.usage })
    },
    dailyCap: {
      get: () => ({ ...defaultAiUsageState(), dailyCapUsd: 500, spentDate: dayOf(new Date()) }),
      spend: () => undefined
    },
    session: { spend: () => undefined },
    now: () => new Date(),
    price: priceFor,
    routing: () => ({ routing: defaultAiRouting(), table: autoTable(null) })
  }
  const costUnknown = (): string | null => {
    if (live.local) return null
    const models = [
      ...new Set(
        ledger
          .filter(
            (entry) =>
              !entry.cached &&
              (entry.reportedCostUsd ?? null) === null &&
              !priceFor(entry.model, 0, 0).priced
          )
          .map((entry) => entry.model)
      )
    ].sort()
    return models.length === 0
      ? null
      : `cost unknown for ${models.join(', ')} (no reported cost, not on the price tables): ` +
          'the cost stop cannot hold, so the run stopped'
  }
  return {
    deps,
    ledger,
    spent: () => ledger.reduce((sum, entry) => sum + entry.costUsd, 0),
    costUnknown
  }
}

/**
 * A provider error a live run stops on and reports (a 429, a 402 when the credit runs out, a 5xx,
 * a bad key), as its code and fixed copy (never the key or the request); null for anything else,
 * which is a bug and still throws.
 */
export function liveProviderError(err: unknown): string | null {
  return err instanceof AiProviderError ? `${err.code}: ${err.message}` : null
}

/** A request and its reply as a live run saw it, kept in memory for scoring (never in a report). */
export interface CapturedCall<K extends string> {
  kind: K
  messages: AiMessage[]
  text: string
  finishReason: string | null
}

async function* recordStream<K extends string>(
  chunks: AsyncIterable<StreamChunk>,
  messages: AiMessage[],
  sink: CapturedCall<K>[],
  kindOf: (messages: AiMessage[]) => K
): AsyncGenerator<StreamChunk> {
  let text = ''
  let finishReason: string | null = null
  for await (const chunk of chunks) {
    text += chunk.delta
    if (chunk.finishReason !== undefined) finishReason = chunk.finishReason
    yield chunk
  }
  sink.push({ kind: kindOf(messages), messages, text, finishReason })
}

/**
 * The provider with every request and reply kept in `sink`, each named by `kindOf` (the live runs'
 * scores read what was sent and how it ended: the Ms Scribe run's citations, the contradictions
 * run's cut-off replies).
 */
export function recordingProvider<K extends string>(
  provider: Provider,
  sink: CapturedCall<K>[],
  kindOf: (messages: AiMessage[]) => K
): Provider {
  return {
    id: provider.id,
    resolveModel: (tier) => provider.resolveModel(tier),
    complete: async (request) => {
      const result = await provider.complete(request)
      sink.push({
        kind: kindOf(request.messages),
        messages: request.messages,
        text: result.text,
        finishReason: result.finishReason ?? null
      })
      return result
    },
    stream: (request) => recordStream(provider.stream(request), request.messages, sink, kindOf),
    testConnection: () => provider.testConnection(),
    ...(provider.price === undefined ? {} : { price: provider.price })
  }
}
