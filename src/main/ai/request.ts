import { createHash } from 'node:crypto'
import {
  estimateTokens,
  inputBudget,
  outputBudget,
  priceFor,
  type AiFeatureId,
  type Tier
} from '@shared/ai'
import type { AppStateStore } from '../appState/appStateStore'
import { getCached, putCached, type CacheEntry, type CachedResponse } from './cacheStore'
import { dayOf, rollIfNewDay, spend, wouldExceed, type AiUsageState } from './dailyCap'
import {
  AiBudgetError,
  NoKeyError,
  type AiMessage,
  type CompletionUsage,
  type Provider
} from './providers/types'
import type { PromptVersion } from './prompts/catalogue'
import { insertUsage, type AiDb, type UsageEntry } from './usageStore'

/**
 * The one request path every AI feature calls (F-5.14). In order: clamp the output to the
 * feature's budget, refuse an over-budget prompt, refuse what the daily cap cannot afford
 * (estimated before anything is sent), answer from the local cache, call the provider, price
 * the real usage, write the ledger row and the cache row, add to the day's tally. Refusals
 * (`AiBudgetError`) and provider failures write nothing: nothing was spent. The AI dial
 * (F-14.4) gates the callers, not this path, which knows nothing about data-sharing classes.
 *
 * The cache is only as correct as `contextHash`: it must cover everything that shaped the
 * messages (voice profile, brief, retrieved passages, sampling settings). This path adds the
 * feature, prompt version, model, and a hash of the messages themselves, so a caller that
 * hashes too little still never serves one feature's answer to another or an old model's to a
 * new one, but it cannot tell whether the caller's context changed underneath the same hash.
 */
export interface AiRequestInput {
  feature: AiFeatureId
  tier: Tier
  messages: AiMessage[]
  /** The feature's own cap; clamped to `outputBudget(feature)`. */
  maxTokens: number
  json?: boolean
  /** Sampling temperature, forwarded to the provider; the preset's for prose features (F-5.2). */
  temperature?: number
  /** From the context builder: a hash of everything that shaped `messages`. */
  contextHash: string
  /** The catalogued prompt version the messages were built from (F-5.12); the ledger and the proposal record it. */
  promptVersion: PromptVersion
}

export interface AiRequestResult {
  text: string
  /** The model the tier resolved to when the request left (the ledger and the price use it). */
  model: string
  usage: CompletionUsage
  /** What this request cost; 0 for a cache hit or an unpriced model. */
  costUsd: number
  cached: boolean
  /** False when the model is outside `MODEL_PRICING`, so a 0 is "unknown", not "free". */
  priced: boolean
}

/** Everything the path touches, so tests run it over fakes and production binds the real stores. */
export interface AiRequestDeps {
  providers: { get(): Provider | null }
  ledger: { insert(entry: UsageEntry): void }
  cache: {
    get(key: string): CachedResponse | undefined
    put(entry: CacheEntry): void
  }
  dailyCap: {
    /** The state for today (already rolled to the current day). */
    get(): AiUsageState
    spend(amount: { costUsd: number; tokens: number }): void
  }
  now: () => Date
  price: typeof priceFor
}

/** What the shared pre-checks settle before either path calls the provider. */
interface PreparedRequest {
  provider: Provider
  model: string
  maxTokens: number
  /** The local estimate of the prompt, what the input budget was checked against. */
  estimatedIn: number
  key: string
  /** The ledger and cache columns both paths write. */
  base: Omit<
    UsageEntry,
    'at' | 'promptTokens' | 'completionTokens' | 'cachedTokens' | 'costUsd' | 'cached'
  >
}

/**
 * The pre-checks in order: a provider (a saved key), the output clamp, the input budget, the
 * daily cap. Throws `NoKeyError` or `AiBudgetError`; nothing is spent or written.
 */
function prepare(deps: AiRequestDeps, input: AiRequestInput): PreparedRequest {
  const provider = deps.providers.get()
  if (!provider) throw new NoKeyError('No API key is saved.')
  const maxTokens = Math.min(input.maxTokens, outputBudget(input.feature))
  const model = provider.resolveModel(input.tier)

  const estimatedIn = estimateTokens(input.messages.map((m) => m.content).join('\n'))
  const promptBudget = inputBudget(input.feature)
  if (estimatedIn > promptBudget) {
    throw new AiBudgetError(
      `This request is over the ${input.feature} budget (about ${estimatedIn} of ${promptBudget} tokens).`
    )
  }

  const day = deps.dailyCap.get()
  const estimatedCost = deps.price(model, estimatedIn, maxTokens).costUsd
  if (wouldExceed(day, estimatedCost, dayOf(deps.now()))) {
    throw new AiBudgetError(
      `This request would take today's AI spend over the ${day.dailyCapUsd.toFixed(2)} USD cap.`
    )
  }

  return {
    provider,
    model,
    maxTokens,
    estimatedIn,
    key: cacheKey(input, model),
    base: {
      feature: input.feature,
      tier: input.tier,
      model,
      provider: provider.id,
      promptVersion: input.promptVersion,
      contextHash: input.contextHash
    }
  }
}

/** A cache hit: a zero-cost ledger row, a free request on the day's tally, the stored answer. */
function serveCached(
  deps: AiRequestDeps,
  prepared: PreparedRequest,
  hit: CachedResponse
): AiRequestResult {
  deps.ledger.insert({
    ...prepared.base,
    at: deps.now().toISOString(),
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: null,
    costUsd: 0,
    cached: true
  })
  deps.dailyCap.spend({ costUsd: 0, tokens: 0 })
  return {
    text: hit.text,
    model: prepared.model,
    usage: hit.usage,
    costUsd: 0,
    cached: true,
    priced: true
  }
}

/** The post-steps after the provider answered: price, ledger row, cache row, the day's tally. */
function record(
  deps: AiRequestDeps,
  input: AiRequestInput,
  prepared: PreparedRequest,
  answer: { text: string; usage: CompletionUsage }
): AiRequestResult {
  const { model, key } = prepared
  const { costUsd, priced } = deps.price(model, answer.usage.inputTokens, answer.usage.outputTokens)
  const at = deps.now().toISOString()
  const tokens = answer.usage.inputTokens + answer.usage.outputTokens
  deps.ledger.insert({
    ...prepared.base,
    at,
    promptTokens: answer.usage.inputTokens,
    completionTokens: answer.usage.outputTokens,
    cachedTokens: null,
    costUsd,
    cached: false
  })
  deps.cache.put({
    key,
    feature: input.feature,
    promptVersion: input.promptVersion,
    model,
    text: answer.text,
    usage: answer.usage,
    createdAt: at
  })
  deps.dailyCap.spend({ costUsd, tokens })
  return { text: answer.text, model, usage: answer.usage, costUsd, cached: false, priced }
}

export async function runAiRequest(
  deps: AiRequestDeps,
  input: AiRequestInput
): Promise<AiRequestResult> {
  const prepared = prepare(deps, input)
  const hit = deps.cache.get(prepared.key)
  if (hit) return serveCached(deps, prepared, hit)

  const result = await prepared.provider.complete({
    tier: input.tier,
    messages: input.messages,
    maxTokens: prepared.maxTokens,
    json: input.json,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature })
  })
  return record(deps, input, prepared, { text: result.text, usage: result.usage })
}

/**
 * The streamed form of `runAiRequest` (F-5.4, Plan-mode chat): the same pre-checks and the
 * same post-steps, with every piece of the answer handed to `onDelta` as it arrives and the
 * whole answer resolved at the end so the caller can store it. A cache hit hands the stored
 * text over as one delta. The usage comes from the stream's final chunk; a provider that
 * carries none is priced from the local estimate (the prompt's, and `estimateTokens` over the
 * answer), so the ledger and the cap never skip a streamed request. A provider error at the
 * first pull or mid-stream propagates like `complete`'s: nothing is logged or cached, and the
 * deltas already shown are the caller's to discard.
 */
export async function runAiStream(
  deps: AiRequestDeps,
  input: AiRequestInput,
  onDelta: (delta: string) => void
): Promise<AiRequestResult> {
  const prepared = prepare(deps, input)
  const hit = deps.cache.get(prepared.key)
  if (hit) {
    if (hit.text) onDelta(hit.text)
    return serveCached(deps, prepared, hit)
  }

  let text = ''
  let usage: CompletionUsage | undefined
  const chunks = prepared.provider.stream({
    tier: input.tier,
    messages: input.messages,
    maxTokens: prepared.maxTokens,
    json: input.json,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature })
  })
  for await (const chunk of chunks) {
    if (chunk.delta) {
      text += chunk.delta
      onDelta(chunk.delta)
    }
    if (chunk.usage) usage = chunk.usage
  }
  return record(deps, input, prepared, {
    text,
    usage: usage ?? { inputTokens: prepared.estimatedIn, outputTokens: estimateTokens(text) }
  })
}

/** The stored cache key: the feature, prompt version, model, context hash, and the messages themselves. */
export function cacheKey(
  input: Pick<AiRequestInput, 'feature' | 'promptVersion' | 'contextHash' | 'messages' | 'json'>,
  model: string
): string {
  const messages = sha256(JSON.stringify(input.messages))
  return sha256(
    [
      input.feature,
      input.promptVersion,
      model,
      input.contextHash,
      messages,
      input.json ? 'json' : 'text'
    ].join('|')
  )
}

/** Hex SHA-256; the cache key and the callers' `contextHash` share it. */
export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/** The production deps: the open project's database for the ledger and cache, app state for the cap. */
export function buildAiRequestDeps(bind: {
  db: AiDb
  providers: { get(): Provider | null }
  appState: AppStateStore
  now?: () => Date
}): AiRequestDeps {
  const now = bind.now ?? ((): Date => new Date())
  return {
    providers: bind.providers,
    ledger: { insert: (entry) => insertUsage(bind.db, entry) },
    cache: { get: (key) => getCached(bind.db, key), put: (entry) => putCached(bind.db, entry) },
    dailyCap: {
      get: () => rollIfNewDay(bind.appState.get().aiUsage, dayOf(now())),
      spend: (amount) => {
        bind.appState.update((s) => ({ ...s, aiUsage: spend(s.aiUsage, amount, dayOf(now())) }))
      }
    },
    now,
    price: priceFor
  }
}
