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
  /** From the context builder: a hash of everything that shaped `messages`. */
  contextHash: string
  /** The prompt template version (F-5.12); undefined until prompts are versioned. */
  promptVersion?: string
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

export async function runAiRequest(
  deps: AiRequestDeps,
  input: AiRequestInput
): Promise<AiRequestResult> {
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

  const promptVersion = input.promptVersion ?? null
  const key = cacheKey(input, model)
  const base = {
    feature: input.feature,
    tier: input.tier,
    model,
    provider: provider.id,
    promptVersion,
    contextHash: input.contextHash
  }

  const hit = deps.cache.get(key)
  if (hit) {
    deps.ledger.insert({
      ...base,
      at: deps.now().toISOString(),
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: null,
      costUsd: 0,
      cached: true
    })
    deps.dailyCap.spend({ costUsd: 0, tokens: 0 })
    return { text: hit.text, model, usage: hit.usage, costUsd: 0, cached: true, priced: true }
  }

  const result = await provider.complete({
    tier: input.tier,
    messages: input.messages,
    maxTokens,
    json: input.json
  })
  const { costUsd, priced } = deps.price(model, result.usage.inputTokens, result.usage.outputTokens)
  const at = deps.now().toISOString()
  const tokens = result.usage.inputTokens + result.usage.outputTokens
  deps.ledger.insert({
    ...base,
    at,
    promptTokens: result.usage.inputTokens,
    completionTokens: result.usage.outputTokens,
    cachedTokens: null,
    costUsd,
    cached: false
  })
  deps.cache.put({
    key,
    feature: input.feature,
    promptVersion,
    model,
    text: result.text,
    usage: result.usage,
    createdAt: at
  })
  deps.dailyCap.spend({ costUsd, tokens })
  return { text: result.text, model, usage: result.usage, costUsd, cached: false, priced }
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
      input.promptVersion ?? '',
      model,
      input.contextHash,
      messages,
      input.json ? 'json' : 'text'
    ].join('|')
  )
}

function sha256(text: string): string {
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
