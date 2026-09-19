import { DEFAULT_MODELS, MODEL_PRICING, type Tier } from './ai'

/**
 * The published MythScribe Cloud rates (F-15.3): one rate per model, the provider price from
 * `MODEL_PRICING` times a margin. The desktop app shows this table before the author picks a
 * tier; the Cloud Worker imports the same module to meter every request, so there is exactly
 * one rate and it changes in one place. Amounts are USD per million tokens, like the provider's.
 */

/** The margin over the provider price: 2x covers the proxy, the merchant fees, and refunds. A starting number (PLAN.md §4.2). */
export const CLOUD_RATE_MULTIPLIER = 2

/** Micro-USD (1e-6 USD) is the unit of every balance and charge; a $5 pack is 5_000_000. */
export const MICROS_PER_USD = 1_000_000

export interface CloudRate {
  model: string
  inUsdPerM: number
  outUsdPerM: number
  /** False for a model `MODEL_PRICING` does not know; such a model cannot be billed and is never answered with. */
  priced: boolean
}

/** The Cloud rate for one model; an unknown model answers 0 with `priced: false`. */
export function cloudRateFor(model: string): CloudRate {
  const price = MODEL_PRICING[model]
  if (price === undefined) return { model, inUsdPerM: 0, outUsdPerM: 0, priced: false }
  return {
    model,
    inUsdPerM: price.inUsdPerM * CLOUD_RATE_MULTIPLIER,
    outUsdPerM: price.outUsdPerM * CLOUD_RATE_MULTIPLIER,
    priced: price.priced
  }
}

/**
 * What one request costs in micro-USD, rounded up so a priced answer is never free (at least 1).
 * Throws for an unpriced model: the proxy must refuse to answer with a model it cannot bill
 * rather than give it away.
 */
export function cloudChargeMicros(model: string, tokensIn: number, tokensOut: number): number {
  const rate = cloudRateFor(model)
  if (!rate.priced) throw new Error(`No MythScribe Cloud rate for model "${model}"`)
  const usd = (tokensIn * rate.inUsdPerM + tokensOut * rate.outUsdPerM) / 1_000_000
  return Math.max(1, Math.ceil(usd * MICROS_PER_USD))
}

/**
 * What a request costs the author when it went through MythScribe Cloud (F-15.4): the same
 * shape as `priceFor`, at the Cloud rate, so the cost line under a proposal reads in dollars
 * whichever path answered it. Unlike `cloudChargeMicros` this never throws: it prices what the
 * meter already charged, and a model outside the table reads as unpriced, never as free.
 */
export function cloudPriceFor(
  model: string,
  inTok: number,
  outTok: number
): { costUsd: number; priced: boolean } {
  const rate = cloudRateFor(model)
  if (!rate.priced) return { costUsd: 0, priced: false }
  return {
    costUsd: cloudChargeMicros(model, inTok, outTok) / MICROS_PER_USD,
    priced: true
  }
}

export interface PublishedCloudRate extends CloudRate {
  /** The tiers this model is the default for (F-5.11), so the table reads "fast" and "strong". */
  tiers: Tier[]
}

/** The rate table the app publishes: every priced model, defaults first. */
export const CLOUD_RATES: readonly PublishedCloudRate[] = Object.keys(MODEL_PRICING)
  .map((model) => ({
    ...cloudRateFor(model),
    tiers: (Object.keys(DEFAULT_MODELS) as Tier[]).filter((tier) => DEFAULT_MODELS[tier] === model)
  }))
  .filter((rate) => rate.priced)
  .sort(
    (a, b) => Number(b.tiers.length > 0) - Number(a.tiers.length > 0) || a.inUsdPerM - b.inUsdPerM
  )
