import { describe, expect, it } from 'vitest'
import {
  AI_FEATURE_IDS,
  AI_NEXT_STEP,
  AiErrorCode,
  AiModels,
  AiUsageSummary,
  DEFAULT_INPUT_BUDGET,
  DEFAULT_MODELS,
  HOSTED_DEFAULT_MODELS,
  DEFAULT_OUTPUT_BUDGET,
  DailyCapUsd,
  FEATURE_BUDGETS,
  FEATURE_INPUT_BUDGETS,
  MODEL_PRICING,
  OPENROUTER_DEFAULT_MODELS,
  effectiveOwnKeyProvider,
  TAGS_MIN_CHARS,
  aiFailure,
  defaultAiModels,
  estimateTokens,
  inputBudget,
  outputBudget,
  priceFor,
  testConnectionFailure,
  LOCAL_DEFAULT_MODELS,
  LOCAL_AI_DEFAULT_BASE_URL,
  LocalAiBaseUrl,
  defaultLocalAiSettings,
  defaultModelsFor,
  isLoopbackUrl
} from './ai'

describe('cached input and OpenRouter (AI-BILLING-SPEC A4, R6, A2)', () => {
  it('prices cached prompt tokens at the cached rate, never above the input count', () => {
    // 1M in of which 400k cached, 100k out on gpt-5.4: 600k × 2.5 + 400k × 0.25 + 100k × 15.
    expect(priceFor('gpt-5.4', 1_000_000, 100_000, 400_000).costUsd).toBeCloseTo(1.5 + 0.1 + 1.5)
    expect(priceFor('gpt-5.4', 1_000, 0, 5_000).costUsd).toBeCloseTo(1_000 * 0.25e-6)
    expect(priceFor('gpt-5.4', 1_000, 0).costUsd).toBeCloseTo(
      priceFor('gpt-5.4', 1_000, 0, 0).costUsd
    )
  })

  it('prices the approved OpenRouter defaults and the OpenAI models by their OpenRouter ids', () => {
    // Approved by the author 2026-10-07: DeepSeek V4 Flash and Pro, at that day's live prices.
    expect(OPENROUTER_DEFAULT_MODELS).toEqual({
      fast: 'deepseek/deepseek-v4-flash',
      strong: 'deepseek/deepseek-v4-pro'
    })
    for (const tier of ['fast', 'strong'] as const) {
      expect(priceFor(OPENROUTER_DEFAULT_MODELS[tier], 1_000, 1_000).priced).toBe(true)
      expect(priceFor(`openai/${DEFAULT_MODELS[tier]}`, 1_000, 1_000)).toEqual(
        priceFor(DEFAULT_MODELS[tier], 1_000, 1_000)
      )
    }
    // 1M in, 1M out on V4 Flash: $0.03 + $1.28.
    expect(priceFor('deepseek/deepseek-v4-flash', 1_000_000, 1_000_000).costUsd).toBeCloseTo(1.31)
    expect(defaultModelsFor('openrouter')).toEqual(OPENROUTER_DEFAULT_MODELS)
  })

  it('keeps an install with an OpenAI key on OpenAI until the author picks, else OpenRouter', () => {
    expect(effectiveOwnKeyProvider(undefined, false)).toBe('openrouter')
    expect(effectiveOwnKeyProvider(undefined, true)).toBe('openai')
    expect(effectiveOwnKeyProvider('openrouter', true)).toBe('openrouter')
    expect(effectiveOwnKeyProvider('openai', false)).toBe('openai')
  })
})

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
      summary: 800,
      chat: 1_200,
      query: 600,
      rewrite: 1_500,
      critique: 1_500,
      brief: 200,
      betaReader: 1_200,
      importStructure: 400,
      continuity: 800,
      proofread: 2_000,
      whatNext: 300,
      route: 120,
      synopsis: 350,
      notesSuggest: 600,
      voiceNotes: 400,
      editPass: 4_000,
      agent: 3_000,
      contextImport: 6_000,
      reviewChat: 3_000,
      planLinks: 400,
      organise: 6_000
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
    expect(inputBudget('ghostText')).toBe(2_200)
    expect(outputBudget('authorMode')).toBe(DEFAULT_OUTPUT_BUDGET)
    expect(inputBudget('authorMode')).toBe(DEFAULT_INPUT_BUDGET)
    expect(outputBudget('query')).toBe(600)
    expect(inputBudget('query')).toBe(12_000)
  })

  it('bound the daily cap to 0–500 USD', () => {
    expect(DailyCapUsd.safeParse(0).success).toBe(true)
    expect(DailyCapUsd.safeParse(500).success).toBe(true)
    expect(DailyCapUsd.safeParse(-0.01).success).toBe(false)
    expect(DailyCapUsd.safeParse(500.01).success).toBe(false)
  })

  it('AiUsageSummary refuses a cap outside the bounds', () => {
    const zero = { requests: 0, tokens: 0, costUsd: 0 }
    const summary = {
      today: zero,
      session: zero,
      total: zero,
      byFeature: [],
      recent: [],
      dailyCapUsd: 2
    }
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
      nextStep: 'Turn on Use AI in Settings › AI, or enable the feature there.'
    })
    expect(testConnectionFailure('NO_KEY', 'No API key is saved.')).toEqual(
      aiFailure('NO_KEY', 'No API key is saved.')
    )
    expect(TAGS_MIN_CHARS).toBe(50)
  })
})

describe('AiModels (F-15.4)', () => {
  it('fills the cloud map in when parsing a file written before the Cloud provider existed', () => {
    const stored = { openai: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4' } }
    const parsed = AiModels.parse(stored)
    expect(parsed.openai).toEqual(stored.openai)
    expect(parsed.cloud).toEqual(HOSTED_DEFAULT_MODELS)
  })

  it('keeps a stored cloud map and parses its own defaults', () => {
    const models = {
      openai: { ...DEFAULT_MODELS },
      cloud: { fast: 'gpt-5.4-nano', strong: 'gpt-5.4-mini' }
    }
    // A map stored before F-5.15 gains the local map with its defaults, and before 2026-10-07
    // the OpenRouter map.
    expect(AiModels.parse(models)).toEqual({
      ...models,
      local: LOCAL_DEFAULT_MODELS,
      openrouter: OPENROUTER_DEFAULT_MODELS
    })
    expect(AiModels.parse(defaultAiModels())).toEqual(defaultAiModels())
  })

  it('defaults each map to its own provider defaults', () => {
    expect(defaultAiModels()).toEqual({
      openai: DEFAULT_MODELS,
      cloud: HOSTED_DEFAULT_MODELS,
      local: LOCAL_DEFAULT_MODELS,
      openrouter: OPENROUTER_DEFAULT_MODELS
    })
  })
})

describe('AiErrorCode (F-15.4)', () => {
  it('names the two Cloud failures and points each at the Account tab', () => {
    expect(AiErrorCode.parse('SIGNED_OUT')).toBe('SIGNED_OUT')
    expect(AiErrorCode.parse('NO_CREDIT')).toBe('NO_CREDIT')
    expect(AI_NEXT_STEP.SIGNED_OUT).toBe('Sign in on the Account tab in Settings.')
    expect(AI_NEXT_STEP.NO_CREDIT).toBe('Add to your balance on the Account tab in Settings.')
  })

  it('names the proxy refusals the author can act on (AI-BILLING-SPEC error codes)', () => {
    expect(AiErrorCode.parse('TOO_LARGE')).toBe('TOO_LARGE')
    expect(AiErrorCode.parse('MODEL_UNAVAILABLE')).toBe('MODEL_UNAVAILABLE')
    expect(AI_NEXT_STEP.MODEL_UNAVAILABLE).toContain('Settings › AI')
  })
})

describe('local model settings (F-5.15)', () => {
  it('accepts http and https addresses only, and tells a loopback one from a network one', () => {
    expect(LocalAiBaseUrl.safeParse('http://localhost:11434/v1').success).toBe(true)
    expect(LocalAiBaseUrl.safeParse(' https://models.lan/v1 ').data).toBe('https://models.lan/v1')
    for (const bad of ['', 'localhost:11434', 'ftp://host', 'http://', 'x'.repeat(301)]) {
      expect(LocalAiBaseUrl.safeParse(bad).success).toBe(false)
    }
    for (const near of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:8080'
    ]) {
      expect(isLoopbackUrl(near)).toBe(true)
    }
    for (const far of ['http://192.168.1.20:1234/v1', 'https://api.example.com', 'not a url']) {
      expect(isLoopbackUrl(far)).toBe(false)
    }
  })

  it('resets each provider to its own defaults', () => {
    expect(defaultModelsFor('local')).toEqual(LOCAL_DEFAULT_MODELS)
    expect(defaultModelsFor('cloud')).toEqual(HOSTED_DEFAULT_MODELS)
    expect(defaultModelsFor('openai')).toEqual(DEFAULT_MODELS)
    expect(defaultLocalAiSettings()).toEqual({ baseUrl: LOCAL_AI_DEFAULT_BASE_URL })
  })
})
