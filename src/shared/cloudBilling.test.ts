import { describe, expect, it } from 'vitest'
import {
  chargeMicros,
  DEFAULT_HOSTED_MODELS,
  DEFAULT_HOSTED_ROUTING,
  findHostedModel,
  HostedModelPrice,
  holdMicros,
  inputTokenUpperBound,
  lockPrices,
  markupToBps,
  microsPerM,
  providerCostMicros
} from './cloudBilling'

const MINI = DEFAULT_HOSTED_MODELS[0]!
const PRICES = lockPrices(MINI, 0.2)

describe('the pricing math (P2-P4)', () => {
  it('locks prices as integers', () => {
    expect(PRICES).toEqual({
      inputMicrosPerM: 750_000,
      outputMicrosPerM: 4_500_000,
      cachedMicrosPerM: 75_000,
      markupBps: 2000
    })
    expect(microsPerM(0.1 + 0.2)).toBe(300_000)
    expect(markupToBps(0.2)).toBe(2000)
  })

  it('charges ceil(provider cost × (1 + markup)) from the unrounded cost', () => {
    // 100 × 0.75 + 20 × 4.5 = 165 micro-USD; × 1.2 = 198.
    const usage = { inputTokens: 100, outputTokens: 20, cachedInputTokens: 0 }
    expect(providerCostMicros(PRICES, usage)).toBe(165)
    expect(chargeMicros(PRICES, usage)).toBe(198)
    // 1 input token costs 0.75 micro-USD: the cost rounds up to 1, the charge ceil(0.9) to 1.
    expect(chargeMicros(PRICES, { inputTokens: 1, outputTokens: 0, cachedInputTokens: 0 })).toBe(1)
    expect(chargeMicros(PRICES, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 })).toBe(0)
  })

  it('bills cached input at the cached price, and at the input price where there is none', () => {
    const usage = { inputTokens: 1000, outputTokens: 0, cachedInputTokens: 1000 }
    expect(providerCostMicros(PRICES, usage)).toBe(75)
    expect(providerCostMicros({ ...PRICES, cachedMicrosPerM: null }, usage)).toBe(750)
  })

  it('stays exact on a request too large for a double', () => {
    const premium = { ...PRICES, inputMicrosPerM: 150_000_000, outputMicrosPerM: 600_000_000 }
    const usage = { inputTokens: 2_000_003, outputTokens: 1_000_001, cachedInputTokens: 0 }
    // (2_000_003 × 150 + 1_000_001 × 600) micro-USD = 900_001_050; × 1.2 = 1_080_001_260.
    expect(chargeMicros(premium, usage)).toBe(1_080_001_260)
  })

  it('never charges more than the hold for any usage within the hold’s bounds', () => {
    // A deterministic sweep (no flaky randomness) over every model, markups, and usages.
    let seed = 7
    const next = (max: number): number => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
      return seed % (max + 1)
    }
    for (const model of DEFAULT_HOSTED_MODELS) {
      for (const markup of [0, 0.2, 0.333, 1]) {
        const prices = lockPrices(model, markup)
        for (let i = 0; i < 200; i += 1) {
          const inputBound = next(300_000)
          const maxTokens = 1 + next(4_000)
          const hold = holdMicros(prices, inputBound, maxTokens)
          const inputTokens = next(inputBound)
          const usage = {
            inputTokens,
            outputTokens: next(maxTokens),
            cachedInputTokens: next(inputTokens)
          }
          expect(chargeMicros(prices, usage)).toBeLessThanOrEqual(hold)
        }
      }
    }
  })
})

describe('inputTokenUpperBound', () => {
  it('counts UTF-8 bytes plus the chat template per message', () => {
    expect(inputTokenUpperBound([{ content: 'abcd' }])).toBe(4 + 16 + 16)
    // "é" is two bytes and "雨" three: a token never covers less than a byte.
    expect(inputTokenUpperBound([{ content: 'é' }, { content: '雨' }])).toBe(2 + 3 + 32 + 16)
  })
})

describe('the price table', () => {
  it('finds a model by id or by the bare name an older app sends', () => {
    expect(findHostedModel(DEFAULT_HOSTED_MODELS, 'openai/gpt-5.4')?.label).toBe('GPT-5.4')
    expect(findHostedModel(DEFAULT_HOSTED_MODELS, 'gpt-5.4')?.id).toBe('openai/gpt-5.4')
    expect(findHostedModel(DEFAULT_HOSTED_MODELS, 'gpt-made-up')).toBeUndefined()
  })

  it('routes every default tier to a priced model', () => {
    for (const model of Object.values(DEFAULT_HOSTED_ROUTING.tiers)) {
      expect(findHostedModel(DEFAULT_HOSTED_MODELS, model)).toBeDefined()
    }
  })

  it('refuses a cached price above the input price, which would break charge ≤ hold', () => {
    expect(HostedModelPrice.safeParse({ ...MINI, cachedInputUsdPerM: 1 }).success).toBe(false)
    expect(HostedModelPrice.safeParse(MINI).success).toBe(true)
  })
})
