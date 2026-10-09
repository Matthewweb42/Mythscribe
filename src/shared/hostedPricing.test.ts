import { describe, expect, it } from 'vitest'
import { HOSTED_DEFAULT_MODELS, LEGACY_HOSTED_DEFAULT_MODELS, OPENROUTER_PRICING } from './ai'
import { PricingResult } from './cloudApi'
import { chargeMicros, DEFAULT_HOSTED_MODELS, lockPrices } from './cloudBilling'
import {
  bundledPricing,
  hostedModelFor,
  hostedPriceFor,
  hostedQuote,
  multiplierLabel,
  noBalanceText,
  starterOfferText,
  wordsCovered
} from './hostedPricing'

const CHEAP = {
  id: 'cheap/fast',
  label: 'Cheap',
  inputUsdPerM: 1,
  outputUsdPerM: 2,
  cachedInputUsdPerM: 0.1,
  displayMultiplier: 1
}

/** A server table with three simple models, priced so the arithmetic is easy to follow. */
const PRICING: PricingResult = {
  ...bundledPricing(),
  markup: 0.2,
  quoteThresholdMicros: 250_000,
  estimateSafetyFactor: 1.2,
  models: [
    CHEAP,
    {
      id: 'big/strong',
      label: 'Big',
      inputUsdPerM: 3,
      outputUsdPerM: 15,
      cachedInputUsdPerM: null,
      displayMultiplier: 2.4
    },
    {
      id: 'huge/premium',
      label: 'Huge',
      inputUsdPerM: 30,
      outputUsdPerM: 150,
      cachedInputUsdPerM: null,
      displayMultiplier: 24.6
    }
  ],
  routing: { tiers: { fast: 'cheap/fast', strong: 'big/strong' }, features: {} }
}

describe('bundledPricing (P5: the Worker defaults until GET /pricing answers)', () => {
  it('parses as the wire shape and carries the approved defaults and terms', () => {
    const bundled = bundledPricing()
    expect(PricingResult.parse(bundled)).toEqual(bundled)
    expect(bundled.routing.tiers).toEqual(HOSTED_DEFAULT_MODELS)
    // 2026-10-08 (author): cost + 25 %, and no free grant (the $5 starter pack replaces it).
    expect(bundled.markup).toBe(0.25)
    expect(bundled.quoteThresholdMicros).toBe(250_000)
    expect(bundled.lowBalanceWarningMicros).toBe(2_000_000)
    expect(bundled.trialGrantMicros).toBe(0)
    expect(bundled.minPackMicros).toBe(10_000_000)
    expect(bundled.estimateSafetyFactor).toBe(1.2)
    // Measured constants do not exist yet, so every words line stays hidden.
    expect(Object.values(bundled.wordCosts).every((value) => value === null)).toBe(true)
  })

  it('prices the approved defaults at the same rates as the own-key table', () => {
    for (const tier of ['fast', 'strong'] as const) {
      const id = HOSTED_DEFAULT_MODELS[tier]
      const hosted = DEFAULT_HOSTED_MODELS.find((model) => model.id === id)
      expect(hosted?.inputUsdPerM).toBe(OPENROUTER_PRICING[id]?.inUsdPerM)
      expect(hosted?.outputUsdPerM).toBe(OPENROUTER_PRICING[id]?.outUsdPerM)
      expect(hosted?.cachedInputUsdPerM).toBe(OPENROUTER_PRICING[id]?.cachedInUsdPerM)
    }
  })
})

describe('hostedPriceFor (P2, P3, R6)', () => {
  it('charges exactly what the Worker charges: cost plus markup, cached at its own rate', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedInputTokens: 250_000 }
    // (750k × 1 + 250k × 0.1 + 100k × 2) / 1M = $0.975, × 1.2.
    const { costUsd, priced } = hostedPriceFor(PRICING, 'cheap/fast', 1_000_000, 100_000, 250_000)
    expect(priced).toBe(true)
    expect(costUsd).toBeCloseTo(0.975 * 1.2, 6)
    const worker = chargeMicros(lockPrices(CHEAP, PRICING.markup), usage)
    expect(costUsd).toBe(worker / 1_000_000)
  })

  it('reads an unknown model as unpriced, never as free', () => {
    expect(hostedPriceFor(PRICING, 'unknown/model', 10, 10)).toEqual({ costUsd: 0, priced: false })
  })
})

describe('hostedQuote (flow 2, R3, E4)', () => {
  it('pads the uncached charge by the safety factor', () => {
    // 100k in, 10k out on cheap/fast: (0.1 + 0.02) × 1.2 markup = 0.144, × 1.2 safety = 0.1728.
    const quote = hostedQuote(PRICING, 'cheap/fast', 100_000, 10_000)
    expect(quote.costUsd).toBeCloseTo(0.1728, 6)
    expect(quote.priced).toBe(true)
    expect(quote.needsConfirm).toBe(false)
  })

  it('asks for a confirm above the configured threshold', () => {
    // 1M in, 100k out on cheap/fast: (1 + 0.2) × 1.2 × 1.2 = $1.728.
    expect(hostedQuote(PRICING, 'cheap/fast', 1_000_000, 100_000).needsConfirm).toBe(true)
    const lowered = { ...PRICING, quoteThresholdMicros: 100_000 }
    expect(hostedQuote(lowered, 'cheap/fast', 100_000, 10_000).needsConfirm).toBe(true)
  })

  it('cannot quote a model the server does not sell', () => {
    expect(hostedQuote(PRICING, 'gone/model', 10, 10)).toEqual({
      costUsd: 0,
      priced: false,
      needsConfirm: false
    })
  })
})

describe('multiplierLabel (E5)', () => {
  it('labels a non-default model by its multiplier and the default one not at all', () => {
    expect(multiplierLabel(PRICING, 'big/strong')).toBe('about 2.4x')
    expect(multiplierLabel(PRICING, 'huge/premium')).toBe('about 25x')
    expect(multiplierLabel(PRICING, 'cheap/fast')).toBeNull()
    expect(multiplierLabel(PRICING, 'unknown/model')).toBeNull()
    expect(multiplierLabel(null, 'big/strong')).toBeNull()
  })
})

describe('hostedModelFor (R4, P5)', () => {
  it('sends a tier left at a default to the server routing table', () => {
    expect(hostedModelFor('fast', HOSTED_DEFAULT_MODELS.fast, PRICING)).toBe('cheap/fast')
    expect(hostedModelFor('strong', LEGACY_HOSTED_DEFAULT_MODELS.strong, PRICING)).toBe(
      'big/strong'
    )
    expect(hostedModelFor('strong', LEGACY_HOSTED_DEFAULT_MODELS.strong, null)).toBe(
      HOSTED_DEFAULT_MODELS.strong
    )
  })

  it('sends a model the author typed as typed', () => {
    expect(hostedModelFor('fast', 'huge/premium', PRICING)).toBe('huge/premium')
  })
})

describe('wordsCovered (E2, E3)', () => {
  it('is null while the constant is unmeasured, so the line stays hidden', () => {
    expect(wordsCovered(PRICING, 10_000_000, 'lineEdit')).toBeNull()
  })

  it('pads by the safety factor and rounds down to two significant figures', () => {
    const measured = { ...PRICING, wordCosts: { lineEdit: 0.00005, consistencyCheck: null } }
    // $10 / ($0.00005 × 1.2) = 166,666 words → 160,000.
    expect(wordsCovered(measured, 10_000_000, 'lineEdit')).toBe(160_000)
    expect(wordsCovered(measured, 0, 'lineEdit')).toBeNull()
    expect(wordsCovered(measured, 10_000_000, 'consistencyCheck')).toBeNull()
  })
})

describe('the starter pack offer (2026-10-08)', () => {
  it('says the author’s words, with the price and the window from the Worker', () => {
    expect(starterOfferText(500, 30)).toBe(
      'Try the AI for $5. Any unused balance is refundable for 30 days.'
    )
    expect(starterOfferText(750, 1)).toBe(
      'Try the AI for $7.50. Any unused balance is refundable for 1 day.'
    )
    expect(starterOfferText(500, 0)).toBe('Try the AI for $5.')
  })

  it('offers the starter, explains a balance below zero, and falls back for an older Worker', () => {
    expect(
      noBalanceText({ kind: 'starter', variantId: 's', priceCents: 500, refundWindowDays: 30 })
    ).toBe('Try the AI for $5. Any unused balance is refundable for 30 days.')
    expect(noBalanceText({ kind: 'packs', negative: true })).toBe(
      'Your MythScribe Cloud balance is below zero after a refund or a dispute.'
    )
    expect(noBalanceText({ kind: 'packs', negative: false })).toBe(
      'Your MythScribe Cloud balance is too low for this request.'
    )
    expect(noBalanceText(undefined)).toBe(
      'Your MythScribe Cloud balance is too low for this request.'
    )
  })
})
