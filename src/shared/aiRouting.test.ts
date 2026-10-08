import { describe, expect, it } from 'vitest'
import { AI_FEATURE_IDS, reasoningParam } from './ai'
import {
  AiRouting,
  DEFAULT_ROUTING_TABLE,
  ROUTABLE_FEATURES,
  autoTable,
  defaultAiRouting,
  hostedAutoTable,
  resolveReasoning,
  resolveTier
} from './aiRouting'
import { bundledPricing } from './hostedPricing'

/** The Worker's pricing shape, then one whose routing table names a feature this build lacks. */
const PRICING = {
  ...bundledPricing(),
  routing: {
    tiers: { fast: 'cheap/fast', strong: 'big/strong' },
    features: { summary: 'strong' as const }
  }
}
const PRICING_WITH_UNKNOWN = {
  ...PRICING,
  routing: {
    ...PRICING.routing,
    features: { ...PRICING.routing.features, someFutureFeature: 'fast' as const }
  }
}

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
    const routing: AiRouting = { all: 'strong', features: { tags: 'fast' }, reasoning: {} }
    expect(resolveTier({ feature: 'tags', requested: 'strong', routing, table })).toBe('fast')
    expect(resolveTier({ feature: 'summary', requested: 'fast', routing, table })).toBe('strong')
    expect(
      resolveTier({ feature: 'query', requested: 'fast', routing: defaultAiRouting(), table })
    ).toBe('strong')
  })

  it('merges the Cloud table over the bundled one, dropping what this build does not know', () => {
    expect(hostedAutoTable(PRICING_WITH_UNKNOWN)).toEqual({ summary: 'strong' })
    expect(hostedAutoTable(null)).toBeNull()
    const table = autoTable(hostedAutoTable(PRICING))
    expect(table.summary).toBe('strong')
    expect(table.tags).toBe('fast')
  })

  it('reads stored overrides leniently and lists every feature but the unbuilt ones', () => {
    expect(AiRouting.parse({})).toEqual(defaultAiRouting())
    expect(AiRouting.parse({ all: null, features: { tags: 'strong', gone: 'fast' } })).toEqual({
      all: null,
      features: { tags: 'strong' },
      reasoning: {}
    })
    // 2026-10-07: a reasoning choice this build does not know drops the whole map, not the routing.
    expect(AiRouting.parse({ reasoning: { fast: 'max' } }).reasoning).toEqual({})
    expect(AiRouting.parse({ reasoning: { strong: 'off' } }).reasoning).toEqual({ strong: 'off' })
  })

  it('asks a tier for the author’s reasoning mode, else the bundled table’s (2026-10-07)', () => {
    const routing = { ...defaultAiRouting(), reasoning: { fast: 'low' as const } }
    expect(resolveReasoning(routing, 'fast', 'deepseek/deepseek-v4-flash')).toBe('low')
    expect(resolveReasoning(routing, 'strong', 'deepseek/deepseek-v4-pro')).toBe('default')
    expect(resolveReasoning(routing, 'strong', 'unknown/model')).toBe('default')
    expect(reasoningParam('off')).toEqual({ enabled: false })
    expect(reasoningParam('low')).toEqual({ effort: 'low' })
    expect(reasoningParam('default')).toBeUndefined()
    expect(ROUTABLE_FEATURES).toEqual(
      AI_FEATURE_IDS.filter((id) => id !== 'authorMode' && id !== 'embeddings')
    )
  })
})
