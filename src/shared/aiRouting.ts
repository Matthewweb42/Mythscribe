import { z } from 'zod'
import { AI_FEATURE_IDS, AiFeatureId, ReasoningMode, Tier, bundledReasoning } from './ai'
import { PricingResult } from './cloudApi'

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
 * (`hostedAutoTable` of `GET /pricing`), which wins on Cloud for the features it names.
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
  agent: 'strong',
  todo: 'fast',
  sheetSync: 'fast'
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
  features: LenientTierTable.default({}),
  /**
   * 2026-10-07: the reasoning mode per tier on an own key (`ReasoningMode`); a tier not listed
   * follows the bundled price table (`bundledReasoning`). MythScribe Cloud uses its server table.
   */
  reasoning: z.partialRecord(Tier, ReasoningMode).catch({}).default({})
})
export type AiRouting = z.infer<typeof AiRouting>

export function defaultAiRouting(): AiRouting {
  return { all: null, features: {}, reasoning: {} }
}

/** The reasoning mode a request on `tier` asks `model` for: the author's choice, else the table's. */
export function resolveReasoning(routing: AiRouting, tier: Tier, model: string): ReasoningMode {
  return routing.reasoning[tier] ?? bundledReasoning(model)
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
 * The hosted Auto table (R4) out of the one pricing shape the Worker serves (`PricingResult`,
 * `GET /pricing`): its per-feature tier overrides, with any feature id or tier this build does
 * not know dropped. Merged over `DEFAULT_ROUTING_TABLE` by `autoTable`.
 */
export function hostedAutoTable(
  pricing: PricingResult | null
): Partial<Record<AiFeatureId, Tier>> | null {
  return pricing === null ? null : LenientTierTable.parse(pricing.routing.features)
}

/**
 * The cached copy main keeps in app state: the Worker's `GET /pricing` answer and when it was
 * fetched. A copy in an older shape fails to parse and reads as no cache (`appStateStore`).
 */
export const CloudPricingCache = z.object({
  fetchedAt: z.string(),
  pricing: PricingResult
})
export type CloudPricingCache = z.infer<typeof CloudPricingCache>

/** What Settings › AI reads and writes for model choice: the overrides and the hosted table. */
export const AiModelChoice = z.object({
  routing: AiRouting,
  cloudPricing: PricingResult.nullable()
})
export type AiModelChoice = z.infer<typeof AiModelChoice>
