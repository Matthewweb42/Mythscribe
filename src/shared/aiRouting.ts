import { z } from 'zod'
import {
  AI_FEATURE_IDS,
  AiFeatureId,
  AiModelMap,
  ModelName,
  Tier,
  costOf,
  type ModelPrice
} from './ai'

/**
 * Model choice (AI-BILLING-SPEC M8, R4; decided 2026-10-07): features still request a tier,
 * never a model name (CLAUDE.md, token rule 1), and a routing table decides which tier a task
 * gets. "Auto" is that table; the author can override it for one task or for every task in
 * Settings › AI. The tier then maps to the source's model as before (F-5.11), so a choice made
 * here works on every source (own key, Cloud, local) without naming a model per source.
 */

/**
 * The Auto table bundled with the app: the tier each feature's call site has always asked for,
 * so Auto changes nothing on its own. Continuity and edit passes pick their tier per request
 * (background or on demand; per pass type, `EDIT_PASS_TIER`), so they are absent and keep the
 * caller's tier unless the author overrides them. MythScribe Cloud may send its own table
 * (`CloudPricing.routing`), which wins on Cloud for the features it names.
 */
export const DEFAULT_ROUTING_TABLE: Partial<Record<AiFeatureId, Tier>> = {
  ghostText: 'fast',
  tags: 'fast',
  summary: 'fast',
  chat: 'fast',
  query: 'strong',
  critique: 'strong',
  rewrite: 'fast',
  brief: 'fast',
  betaReader: 'strong',
  importStructure: 'fast',
  proofread: 'fast',
  whatNext: 'fast',
  route: 'fast',
  synopsis: 'fast',
  notesSuggest: 'fast',
  voiceNotes: 'fast',
  agent: 'strong'
}

/** A stored table read leniently: a feature id or a tier this build does not know is dropped. */
const LenientTierTable = z
  .record(z.string(), z.unknown())
  .transform((stored) =>
    Object.fromEntries(
      Object.entries(stored).filter(
        ([feature, tier]) => AiFeatureId.safeParse(feature).success && Tier.safeParse(tier).success
      )
    )
  )
  .pipe(z.partialRecord(AiFeatureId, Tier))

/** The author's overrides, app-wide (like the models): one tier for every task, and per task. */
export const AiRouting = z.object({
  /** Every task on this tier; null is Auto (the routing table, then the per-task overrides). */
  all: Tier.nullable().default(null),
  /** Per-task overrides; a task not listed follows `all`, then Auto. */
  features: LenientTierTable.default({})
})
export type AiRouting = z.infer<typeof AiRouting>

export function defaultAiRouting(): AiRouting {
  return { all: null, features: {} }
}

/** What Settings says for each choice. */
export const ROUTE_CHOICE_LABEL = {
  auto: 'Auto',
  fast: 'Fast model',
  strong: 'Strong model'
} as const

/**
 * The tier a request goes out on. Most specific first: the author's per-task override, then
 * their one-tier-for-everything override, then the Auto table (the server's on Cloud, merged
 * over the bundled one), then the tier the feature asked for.
 */
export function resolveTier(input: {
  feature: AiFeatureId
  requested: Tier
  routing: AiRouting
  table: Partial<Record<AiFeatureId, Tier>>
}): Tier {
  return (
    input.routing.features[input.feature] ??
    input.routing.all ??
    input.table[input.feature] ??
    input.requested
  )
}

/** The Auto table in effect: the server's entries over the bundled ones on Cloud. */
export function autoTable(
  cloudTable: Partial<Record<AiFeatureId, Tier>> | null
): Partial<Record<AiFeatureId, Tier>> {
  return cloudTable === null
    ? { ...DEFAULT_ROUTING_TABLE }
    : { ...DEFAULT_ROUTING_TABLE, ...cloudTable }
}

/** The features Settings lists for a per-task override: every feature id, in spec order. */
export const ROUTABLE_FEATURES: readonly AiFeatureId[] = AI_FEATURE_IDS.filter(
  (id) => id !== 'authorMode' && id !== 'embeddings'
)

/**
 * One model in the MythScribe Cloud price table (AI-BILLING-SPEC P1): the provider's price per
 * million tokens (input, output, cached input when the model has one) and the display
 * multiplier against the default model (E5), e.g. 2 for "about 2x".
 */
export const CloudModelPrice = z.object({
  model: ModelName,
  inUsdPerM: z.number().nonnegative(),
  outUsdPerM: z.number().nonnegative(),
  cachedInUsdPerM: z.number().nonnegative().nullable().default(null),
  multiplier: z.number().positive().nullable().default(null)
})
export type CloudModelPrice = z.infer<typeof CloudModelPrice>

/**
 * What `GET /pricing` answers (AI-BILLING-SPEC P1, P5, config defaults; the Worker side is slice
 * B2): everything hosted billing shows or prices, changeable on the server without an app
 * release. Optional fields carry the spec's defaults so a server that omits one still parses;
 * unknown fields are ignored, so the server can add more without breaking older apps.
 */
export const CloudPricing = z.object({
  /** Markup over provider cost (0.2 = 20 %). */
  markup: z.number().min(0).max(10),
  models: z.array(CloudModelPrice).max(500),
  /** The hosted default model per tier, when the server names one. */
  defaults: AiModelMap.nullable().default(null),
  /** The hosted Auto table; merged over `DEFAULT_ROUTING_TABLE`. */
  routing: LenientTierTable.default({}),
  packsUsd: z.array(z.number().positive()).max(20).default([10, 25, 50]),
  trialGrantUsd: z.number().nonnegative().default(2),
  quoteThresholdUsd: z.number().nonnegative().default(0.25),
  estimateSafetyFactor: z.number().min(1).max(10).default(1.2),
  lowBalanceWarningUsd: z.number().nonnegative().default(2),
  /**
   * Measured USD per word for an action on the default model (E2, E3), e.g. `lineEdit`. A null
   * or missing constant hides the line that would use it: nothing is guessed.
   */
  perWordUsd: z.record(z.string(), z.number().positive().nullable()).default({})
})
export type CloudPricing = z.infer<typeof CloudPricing>

/** The cached copy main keeps in app state: the table and when it was fetched. */
export const CloudPricingCache = z.object({
  fetchedAt: z.string(),
  pricing: CloudPricing
})
export type CloudPricingCache = z.infer<typeof CloudPricingCache>

/** Micro-USD per USD; hosted charges are whole micro-dollars (AI-BILLING-SPEC L2). */
const MICROS = 1_000_000

/**
 * What a hosted request costs the author at the server's table (AI-BILLING-SPEC P2, P3, R6):
 * provider cost with cached input at its own price, times (1 + markup), rounded up to a whole
 * micro-dollar and never free. A model outside the table is unpriced, never free.
 */
export function hostedPriceFor(
  pricing: CloudPricing,
  model: string,
  inTok: number,
  outTok: number,
  cachedInTok = 0
): { costUsd: number; priced: boolean } {
  const rate = pricing.models.find((entry) => entry.model === model)
  if (rate === undefined) return { costUsd: 0, priced: false }
  const price: Pick<ModelPrice, 'inUsdPerM' | 'outUsdPerM' | 'cachedInUsdPerM'> = {
    inUsdPerM: rate.inUsdPerM,
    outUsdPerM: rate.outUsdPerM,
    ...(rate.cachedInUsdPerM === null ? {} : { cachedInUsdPerM: rate.cachedInUsdPerM })
  }
  const usd = costOf(price, inTok, outTok, cachedInTok) * (1 + pricing.markup)
  return { costUsd: Math.max(1, Math.ceil(usd * MICROS - 1e-6)) / MICROS, priced: true }
}

/** "about 2x" for a model the server marks with a multiplier other than 1 (E5); null otherwise. */
export function multiplierLabel(pricing: CloudPricing | null, model: string): string | null {
  const rate = pricing?.models.find((entry) => entry.model === model)
  if (rate?.multiplier == null || Math.abs(rate.multiplier - 1) < 0.05) return null
  const shown =
    rate.multiplier >= 10 ? Math.round(rate.multiplier) : Math.round(rate.multiplier * 10) / 10
  return `about ${shown}x`
}

/** What Settings › AI reads and writes for model choice: the overrides and the hosted table. */
export const AiModelChoice = z.object({
  routing: AiRouting,
  cloudPricing: CloudPricing.nullable()
})
export type AiModelChoice = z.infer<typeof AiModelChoice>
