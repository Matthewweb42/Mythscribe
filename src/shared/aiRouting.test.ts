import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS } from './ai'
import {
  AiRouting,
  CloudPricing,
  DEFAULT_ROUTING_TABLE,
  ROUTABLE_FEATURES,
  autoTable,
  defaultAiRouting,
  hostedPriceFor,
  multiplierLabel,
  resolveTier
} from './aiRouting'

const PRICING = CloudPricing.parse({
  markup: 0.2,
  models: [
    { model: 'cheap/fast', inUsdPerM: 1, outUsdPerM: 2, cachedInUsdPerM: 0.1, multiplier: 1 },
    { model: 'big/strong', inUsdPerM: 3, outUsdPerM: 15, multiplier: 2.4 }
  ],
  routing: { summary: 'strong', someFutureFeature: 'fast', chat: 'medium' }
})

describe('model routing (AI-BILLING-SPEC M8, R4)', () => {
  it('Auto keeps the tier every feature asked for before routing existed', () => {
    const auto = defaultAiRouting()
    for (const [feature, tier] of Object.entries(DEFAULT_ROUTING_TABLE)) {
      const id = feature as keyof typeof DEFAULT_ROUTING_TABLE
      expect(
        resolveTier({ feature: id, requested: tier, routing: auto, table: autoTable(null) })
      ).toBe(tier)
    }
    // Absent from the table: the caller's tier (edit passes pick theirs per pass type).
    expect(
      resolveTier({ feature: 'editPass', requested: 'fast', routing: auto, table: autoTable(null) })
    ).toBe('fast')
  })

  it('orders the overrides: per task, then every task, then the table, then the caller', () => {
    const table = autoTable(null)
    const routing: AiRouting = { all: 'strong', features: { tags: 'fast' } }
    expect(resolveTier({ feature: 'tags', requested: 'strong', routing, table })).toBe('fast')
    expect(resolveTier({ feature: 'summary', requested: 'fast', routing, table })).toBe('strong')
    expect(
      resolveTier({ feature: 'query', requested: 'fast', routing: defaultAiRouting(), table })
    ).toBe('strong')
  })

  it('merges the Cloud table over the bundled one, dropping what this build does not know', () => {
    expect(PRICING.routing).toEqual({ summary: 'strong' })
    const table = autoTable(PRICING.routing)
    expect(table.summary).toBe('strong')
    expect(table.tags).toBe('fast')
  })

  it('reads stored overrides leniently and lists every feature but the unbuilt ones', () => {
    expect(AiRouting.parse({})).toEqual(defaultAiRouting())
    expect(AiRouting.parse({ all: null, features: { tags: 'strong', gone: 'fast' } })).toEqual({
      all: null,
      features: { tags: 'strong' }
    })
    expect(ROUTABLE_FEATURES).toEqual(
      AI_FEATURE_IDS.filter((id) => id !== 'authorMode' && id !== 'embeddings')
    )
  })
})

describe('hosted pricing (AI-BILLING-SPEC P1–P3, R6, E5)', () => {
  it('fills the spec defaults for a table that omits them', () => {
    expect(PRICING).toMatchObject({
      packsUsd: [10, 25, 50],
      trialGrantUsd: 2,
      quoteThresholdUsd: 0.25,
      estimateSafetyFactor: 1.2,
      lowBalanceWarningUsd: 2,
      perWordUsd: {},
      defaults: null
    })
  })

  it('charges provider cost plus the markup, cached input at its own rate, rounded up', () => {
    // 1M in (250k cached), 100k out on cheap/fast: (750k × 1 + 250k × 0.1 + 100k × 2) / 1M = 0.975.
    const { costUsd, priced } = hostedPriceFor(PRICING, 'cheap/fast', 1_000_000, 100_000, 250_000)
    expect(priced).toBe(true)
    expect(costUsd).toBeCloseTo(0.975 * 1.2, 6)
    // Never free, never fractional micro-dollars.
    expect(hostedPriceFor(PRICING, 'cheap/fast', 1, 0).costUsd).toBe(0.000002)
    expect(hostedPriceFor(PRICING, 'unknown/model', 10, 10)).toEqual({ costUsd: 0, priced: false })
  })

  it('labels a model by its multiplier, and the default one not at all', () => {
    expect(multiplierLabel(PRICING, 'big/strong')).toBe('about 2.4x')
    expect(multiplierLabel(PRICING, 'cheap/fast')).toBeNull()
    expect(multiplierLabel(null, 'big/strong')).toBeNull()
  })
})
