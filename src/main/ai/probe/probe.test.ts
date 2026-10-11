import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENROUTER_PROBED_PRICES } from '@shared/modelPrices'
import {
  PROBED_MODELS,
  cacheAdvice,
  parseEndpoints,
  parseModelsListing,
  perMillion,
  proposePrices,
  reasoningAdvice,
  renderPriceModule,
  renderProbeReport,
  routingAdvice,
  summariseRuns,
  type ProbeResult,
  type ProbeRun
} from './probe'

/**
 * The price probe's pure half (F-16.1) over trimmed listings and usage blocks shaped like
 * OpenRouter's documented answers (`fixtures/`), so `npm run test` never spends: parsing, the
 * summaries, the proposed prices, the price module's round trip, and the report.
 */

const fixture = (name: string): unknown =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8')) as unknown

const LISTING = parseModelsListing(fixture('models.json'))
const RUNS = fixture('runs.json') as ProbeRun[]
const FLASH = 'deepseek/deepseek-v4-flash'
const PRO = 'deepseek/deepseek-v4-pro'
const SUMMARIES = PROBED_MODELS.map((model) =>
  summariseRuns(model, RUNS, OPENROUTER_PROBED_PRICES[model])
)

function result(): ProbeResult {
  return {
    date: '2026-10-11',
    listing: LISTING,
    endpoints: {
      [FLASH]: parseEndpoints(fixture('endpoints-flash.json')),
      [PRO]: parseEndpoints(fixture('endpoints-pro.json'))
    },
    table: OPENROUTER_PROBED_PRICES,
    summaries: SUMMARIES,
    proposed: proposePrices(LISTING, SUMMARIES, OPENROUTER_PROBED_PRICES),
    stoppedAtLimit: false
  }
}

describe('the probe’s parsers', () => {
  it('reads USD per token as USD per million without float noise', () => {
    expect(perMillion('0.00000014')).toBe(0.14)
    expect(perMillion('0.00000174')).toBe(1.74)
    expect(perMillion(0.0000045)).toBe(4.5)
    for (const bad of ['-1', 'x', null, undefined, {}]) expect(perMillion(bad)).toBeNull()
  })

  it('lists every priced model and skips malformed ones', () => {
    expect(LISTING.map((entry) => entry.id)).toEqual([FLASH, PRO, 'openai/gpt-5.4-mini'])
    expect(LISTING[0]).toEqual({
      id: FLASH,
      inUsdPerM: 0.14,
      outUsdPerM: 0.28,
      cachedInUsdPerM: 0.028
    })
    expect(LISTING[2]?.cachedInUsdPerM).toBeNull()
    expect(parseModelsListing(null)).toEqual([])
    expect(parseModelsListing({ data: 'nope' })).toEqual([])
  })

  it('reads the providers of one model with their prices', () => {
    expect(parseEndpoints(fixture('endpoints-flash.json'))).toEqual([
      {
        provider: 'DeepSeek',
        inUsdPerM: 0.14,
        outUsdPerM: 0.28,
        cachedInUsdPerM: 0.028,
        quantization: 'fp8'
      },
      {
        provider: 'Chutes',
        inUsdPerM: 0.15,
        outUsdPerM: 0.3,
        cachedInUsdPerM: null,
        quantization: 'fp8'
      }
    ])
    expect(parseEndpoints({ data: {} })).toEqual([])
  })
})

describe('summariseRuns', () => {
  it('measures cache hits after the first run and whether they were billed lower', () => {
    const [flash, pro] = SUMMARIES
    expect(flash?.runs).toBe(13)
    expect(flash?.cacheHitShare).toBeCloseTo(1920 / 2100, 6)
    expect(flash?.cachedBilledLower).toBe(true)
    // Pro reported the hits but charged the full input rate for them.
    expect(pro?.cacheHitShare).toBeCloseTo(1920 / 2100, 6)
    expect(pro?.cachedBilledLower).toBe(false)
  })

  it('gives the reasoning tokens per mode, the cut-offs, and the finish-reason mix', () => {
    const [flash, pro] = SUMMARIES
    expect(flash?.reasoning.default).toEqual({
      runs: 3,
      medianReasoningTokens: 180,
      medianOutputTokens: 380,
      cutOff: 1
    })
    expect(flash?.reasoning.off?.medianReasoningTokens).toBe(0)
    expect(pro?.reasoning.low?.medianReasoningTokens).toBe(120)
    expect(pro?.reasoning.default?.cutOff).toBe(2)
    expect(pro?.finishReasons).toEqual({ length: 2, stop: 11 })
  })

  it('compares the reported cost with the table estimate', () => {
    const [flash] = SUMMARIES
    expect(flash?.reportedCostUsd).toBeCloseTo(
      0.00029428 + 3 * 0.00007924 + 3 * 0.0002 + 3 * 0.00015 + 3 * 0.00017,
      10
    )
    expect(flash?.estimatedCostUsd).toBeGreaterThan(flash?.reportedCostUsd ?? 0)
  })
})

describe('proposePrices', () => {
  it('takes the listed prices, and the cached price only where the runs saw it billed lower', () => {
    const proposed = proposePrices(LISTING, SUMMARIES, OPENROUTER_PROBED_PRICES)
    expect(proposed[FLASH]).toEqual({
      inUsdPerM: 0.14,
      outUsdPerM: 0.28,
      cachedInUsdPerM: 0.028,
      source: 'probe'
    })
    expect(proposed[PRO]).toEqual({
      inUsdPerM: 1.74,
      outUsdPerM: 3.48,
      cachedInUsdPerM: null,
      source: 'probe'
    })
  })

  it('keeps the current price of a model the listing lacks', () => {
    const proposed = proposePrices([], SUMMARIES, OPENROUTER_PROBED_PRICES)
    expect(proposed).toEqual(OPENROUTER_PROBED_PRICES)
  })
})

describe('the price module', () => {
  it('renders the committed src/shared/modelPrices.ts exactly (the round trip the probe relies on)', () => {
    const committed = fs.readFileSync(
      path.join(__dirname, '../../../shared/modelPrices.ts'),
      'utf8'
    )
    expect(renderPriceModule(OPENROUTER_PROBED_PRICES)).toBe(committed)
  })

  it('writes a probed cached price as a number and the source as probe', () => {
    const text = renderPriceModule(proposePrices(LISTING, SUMMARIES, OPENROUTER_PROBED_PRICES))
    expect(text).toContain("cachedInUsdPerM: 0.028,\n    source: 'probe'")
    expect(text).toContain("cachedInUsdPerM: null,\n    source: 'probe'")
    expect(text).not.toContain('2026')
  })
})

describe('the report', () => {
  it('advises on the cached price, the reasoning entry and provider routing', () => {
    const [flash, pro] = SUMMARIES
    if (flash === undefined || pro === undefined) throw new Error('no summaries')
    expect(cacheAdvice(flash, LISTING[0])).toMatch(/billed lower: carry the listed cached price/)
    expect(cacheAdvice(pro, LISTING[1])).toMatch(/not billed lower: keep `cachedInUsdPerM: null`/)
    expect(reasoningAdvice(pro)).toMatch(/^Thinks by default \(median 310/)
    expect(
      reasoningAdvice({ ...flash, reasoning: { ...flash.reasoning, default: null } })
    ).toBe('Not measured.')
    expect(routingAdvice(result().endpoints[FLASH] ?? [])).toMatch(/within 20 %/)
    expect(routingAdvice([])).toMatch(/^One provider/)
  })

  it('renders the dated report', async () => {
    await expect(renderProbeReport(result())).toMatchFileSnapshot('./fixtures/report.md')
  })
})
