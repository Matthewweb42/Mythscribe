import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { OPENROUTER_BASE_URL, type ReasoningMode } from '@shared/ai'
import { OPENROUTER_PROBED_PRICES, type ProbedModelId } from '@shared/modelPrices'
import { testBookScene } from '../../memory/testBook/book'
import { buildOpenAiProvider } from '../providers/openai'
import type { AiMessage, Provider } from '../providers/types'
import {
  PROBED_MODELS,
  parseEndpoints,
  parseModelsListing,
  proposePrices,
  renderPriceModule,
  renderProbeReport,
  summariseRuns,
  type EndpointPrice,
  type ProbeResult,
  type ProbeRun
} from './probe'

/**
 * `npm run ai:probe` (F-16.1): the live price probe. It runs only from that script with
 * `OPENROUTER_API_KEY` set, so `npm run test` never spends. Per model (V4 Flash, then V4 Pro):
 * four requests sharing a ~2,000-token prefix (rules plus one test-book scene) with a varying
 * tail, `max_tokens` 16, reasoning off, two seconds apart; then one short JSON extraction over a
 * test-book passage, three times each with reasoning default, off and low. 26 calls, about 5¢; it
 * stops if the reported cost passes $0.25. It writes the dated report and its numbers (no prompt
 * text, no key) next to the design, and compares the proposed price module with the committed
 * one: a plain run fails and shows the differences, `npm run ai:probe -- -u` writes them.
 */

const KEY = process.env.OPENROUTER_API_KEY ?? ''
const PROBING = process.env.npm_lifecycle_event === 'ai:probe'
const LIVE = PROBING && KEY !== ''

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

describe.runIf(PROBING && !LIVE)('the price probe without a key', () => {
  it('needs an OpenRouter key', () => {
    throw new Error('Set OPENROUTER_API_KEY=sk-or-… to run the probe (about 5¢).')
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
    const record = (run: ProbeRun): void => {
      runs.push(run)
      spent += run.reportedCostUsd ?? 0
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
        record(await measure(provider, model, 'cache', 'off', messages, 16))
      }
      for (const mode of ['default', 'off', 'low'] as const) {
        for (let i = 0; i < REASONING_RUNS && !stoppedAtLimit; i += 1) {
          const messages: AiMessage[] = [
            { role: 'system', content: EXTRACT_RULES },
            { role: 'user', content: passage }
          ]
          record(await measure(provider, model, 'reasoning', mode, messages, 400))
        }
      }
    }

    const summaries = PROBED_MODELS.map((model: ProbedModelId) =>
      summariseRuns(model, runs, OPENROUTER_PROBED_PRICES[model])
    )
    const result: ProbeResult = {
      date: new Date().toISOString().slice(0, 10),
      listing: listing.filter((entry) => PROBED_MODELS.some((model) => model === entry.id)),
      endpoints,
      table: OPENROUTER_PROBED_PRICES,
      summaries,
      proposed: proposePrices(listing, summaries, OPENROUTER_PROBED_PRICES),
      stoppedAtLimit
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(path.join(OUT_DIR, `ai-probe-${result.date}.md`), renderProbeReport(result))
    fs.writeFileSync(
      path.join(OUT_DIR, `ai-probe-${result.date}.json`),
      `${JSON.stringify({ ...result, runs }, null, 2)}\n`
    )

    expect(stoppedAtLimit, 'the probe passed its $0.25 cost limit').toBe(false)
    // A plain run fails here and shows the price differences; `-- -u` writes them.
    await expect(renderPriceModule(result.proposed)).toMatchFileSnapshot(
      '../../../shared/modelPrices.ts'
    )
  }, 600_000)
})
