import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENROUTER_PROBED_PRICES } from '@shared/modelPrices'
import {
  PROBED_MODELS,
  cacheAdvice,
  parseEndpoints,
  parseModelsListing,
  parseSavedProbe,
  perMillion,
  proposePrices,
  reasoningAdvice,
  renderPriceModule,
  renderProbeReport,
  routingAdvice,
  spendOf,
  summariseRuns,
  type ListedPrice,
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
const listed = (model: string): ListedPrice | undefined =>
  LISTING.find((entry) => entry.id === model)
const SUMMARIES = PROBED_MODELS.map((model) =>
  summariseRuns(model, RUNS, OPENROUTER_PROBED_PRICES[model], listed(model))
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

  it('judges the discount against the listed price, never a stale table (no under-count)', () => {
    // The table says $0.14 in; OpenRouter lists and bills $0.10. The runs report cache hits but
    // are billed at the full $0.10 rate, which is under 95 % of the stale table's price.
    const billed = (cached: number): ProbeRun => ({
      model: FLASH,
      kind: 'cache',
      reasoning: 'off',
      inputTokens: 2_100,
      outputTokens: 1,
      cachedInputTokens: cached,
      reasoningTokens: 0,
      reportedCostUsd: (2_100 * 0.1 + 0.28) / 1_000_000,
      finishReason: 'stop',
      ms: 900
    })
    const runs = [billed(0), billed(1_920), billed(1_920)]
    const stale = { inUsdPerM: 0.14, outUsdPerM: 0.28 }
    const real: ListedPrice = { id: FLASH, inUsdPerM: 0.1, outUsdPerM: 0.28, cachedInUsdPerM: 0.01 }
    const summary = summariseRuns(FLASH, runs, stale, real)
    expect(summary.cachedBilledLower).toBe(false)
    const proposed = proposePrices([real], [summary], OPENROUTER_PROBED_PRICES)
    expect(proposed[FLASH].cachedInUsdPerM).toBeNull()
    // Without the cold run's bill, the listed price alone still decides.
    expect(summariseRuns(FLASH, runs.slice(1), stale, real).cachedBilledLower).toBe(false)
    // A cold run billed below the listed price makes the bar stricter, never looser.
    const cheapCold = { ...billed(0), reportedCostUsd: 0.00005 }
    expect(summariseRuns(FLASH, [cheapCold, ...runs.slice(1)], stale, real).cachedBilledLower).toBe(
      false
    )
  })

  it('counts a run that reported no cost at the table estimate against the limit', () => {
    const run = RUNS[0]
    if (run === undefined) throw new Error('no runs')
    expect(spendOf(run, OPENROUTER_PROBED_PRICES[FLASH])).toBe(run.reportedCostUsd)
    expect(spendOf({ ...run, reportedCostUsd: null }, { inUsdPerM: 1, outUsdPerM: 2 })).toBeCloseTo(
      (2_100 * 1 + 1 * 2) / 1_000_000,
      12
    )
    const summary = summariseRuns(
      FLASH,
      [{ ...run, reportedCostUsd: null }, ...RUNS.slice(1)],
      OPENROUTER_PROBED_PRICES[FLASH],
      listed(FLASH)
    )
    expect(summary.unreportedCostRuns).toBe(1)
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
    // Pro's listed prices match the table and its hits were not billed lower: kept as it is.
    expect(proposed[PRO]).toEqual({
      inUsdPerM: 1.74,
      outUsdPerM: 3.48,
      cachedInUsdPerM: null,
      source: 'list'
    })
  })

  it('keeps the current price of a model the listing lacks', () => {
    const proposed = proposePrices([], SUMMARIES, OPENROUTER_PROBED_PRICES)
    expect(proposed).toEqual(OPENROUTER_PROBED_PRICES)
  })

  it('keeps a confirmed price and its source, so a plain run passes when nothing changed', () => {
    const [flash, pro] = SUMMARIES
    if (flash === undefined || pro === undefined) throw new Error('no summaries')
    const unchanged = [flash, pro].map((summary) => ({ ...summary, cachedBilledLower: false }))
    const proposed = proposePrices(LISTING, unchanged, OPENROUTER_PROBED_PRICES)
    expect(proposed).toEqual(OPENROUTER_PROBED_PRICES)
    expect(renderPriceModule(proposed)).toBe(renderPriceModule(OPENROUTER_PROBED_PRICES))
  })
})

describe('parseSavedProbe', () => {
  it('reads a saved run back for a replay, and refuses anything else', () => {
    const saved = { ...result(), runs: RUNS }
    const parsed = parseSavedProbe(JSON.parse(JSON.stringify(saved)))
    expect(parsed?.listing).toEqual(LISTING)
    expect(parsed?.runs).toEqual(RUNS)
    expect(proposePrices(parsed?.listing ?? [], SUMMARIES, OPENROUTER_PROBED_PRICES)).toEqual(
      result().proposed
    )
    expect(parseSavedProbe({ listing: 'x', runs: [] })).toBeNull()
    expect(parseSavedProbe(null)).toBeNull()
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

  it('writes a probed cached price as a number and the source as probe, a confirmed one unchanged', () => {
    const text = renderPriceModule(proposePrices(LISTING, SUMMARIES, OPENROUTER_PROBED_PRICES))
    expect(text).toContain("cachedInUsdPerM: 0.028,\n    source: 'probe'")
    expect(text).toContain("cachedInUsdPerM: null,\n    source: 'list'")
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
    expect(reasoningAdvice({ ...flash, reasoning: { ...flash.reasoning, default: null } })).toBe(
      'Not measured.'
    )
    expect(routingAdvice(result().endpoints[FLASH] ?? [])).toMatch(/within 20 %/)
    expect(routingAdvice([])).toMatch(/^One provider/)
  })

  it('renders the dated report', async () => {
    await expect(renderProbeReport(result())).toMatchFileSnapshot('./fixtures/report.md')
  })
})
