import { HOSTED_DEFAULT_MODELS, LEGACY_HOSTED_DEFAULT_MODELS, type Tier } from './ai'
import {
  AI_COMPLETE_MAX_CHARS,
  AI_COMPLETE_MAX_TOKENS,
  type CreditOffer,
  type PricingModel,
  type PricingResult
} from './cloudApi'
import {
  chargeMicros,
  DEFAULT_BILLING_TERMS,
  DEFAULT_HOSTED_MODELS,
  DEFAULT_HOSTED_ROUTING,
  DEFAULT_WORD_COSTS,
  lockPrices,
  MICROS_PER_USD,
  usdToMicros
} from './cloudBilling'

/**
 * The app's side of hosted billing (AI-BILLING-SPEC P5, E1–E6, C4; slice B3b): what the desktop
 * app prices, quotes, labels, and estimates with, always from the one pricing shape the Worker
 * serves (`PricingResult`, `GET /pricing`) and the same integer math the Worker charges with
 * (`cloudBilling.ts`), so a quote and a charge can never disagree about a rounding rule. Until the
 * Worker has answered once, `bundledPricing()` stands in, built from the same defaults the Worker
 * seeds its config with; nothing here hardcodes a price of its own.
 */

/** The pricing the app uses before `GET /pricing` has answered: the Worker's own defaults. */
export function bundledPricing(): PricingResult {
  const terms = DEFAULT_BILLING_TERMS
  return {
    currency: 'USD',
    markup: terms.markup,
    appPriceMicros: usdToMicros(terms.appPriceUsd),
    minPackMicros: usdToMicros(terms.minPackUsd),
    // The packs on sale come from `/credits` (with their Lemon Squeezy variants), never from here.
    packs: [],
    trialGrantMicros: usdToMicros(terms.trialGrantUsd),
    quoteThresholdMicros: usdToMicros(terms.quoteThresholdUsd),
    estimateSafetyFactor: terms.estimateSafetyFactor,
    lowBalanceWarningMicros: usdToMicros(terms.lowBalanceWarningUsd),
    holdExpiryMinutes: terms.holdExpiryMinutes,
    refundWindowDays: terms.refundWindowDays,
    limits: {
      requestsPerMinute: terms.requestsPerMinute,
      maxInputChars: AI_COMPLETE_MAX_CHARS,
      maxOutputTokens: AI_COMPLETE_MAX_TOKENS
    },
    models: DEFAULT_HOSTED_MODELS.map((model) => ({
      id: model.id,
      label: model.label,
      inputUsdPerM: model.inputUsdPerM,
      outputUsdPerM: model.outputUsdPerM,
      cachedInputUsdPerM: model.cachedInputUsdPerM,
      displayMultiplier: model.displayMultiplier
    })),
    routing: {
      tiers: { ...DEFAULT_HOSTED_ROUTING.tiers },
      features: { ...DEFAULT_HOSTED_ROUTING.features }
    },
    wordCosts: { ...DEFAULT_WORD_COSTS }
  }
}

/** The price table entry for `model`, by the gateway id the Worker publishes. */
export function hostedModel(pricing: PricingResult, model: string): PricingModel | undefined {
  return pricing.models.find((entry) => entry.id === model)
}

/**
 * What one answered hosted request cost the author (P2, P3, R6): exactly what the Worker charges,
 * in USD. A model outside the table is unpriced, never free.
 */
export function hostedPriceFor(
  pricing: PricingResult,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0
): { costUsd: number; priced: boolean } {
  const entry = hostedModel(pricing, model)
  if (entry === undefined) return { costUsd: 0, priced: false }
  const micros = chargeMicros(lockPrices(entry, pricing.markup), {
    inputTokens,
    outputTokens,
    cachedInputTokens
  })
  return { costUsd: micros / MICROS_PER_USD, priced: true }
}

/** A displayed estimate of a hosted job (E4, hosted request flow 2, R3). */
export interface HostedQuote {
  /** The charge at the table's price, padded by the safety factor; 0 when unpriced. */
  costUsd: number
  priced: boolean
  /** Above the quote threshold: the app shows the quote and waits for a confirm before sending. */
  needsConfirm: boolean
}

/**
 * The quote for a hosted job of `inputTokens` in and at most `outputTokens` out (a chunked job
 * passes the sum of its chunks, R3): the charge with no cache discount, times the safety factor
 * (E4), rounded up to a whole micro-dollar.
 */
export function hostedQuote(
  pricing: PricingResult,
  model: string,
  inputTokens: number,
  outputTokens: number
): HostedQuote {
  const entry = hostedModel(pricing, model)
  if (entry === undefined) return { costUsd: 0, priced: false, needsConfirm: false }
  const charge = chargeMicros(lockPrices(entry, pricing.markup), {
    inputTokens,
    outputTokens,
    cachedInputTokens: 0
  })
  const quoted = Math.ceil(charge * pricing.estimateSafetyFactor)
  return {
    costUsd: quoted / MICROS_PER_USD,
    priced: true,
    needsConfirm: quoted > pricing.quoteThresholdMicros
  }
}

/**
 * "about 2x" next to a model the server marks with a multiplier against the default model (E5);
 * null for the default model itself, for one within 5 % of it, and for a model the table lacks.
 */
export function multiplierLabel(pricing: PricingResult | null, model: string): string | null {
  const entry = pricing === null ? undefined : hostedModel(pricing, model)
  if (entry === undefined || Math.abs(entry.displayMultiplier - 1) < 0.05) return null
  const shown =
    entry.displayMultiplier >= 10
      ? Math.round(entry.displayMultiplier)
      : Math.round(entry.displayMultiplier * 10) / 10
  return `about ${shown}x`
}

/**
 * The model a hosted request asks for (R4, P5). A tier the author left at a default (today's, or
 * the OpenAI one stored before 2026-10-07) follows the server's routing table, so a default
 * changed on the Worker needs no app release; a model the author typed is sent as typed.
 */
export function hostedModelFor(tier: Tier, chosen: string, pricing: PricingResult | null): string {
  const isDefault =
    chosen === HOSTED_DEFAULT_MODELS[tier] || chosen === LEGACY_HOSTED_DEFAULT_MODELS[tier]
  if (!isDefault) return chosen
  return pricing?.routing.tiers[tier] ?? HOSTED_DEFAULT_MODELS[tier]
}

/** Whole dollars without cents ("$5"), others with them ("$7.50"). */
function dollarsFromCents(cents: number): string {
  return cents % 100 === 0 ? `$${cents / 100}` : `$${(cents / 100).toFixed(2)}`
}

/**
 * The starter pack offer (author copy, 2026-10-08): "Try the AI for $5. Any unused balance is
 * refundable for 30 days." The refund sentence is left out when the window is zero.
 */
export function starterOfferText(priceCents: number, refundWindowDays: number): string {
  const offer = `Try the AI for ${dollarsFromCents(priceCents)}.`
  if (refundWindowDays <= 0) return offer
  const days = refundWindowDays === 1 ? '1 day' : `${refundWindowDays} days`
  return `${offer} Any unused balance is refundable for ${days}.`
}

/**
 * What a hosted request refused for its balance says (2026-10-08): the starter offer while the
 * account may buy it, why it is blocked when the balance is below zero, and otherwise that the
 * balance is too low. An older Worker sends no offer.
 */
export function noBalanceText(offer: CreditOffer | undefined): string {
  if (offer?.kind === 'starter') return starterOfferText(offer.priceCents, offer.refundWindowDays)
  if (offer?.kind === 'packs' && offer.negative) {
    return 'Your MythScribe Cloud balance is below zero after a refund or a dispute.'
  }
  return 'Your MythScribe Cloud balance is too low for this request.'
}

/** The actions the per-word constants are measured for (E2, E3), with how the app names them. */
export const WORD_COST_ACTIONS = {
  lineEdit: 'line editing',
  consistencyCheck: 'consistency checking'
} as const
export type WordCostAction = keyof typeof WORD_COST_ACTIONS

/**
 * About how many words of `action` an amount covers on the default model (E2, E3), padded by the
 * safety factor (E4) and rounded down to two significant figures; null when the constant has not
 * been measured (author decision 2026-10-07: a null constant hides the line, nothing is guessed).
 */
export function wordsCovered(
  pricing: PricingResult,
  micros: number,
  action: WordCostAction
): number | null {
  const perWordUsd = pricing.wordCosts[action]
  if (perWordUsd === null || perWordUsd === undefined || micros <= 0) return null
  const words = micros / MICROS_PER_USD / (perWordUsd * pricing.estimateSafetyFactor)
  if (words < 1) return 0
  const magnitude = 10 ** Math.max(0, Math.floor(Math.log10(words)) - 1)
  return Math.floor(words / magnitude) * magnitude
}
