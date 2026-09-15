import { describe, expect, it } from 'vitest'
import {
  AI_FEATURE_IDS,
  AiUsageSummary,
  DEFAULT_INPUT_BUDGET,
  DEFAULT_MODELS,
  DEFAULT_OUTPUT_BUDGET,
  DailyCapUsd,
  FEATURE_BUDGETS,
  FEATURE_INPUT_BUDGETS,
  MODEL_PRICING,
  TAGS_MIN_CHARS,
  aiFailure,
  estimateTokens,
  inputBudget,
  outputBudget,
  priceFor,
  testConnectionFailure
} from './ai'

describe('priceFor (F-5.14)', () => {
  it('prices a known model per million tokens in and out', () => {
    const price = MODEL_PRICING['gpt-5.4-mini']
    if (!price) throw new Error('gpt-5.4-mini must be priced')
    const { costUsd, priced } = priceFor('gpt-5.4-mini', 1_000_000, 500_000)
    expect(priced).toBe(true)
    expect(costUsd).toBeCloseTo(price.inUsdPerM + price.outUsdPerM / 2, 8)
  })

  it('costs nothing for zero tokens', () => {
    expect(priceFor('gpt-5.4', 0, 0)).toEqual({ costUsd: 0, priced: true })
  })

  it('answers 0 and unpriced for a model the table does not know', () => {
    expect(priceFor('gpt-unknown', 10_000, 10_000)).toEqual({ costUsd: 0, priced: false })
  })

  it('prices both default tier models, so a fresh install reports cost', () => {
    for (const model of Object.values(DEFAULT_MODELS)) {
      expect(priceFor(model, 1, 1).priced).toBe(true)
    }
  })
})

describe('estimateTokens', () => {
  it('estimates about four characters per token, rounding up, and 0 for empty text', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('a')).toBe(1)
    expect(estimateTokens('x'.repeat(400))).toBe(100)
    expect(estimateTokens('x'.repeat(401))).toBe(101)
  })
})

describe('budgets', () => {
  it('give every built feature an output cap and a larger input cap', () => {
    expect(FEATURE_BUDGETS).toEqual({
      ghostText: 60,
      tags: 200,
      summary: 150,
      chat: 1_200,
      rewrite: 1_500
    })
    expect(Object.keys(FEATURE_INPUT_BUDGETS).sort()).toEqual(Object.keys(FEATURE_BUDGETS).sort())
    for (const feature of AI_FEATURE_IDS) {
      const out = FEATURE_BUDGETS[feature]
      if (out === undefined) continue
      expect(out).toBeGreaterThan(0)
      expect(FEATURE_INPUT_BUDGETS[feature]).toBeGreaterThan(out)
    }
  })

  it('answer a positive default for a feature without its own line, and the line when it exists', () => {
    expect(DEFAULT_OUTPUT_BUDGET).toBeGreaterThan(0)
    expect(DEFAULT_INPUT_BUDGET).toBeGreaterThan(DEFAULT_OUTPUT_BUDGET)
    expect(outputBudget('ghostText')).toBe(60)
    expect(inputBudget('ghostText')).toBe(1_500)
    expect(outputBudget('query')).toBe(DEFAULT_OUTPUT_BUDGET)
    expect(inputBudget('query')).toBe(DEFAULT_INPUT_BUDGET)
  })

  it('bound the daily cap to 0–500 USD', () => {
    expect(DailyCapUsd.safeParse(0).success).toBe(true)
    expect(DailyCapUsd.safeParse(500).success).toBe(true)
    expect(DailyCapUsd.safeParse(-0.01).success).toBe(false)
    expect(DailyCapUsd.safeParse(500.01).success).toBe(false)
  })

  it('AiUsageSummary refuses a cap outside the bounds', () => {
    const zero = { requests: 0, tokens: 0, costUsd: 0 }
    const summary = { today: zero, total: zero, byFeature: [], dailyCapUsd: 2 }
    expect(AiUsageSummary.safeParse(summary).success).toBe(true)
    expect(AiUsageSummary.safeParse({ ...summary, dailyCapUsd: 501 }).success).toBe(false)
  })
})

describe('aiFailure', () => {
  it('pairs the code and message with the next step, and testConnectionFailure is the same shape', () => {
    expect(aiFailure('DISABLED', 'Tag suggestions is turned off for this project.')).toEqual({
      ok: false,
      code: 'DISABLED',
      message: 'Tag suggestions is turned off for this project.',
      nextStep: 'Turn the AI dial up in Settings, or enable the feature there.'
    })
    expect(testConnectionFailure('NO_KEY', 'No API key is saved.')).toEqual(
      aiFailure('NO_KEY', 'No API key is saved.')
    )
    expect(TAGS_MIN_CHARS).toBe(50)
  })
})
