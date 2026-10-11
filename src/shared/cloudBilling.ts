import { z } from 'zod'
import { AI_MODEL_MAX, HOSTED_DEFAULT_MODELS, REASONING_MODES, ReasoningMode, Tier } from './ai'
import { OPENROUTER_PROBED_PRICES, type ProbedModelId } from './modelPrices'

/** Micro-USD (1e-6 USD) is the unit of every balance and charge (L2); a $10 pack is 10_000_000. */
export const MICROS_PER_USD = 1_000_000

/**
 * Hosted AI billing (AI-BILLING-SPEC P1–P6, L2): the server-held price table, the routing table,
 * and the integer pricing math the Worker charges with and the app estimates with. Shared so the
 * two can never disagree about a rounding rule. Every amount of money is an integer in micro-USD
 * (`MICROS_PER_USD`); prices are USD per million tokens, as the providers publish them, and are
 * turned into integers (`microsPerM`) before any arithmetic.
 */

/** A hosted model id: the gateway's (OpenRouter's) id, e.g. `openai/gpt-5.4-mini`. */
export const HostedModelId = z.string().trim().min(1).max(AI_MODEL_MAX)

/**
 * One model on the hosted price table (P1). `cachedInputUsdPerM` is null where the provider has no
 * prompt-cache discount; it may never exceed the input price, which is what keeps every charge
 * at or under its hold (P4). `displayMultiplier` is the "about 2x" label next to a non-default
 * model (E5), relative to the default model. `aliases` are older ids the app may still send
 * (the bare OpenAI names from before the gateway), resolved to this entry.
 */
export const HostedModelPrice = z
  .object({
    id: HostedModelId,
    label: z.string().trim().min(1).max(80),
    inputUsdPerM: z.number().positive(),
    outputUsdPerM: z.number().positive(),
    cachedInputUsdPerM: z.number().nonnegative().nullable(),
    displayMultiplier: z.number().positive(),
    aliases: z.array(HostedModelId).default([]),
    /**
     * 2026-10-07: how much the model may think (`ReasoningMode`), sent upstream as OpenRouter's
     * `reasoning` parameter; absent is `default` (nothing sent). Server config: the operator
     * sets it in `billing_config` once measurements say so.
     */
    reasoning: ReasoningMode.optional()
  })
  .refine(
    (price) => price.cachedInputUsdPerM === null || price.cachedInputUsdPerM <= price.inputUsdPerM,
    'The cached-input price may not exceed the input price'
  )
export type HostedModelPrice = z.infer<typeof HostedModelPrice>

/**
 * The Auto routing table (R4): what each tier runs on, plus per-feature tier overrides of the
 * app's own feature → tier choice (empty means the app's choice stands). Feature ids stay strings
 * on the wire so a Worker can name a feature an older app does not know.
 */
export const HostedRouting = z.object({
  tiers: z.object({ fast: HostedModelId, strong: HostedModelId }),
  features: z.record(z.string(), Tier).default({})
})
export type HostedRouting = z.infer<typeof HostedRouting>

/**
 * Measured cost per word of an action on the default model (E2, E3), in USD. Null until it has
 * been measured on real manuscripts (author decision 2026-10-07): the app hides every "words
 * left" and pack-example line whose constant is null.
 */
export const WordCostConstants = z.record(z.string(), z.number().positive().nullable())
export type WordCostConstants = z.infer<typeof WordCostConstants>

/**
 * The "about 2x" label of a model on the price table (E5): its price on a blend of ten input
 * tokens per output token (the shape of most of the app's requests; decided by Claude,
 * unconfirmed: QUESTIONS.md 2026-10-07), relative to `base`, the default (fast) model, rounded
 * to one decimal. F-16.1: every default entry's `displayMultiplier` is computed with it, so the
 * labels cannot drift from the prices.
 */
export function displayMultiplierOf(
  price: Pick<HostedModelPrice, 'inputUsdPerM' | 'outputUsdPerM'>,
  base: Pick<HostedModelPrice, 'inputUsdPerM' | 'outputUsdPerM'>
): number {
  const blend = (entry: typeof price): number => 10 * entry.inputUsdPerM + entry.outputUsdPerM
  return Math.round((blend(price) / blend(base)) * 10) / 10
}

/** One entry before its multiplier is computed. */
type HostedEntry = Omit<HostedModelPrice, 'displayMultiplier'>

/** A probed DeepSeek price (`src/shared/modelPrices.ts`) as a hosted entry. */
function probedEntry(id: ProbedModelId, label: string): HostedEntry {
  const price = OPENROUTER_PROBED_PRICES[id]
  return {
    id,
    label,
    inputUsdPerM: price.inUsdPerM,
    outputUsdPerM: price.outUsdPerM,
    cachedInputUsdPerM: price.cachedInUsdPerM,
    aliases: []
  }
}

const HOSTED_ENTRIES: readonly HostedEntry[] = [
  {
    ...probedEntry('deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash'),
    // F-16.2: the fast model's background JSON (summaries, the story-memory reader) runs under
    // small output caps, so it never thinks on Cloud; billing_config can still override it.
    reasoning: 'off'
  },
  probedEntry('deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro'),
  {
    id: 'openai/gpt-5.4-mini',
    label: 'GPT-5.4 mini',
    inputUsdPerM: 0.75,
    outputUsdPerM: 4.5,
    cachedInputUsdPerM: 0.075,
    aliases: ['gpt-5.4-mini']
  },
  {
    id: 'openai/gpt-5.4',
    label: 'GPT-5.4',
    inputUsdPerM: 2.5,
    outputUsdPerM: 15,
    cachedInputUsdPerM: 0.25,
    aliases: ['gpt-5.4']
  },
  {
    id: 'openai/gpt-5.4-nano',
    label: 'GPT-5.4 nano',
    inputUsdPerM: 0.2,
    outputUsdPerM: 1.25,
    cachedInputUsdPerM: 0.02,
    aliases: ['gpt-5.4-nano']
  }
]

/**
 * The defaults the Worker serves until the operator overrides a key in `billing_config`
 * (`DEFAULT_BILLING_TERMS`: cost + 25 % since 2026-10-08, no trial grant, $10 minimum pack). The default
 * models were approved by the author on 2026-10-07: DeepSeek V4 Flash (fast) and V4 Pro (strong)
 * through OpenRouter. F-16.1: their prices come from the one price module the probe regenerates
 * (`src/shared/modelPrices.ts`; the researched list prices until it runs), and every
 * `displayMultiplier` is `displayMultiplierOf` the fast default. The OpenAI models stay on sale as
 * choices (and for the bare ids older apps send).
 */
export const DEFAULT_HOSTED_MODELS: readonly HostedModelPrice[] = HOSTED_ENTRIES.map((entry) => ({
  ...entry,
  displayMultiplier: displayMultiplierOf(entry, HOSTED_ENTRIES[0] ?? entry)
}))

export const DEFAULT_HOSTED_ROUTING: HostedRouting = {
  tiers: { ...HOSTED_DEFAULT_MODELS },
  features: {}
}

/**
 * The money terms the Worker serves by default (AI-BILLING-SPEC "Config defaults", author
 * decisions 2026-10-07; changed 2026-10-08: cost + 25 %, and no free trial grant — new accounts
 * start at $0 and try hosted AI with the refundable $5 starter pack instead), in one place: the Worker's `DEFAULT_BILLING_CONFIG` spreads them, and the
 * app's bundled pricing (`bundledPricing`, used until `GET /pricing` has answered) reads them.
 */
export const DEFAULT_BILLING_TERMS = {
  appPriceUsd: 30,
  minPackUsd: 10,
  markup: 0.25,
  trialGrantUsd: 0,
  quoteThresholdUsd: 0.25,
  estimateSafetyFactor: 1.2,
  lowBalanceWarningUsd: 2,
  holdExpiryMinutes: 10,
  refundWindowDays: 30,
  requestsPerMinute: 60
} as const

export const DEFAULT_WORD_COSTS: WordCostConstants = { lineEdit: null, consistencyCheck: null }

/**
 * The reasoning mode a Cloud request runs with (F-16.2): the lower of the price table's entry and
 * what the app asked for, in `REASONING_MODES` order (`off < low < default`), with either one
 * absent read as `default`. So the app may ask for less thinking than the operator set, never
 * more. Pure, so the Worker and the app's tests share it. It assumes `default` thinks the most,
 * which holds for V4 Pro and the OpenAI reasoning models (the probe, F-16.1, checks Pro); a model
 * that does not think by default gets `off` in its table entry, so `low` can never add thinking.
 */
export function lowerReasoning(
  table: ReasoningMode | undefined,
  requested: ReasoningMode | undefined
): ReasoningMode {
  const a = REASONING_MODES.indexOf(table ?? 'default')
  const b = REASONING_MODES.indexOf(requested ?? 'default')
  return REASONING_MODES[Math.min(a, b)] ?? 'default'
}

/** The price table entry for `model`, by id or by alias; undefined for a model not on sale. */
export function findHostedModel(
  models: readonly HostedModelPrice[],
  model: string
): HostedModelPrice | undefined {
  return models.find((entry) => entry.id === model || entry.aliases.includes(model))
}

/** Prices locked for one request (P6): integers, so the charge is exact. */
export interface LockedPrices {
  /** Micro-USD per million input tokens. */
  inputMicrosPerM: number
  outputMicrosPerM: number
  /** Null: cached input is billed at the input price. */
  cachedMicrosPerM: number | null
  /** The markup in basis points: 0.20 → 2000. */
  markupBps: number
}

/** USD per million tokens → micro-USD per million tokens, an integer. */
export function microsPerM(usdPerM: number): number {
  return Math.round(usdPerM * MICROS_PER_USD)
}

/** A markup fraction → basis points: 0.2 → 2000. */
export function markupToBps(markup: number): number {
  return Math.round(markup * 10_000)
}

export function lockPrices(
  price: Pick<HostedModelPrice, 'inputUsdPerM' | 'outputUsdPerM' | 'cachedInputUsdPerM'>,
  markup: number
): LockedPrices {
  return {
    inputMicrosPerM: microsPerM(price.inputUsdPerM),
    outputMicrosPerM: microsPerM(price.outputUsdPerM),
    cachedMicrosPerM:
      price.cachedInputUsdPerM === null ? null : microsPerM(price.cachedInputUsdPerM),
    markupBps: markupToBps(markup)
  }
}

/** What the provider reported for one request; `cachedInputTokens` is part of `inputTokens`. */
export interface BilledUsage {
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
}

const MILLION = 1_000_000n
const BPS = 10_000n

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return (numerator + denominator - 1n) / denominator
}

/**
 * The exact provider cost (P2) in micro-USD per million tokens (that is, 1e-12 USD), as a BigInt:
 * the products overflow a double's exact range on a large request at a premium price.
 */
function providerCostPico(prices: LockedPrices, usage: BilledUsage): bigint {
  const cached = Math.min(Math.max(usage.cachedInputTokens, 0), usage.inputTokens)
  const cachedPrice = prices.cachedMicrosPerM ?? prices.inputMicrosPerM
  return (
    BigInt(usage.inputTokens - cached) * BigInt(prices.inputMicrosPerM) +
    BigInt(cached) * BigInt(cachedPrice) +
    BigInt(usage.outputTokens) * BigInt(prices.outputMicrosPerM)
  )
}

/** P2: what the gateway charges us, rounded up to a whole micro-USD (stored on the charge row). */
export function providerCostMicros(prices: LockedPrices, usage: BilledUsage): number {
  return Number(ceilDiv(providerCostPico(prices, usage), MILLION))
}

/** P3: `ceil(provider_cost * (1 + markup))` in micro-USD, from the unrounded provider cost. */
export function chargeMicros(prices: LockedPrices, usage: BilledUsage): number {
  const pico = providerCostPico(prices, usage)
  return Number(ceilDiv(pico * (BPS + BigInt(prices.markupBps)), MILLION * BPS))
}

/**
 * P4: the hold for a request — the charge if every input token were uncached and the answer ran
 * to `maxTokens`. Since a real request uses at most that many tokens of each kind and the cached
 * price never exceeds the input price, `chargeMicros` of the real usage can never exceed it.
 */
export function holdMicros(prices: LockedPrices, inputTokens: number, maxTokens: number): number {
  return chargeMicros(prices, { inputTokens, outputTokens: maxTokens, cachedInputTokens: 0 })
}

/** Tokens a chat template may add per message and per request (role markers, separators). */
const TEMPLATE_TOKENS_PER_MESSAGE = 16
const TEMPLATE_TOKENS_PER_REQUEST = 16

/**
 * A guaranteed upper bound on the input tokens of `messages`, for the hold: every token of a
 * byte-level tokenizer covers at least one byte of UTF-8, plus the chat template's own tokens.
 * Deliberately pessimistic (English prose is about four bytes per token): the hold is released
 * minutes later, and an underestimate is the one thing that could let a charge exceed it.
 */
export function inputTokenUpperBound(messages: readonly { content: string }[]): number {
  const encoder = new TextEncoder()
  let bytes = 0
  for (const message of messages) bytes += encoder.encode(message.content).length
  return bytes + messages.length * TEMPLATE_TOKENS_PER_MESSAGE + TEMPLATE_TOKENS_PER_REQUEST
}

/** USD (a config value) → micro-USD, the unit of every balance. */
export function usdToMicros(usd: number): number {
  return Math.round(usd * MICROS_PER_USD)
}

/**
 * A fair token estimate from characters (about four per token for English prose), for the one
 * case the gateway reports no usage for an answer it delivered. Never used for the hold.
 */
export function estimateTokensFromChars(chars: number): number {
  return Math.ceil(chars / 4)
}
