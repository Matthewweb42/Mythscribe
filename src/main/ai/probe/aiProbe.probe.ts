import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENROUTER_BASE_URL, type ReasoningMode } from '@shared/ai'
import { OPENROUTER_PROBED_PRICES, type ProbedModelId } from '@shared/modelPrices'
import { testBookScene } from '../../memory/testBook/book'
import { openRouterKeyFromEnv } from '../eval/liveProvider'
import { buildOpenAiProvider } from '../providers/openai'
import type { AiMessage, Provider } from '../providers/types'
import {
  PROBED_MODELS,
  parseEndpoints,
  parseModelsListing,
  parseSavedProbe,
  proposePrices,
  renderPriceModule,
  renderProbeReport,
  spendOf,
  summariseRuns,
  type EndpointPrice,
  type ListedPrice,
  type ProbeResult,
  type ProbeRun
} from './probe'

/**
 * `npm run ai:probe` (F-16.1): the live price probe. It runs only from that script with
 * `OPENROUTER_API_KEY` set (or, F-16.22, `OPENAI_API_KEY` with `OPENAI_BASE_URL` at OpenRouter:
 * `openRouterKeyFromEnv`, the one key every live path reads), so `npm run test` never spends.
 * Per model (V4 Flash, then V4 Pro): four requests sharing a ~2,000-token prefix (rules plus one
 * test-book scene) with a varying tail, `max_tokens` 16, reasoning off, two seconds apart; then
 * one short JSON extraction over a test-book passage, three times each with reasoning default,
 * off and low. 26 calls, about 5¢; it stops once the cost passes $0.25 (the reported cost, or
 * the table estimate for a run that reported none). It writes the dated report and its numbers
 * (no prompt text, no key) next to the design, and compares the proposed price module with the
 * committed one: a plain run passes when the prices match and fails showing the differences when
 * they do not; with `-- -u` the same single run writes them. `AI_PROBE_REPLAY=<a saved
 * ai-probe-<date>.json> npm run ai:probe -- -u` writes the module from a saved run without calling
 * anything, so a plain run that found differences never has to be paid for twice.
 */

const KEY = openRouterKeyFromEnv() ?? ''
const REPLAY = process.env.AI_PROBE_REPLAY ?? ''
const PROBING = process.env.npm_lifecycle_event === 'ai:probe'
const REPLAYING = PROBING && REPLAY !== ''
const LIVE = PROBING && !REPLAYING && KEY !== ''

const COST_LIMIT_USD = 0.25
const CACHE_RUNS = 4
const REASONING_RUNS = 3
const PAUSE_MS = 2_000
const OUT_DIR = path.join(__dirname, '../../../../docs/research/story-memory-2026-10-11/probe')

const CACHE_RULES =
  'You are a test endpoint for a prompt-cache measurement. Read the scene below, then answer the ' +
  'question after it with one word.'
const EXTRACT_RULES =
  'Extract every named person in the passage and what the passage says about their eyes or their ' +
  'income. Answer as JSON: {"people":[{"name":"","eyes":null,"income":null}]}. Use null when the ' +
  'passage says nothing.'

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function providerFor(model: string): Provider {
  return buildOpenAiProvider(KEY, {
    baseURL: OPENROUTER_BASE_URL,
    openRouter: true,
    id: 'openrouter',
    label: 'OpenRouter',
    resolveModel: () => model
  })
}

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { authorization: `Bearer ${KEY}` } })
  if (!response.ok) throw new Error(`OpenRouter answered ${response.status} for ${url}`)
  return (await response.json()) as unknown
}

async function measure(
  provider: Provider,
  model: string,
  kind: ProbeRun['kind'],
  reasoning: ReasoningMode,
  messages: AiMessage[],
  maxTokens: number
): Promise<ProbeRun> {
  const started = Date.now()
  const result = await provider.complete({
    tier: 'fast',
    messages,
    maxTokens,
    json: kind === 'reasoning',
    ...(reasoning === 'default' ? {} : { reasoning })
  })
  return {
    model,
    kind,
    reasoning,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens ?? 0,
    reasoningTokens: result.usage.reasoningTokens ?? 0,
    reportedCostUsd: result.usage.reportedCostUsd ?? null,
    finishReason: result.finishReason ?? null,
    ms: Date.now() - started
  }
}

/** The summaries and the proposed module for a set of runs; the live run and the replay share it. */
function propose(
  listing: readonly ListedPrice[],
  runs: readonly ProbeRun[]
): Pick<ProbeResult, 'summaries' | 'proposed'> {
  const summaries = PROBED_MODELS.map((model: ProbedModelId) =>
    summariseRuns(
      model,
      runs,
      OPENROUTER_PROBED_PRICES[model],
      listing.find((entry) => entry.id === model)
    )
  )
  return { summaries, proposed: proposePrices(listing, summaries, OPENROUTER_PROBED_PRICES) }
}

describe.runIf(PROBING && !LIVE && !REPLAYING)('the price probe without a key', () => {
  it('needs an OpenRouter key', () => {
    throw new Error(
      'Set OPENROUTER_API_KEY=sk-or-… to run the probe (about 5¢), or OPENAI_API_KEY with ' +
        'OPENAI_BASE_URL=https://openrouter.ai/api/v1.'
    )
  })
})

describe.runIf(LIVE)('the price probe (F-16.1)', () => {
  it('measures the DeepSeek defaults and proposes the price module', async () => {
    const listing = parseModelsListing(await getJson(`${OPENROUTER_BASE_URL}/models`))
    const endpoints: Record<string, EndpointPrice[]> = {}
    for (const model of PROBED_MODELS) {
      endpoints[model] = parseEndpoints(
        await getJson(`${OPENROUTER_BASE_URL}/models/${model}/endpoints`)
      )
    }

    const scene = testBookScene('s03').paragraphs.join('\n\n')
    const passage = testBookScene('s03').paragraphs.slice(4, 6).join('\n\n')
    const runs: ProbeRun[] = []
    let spent = 0
    let stoppedAtLimit = false
    const record = (model: ProbedModelId, measured: ProbeRun): void => {
      const spentUsd = spendOf(measured, OPENROUTER_PROBED_PRICES[model])
      runs.push({ ...measured, spentUsd })
      spent += spentUsd
      if (spent > COST_LIMIT_USD) stoppedAtLimit = true
    }

    for (const model of PROBED_MODELS) {
      if (stoppedAtLimit) break
      const provider = providerFor(model)
      for (let i = 0; i < CACHE_RUNS && !stoppedAtLimit; i += 1) {
        if (i > 0) await wait(PAUSE_MS)
        const messages: AiMessage[] = [
          { role: 'system', content: `${CACHE_RULES}\n\n${scene}` },
          { role: 'user', content: `Question ${i + 1}: who danced every dance?` }
        ]
        record(model, await measure(provider, model, 'cache', 'off', messages, 16))
      }
      for (const mode of ['default', 'off', 'low'] as const) {
        for (let i = 0; i < REASONING_RUNS && !stoppedAtLimit; i += 1) {
          const messages: AiMessage[] = [
            { role: 'system', content: EXTRACT_RULES },
            { role: 'user', content: passage }
          ]
          record(model, await measure(provider, model, 'reasoning', mode, messages, 400))
        }
      }
    }

    const result: ProbeResult = {
      date: new Date().toISOString().slice(0, 10),
      listing: listing.filter((entry) => PROBED_MODELS.some((model) => model === entry.id)),
      endpoints,
      table: OPENROUTER_PROBED_PRICES,
      ...propose(listing, runs),
      stoppedAtLimit
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, `ai-probe-${result.date}.md`), renderProbeReport(result))
    fs.writeFileSync(
      path.join(OUT_DIR, `ai-probe-${result.date}.json`),
      `${JSON.stringify({ ...result, runs }, null, 2)}\n`
    )

    expect(stoppedAtLimit, 'the probe passed its $0.25 cost limit').toBe(false)
    // A plain run passes when the prices match and fails showing the differences when they do
    // not; `-- -u` writes them (or `AI_PROBE_REPLAY` later, without spending again).
    await expect(renderPriceModule(result.proposed)).toMatchFileSnapshot(
      '../../../shared/modelPrices.ts'
    )
  }, 600_000)
})

describe.runIf(REPLAYING)('the price probe replayed from a saved run (no calls)', () => {
  it('proposes the price module from the saved listing and runs', async () => {
    const saved = parseSavedProbe(JSON.parse(fs.readFileSync(path.resolve(REPLAY), 'utf8')))
    if (saved === null)
      throw new Error(`${REPLAY} is not a saved probe run (ai-probe-<date>.json).`)
    const { listing, runs } = saved
    expect(listing.length, 'the saved run lists no probed model').toBeGreaterThan(0)
    expect(runs.length, 'the saved run has no runs').toBeGreaterThan(0)
    await expect(renderPriceModule(propose(listing, runs).proposed)).toMatchFileSnapshot(
      '../../../shared/modelPrices.ts'
    )
  })
})
