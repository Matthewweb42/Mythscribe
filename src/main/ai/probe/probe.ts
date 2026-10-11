import { z } from 'zod'
import { costOf, ReasoningMode, REASONING_MODES } from '@shared/ai'
import type { ProbedModelId, ProbedPrice } from '@shared/modelPrices'

/**
 * The price probe's pure half (F-16.1): it reads what OpenRouter lists, summarises what the probe
 * runs measured, proposes the prices the app should carry, and writes the report and the price
 * module. The live half (`aiProbe.probe.ts`) only fetches and calls; everything that decides
 * anything is here, tested over recorded listings.
 */

/** The models the probe measures, in run order: the DeepSeek V4 defaults. */
export const PROBED_MODELS: readonly ProbedModelId[] = [
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro'
]

/** One model's list price as OpenRouter publishes it, in USD per million tokens. */
export interface ListedPrice {
  id: string
  inUsdPerM: number
  outUsdPerM: number
  /** `input_cache_read`; null when the listing has none. */
  cachedInUsdPerM: number | null
}

/** One provider that serves a model on OpenRouter, with its own price. */
export interface EndpointPrice {
  provider: string
  inUsdPerM: number
  outUsdPerM: number
  cachedInUsdPerM: number | null
  quantization: string | null
}

/** One probe request as measured: numbers only, never the prompt or the answer. */
export interface ProbeRun {
  model: string
  kind: 'cache' | 'reasoning'
  reasoning: ReasoningMode
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  reasoningTokens: number
  /** OpenRouter's `usage.cost`; null when it did not report one. */
  reportedCostUsd: number | null
  /**
   * What the run counted against the probe's cost limit: the reported cost, or the table
   * estimate when none was reported (`spendOf`), so the limit holds either way. Absent in runs
   * recorded before it existed.
   */
  spentUsd?: number
  finishReason: string | null
  ms: number
}

/** The reasoning runs of one mode. */
export interface ModeSummary {
  runs: number
  medianReasoningTokens: number
  medianOutputTokens: number
  /** Runs cut off at their output cap. */
  cutOff: number
}

export interface RunSummary {
  model: string
  runs: number
  medianInputTokens: number
  medianOutputTokens: number
  /** Cached input tokens over input tokens, across the cache runs after the first. */
  cacheHitShare: number
  /** Whether a run with cache hits was charged less than its input would cost uncached. */
  cachedBilledLower: boolean
  reasoning: Record<ReasoningMode, ModeSummary | null>
  finishReasons: Record<string, number>
  /** Sum of the costs OpenRouter reported. */
  reportedCostUsd: number
  /** Runs that reported no cost (the limit counted their table estimate instead). */
  unreportedCostRuns: number
  /** Sum of the same runs priced at the app's table, cached input at the input rate. */
  estimatedCostUsd: number
}

/** Everything one probe run found, as the report and the JSON file record it. */
export interface ProbeResult {
  /** `YYYY-MM-DD`, the day the probe ran. */
  date: string
  listing: ListedPrice[]
  endpoints: Record<string, EndpointPrice[]>
  /** The app's prices before the run (`OPENROUTER_PROBED_PRICES`). */
  table: Record<ProbedModelId, ProbedPrice>
  summaries: RunSummary[]
  proposed: Record<ProbedModelId, ProbedPrice>
  /** True when the run stopped early at the cost limit. */
  stoppedAtLimit: boolean
}

/** OpenRouter publishes USD per token as a decimal string; the app keeps USD per million. */
export function perMillion(perToken: unknown): number | null {
  const value =
    typeof perToken === 'string' ? Number(perToken) : typeof perToken === 'number' ? perToken : NaN
  if (!Number.isFinite(value) || value < 0) return null
  return Number((value * 1_000_000).toPrecision(12))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function pricesOf(
  pricing: unknown
): { inUsdPerM: number; outUsdPerM: number; cachedInUsdPerM: number | null } | null {
  if (!isRecord(pricing)) return null
  const input = perMillion(pricing.prompt)
  const output = perMillion(pricing.completion)
  if (input === null || output === null) return null
  return {
    inUsdPerM: input,
    outUsdPerM: output,
    cachedInUsdPerM: perMillion(pricing.input_cache_read)
  }
}

/** `GET /api/v1/models`: every model's id and list price; malformed entries are skipped. */
export function parseModelsListing(json: unknown): ListedPrice[] {
  const data = isRecord(json) && Array.isArray(json.data) ? json.data : []
  const listed: ListedPrice[] = []
  for (const entry of data) {
    if (!isRecord(entry) || typeof entry.id !== 'string') continue
    const prices = pricesOf(entry.pricing)
    if (prices !== null) listed.push({ id: entry.id, ...prices })
  }
  return listed
}

/** `GET /api/v1/models/{id}/endpoints`: the providers serving one model and their prices. */
export function parseEndpoints(json: unknown): EndpointPrice[] {
  const data = isRecord(json) && isRecord(json.data) ? json.data : null
  const endpoints = data !== null && Array.isArray(data.endpoints) ? data.endpoints : []
  const parsed: EndpointPrice[] = []
  for (const entry of endpoints) {
    if (!isRecord(entry)) continue
    const provider =
      typeof entry.provider_name === 'string'
        ? entry.provider_name
        : typeof entry.name === 'string'
          ? entry.name
          : null
    const prices = pricesOf(entry.pricing)
    if (provider === null || prices === null) continue
    parsed.push({
      provider,
      ...prices,
      quantization: typeof entry.quantization === 'string' ? entry.quantization : null
    })
  }
  return parsed
}

const Usd = z.number().nonnegative()
const Count = z.number().int().nonnegative()

/** The parts of a saved `ai-probe-<date>.json` a replay needs: the listing and the runs. */
const SavedProbe = z.object({
  listing: z.array(
    z.object({ id: z.string(), inUsdPerM: Usd, outUsdPerM: Usd, cachedInUsdPerM: Usd.nullable() })
  ),
  runs: z.array(
    z.object({
      model: z.string(),
      kind: z.enum(['cache', 'reasoning']),
      reasoning: ReasoningMode,
      inputTokens: Count,
      outputTokens: Count,
      cachedInputTokens: Count,
      reasoningTokens: Count,
      reportedCostUsd: Usd.nullable(),
      finishReason: z.string().nullable(),
      ms: z.number().nonnegative(),
      spentUsd: Usd.optional()
    })
  )
})

/**
 * A saved probe run read back for a replay (`AI_PROBE_REPLAY`): its listing and its runs, or null
 * when the file is not one. The replay proposes prices from them without calling anything.
 */
export function parseSavedProbe(
  json: unknown
): { listing: ListedPrice[]; runs: ProbeRun[] } | null {
  const parsed = SavedProbe.safeParse(json)
  return parsed.success ? parsed.data : null
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

/** A reported cost this far under the uncached estimate counts as a cache discount. */
const CACHE_DISCOUNT_SEEN = 0.95

type InOutPrice = Pick<ProbedPrice, 'inUsdPerM' | 'outUsdPerM'>

/**
 * What a run counts against the probe's cost limit: the cost OpenRouter reported, or, when a
 * response left it out, the run priced at the app's table, so the limit never stops counting.
 */
export function spendOf(run: ProbeRun, table: InOutPrice): number {
  return run.reportedCostUsd ?? costOf(table, run.inputTokens, run.outputTokens, 0)
}

/**
 * One model's runs summarised. `table` is the app's price before the run (the report's "Table
 * estimate"); `listed` is the price OpenRouter lists, which is what a request is billed at. A run
 * with cache hits counts as billed lower only when its reported cost is under what the same run
 * costs uncached at the listed price, and under the first cold cache run's measured bill scaled
 * to its tokens, never against the table: the table is what the probe exists to check, and a
 * stale one would make a full-price run look discounted (then cached input would be under-counted).
 */
export function summariseRuns(
  model: string,
  runs: readonly ProbeRun[],
  table: InOutPrice,
  listed: InOutPrice | undefined
): RunSummary {
  const own = runs.filter((run) => run.model === model)
  const uncached = { inUsdPerM: table.inUsdPerM, outUsdPerM: table.outUsdPerM }
  const billedAt = listed ?? uncached
  const cacheRuns = own.filter((run) => run.kind === 'cache').slice(1)
  const cacheInput = cacheRuns.reduce((sum, run) => sum + run.inputTokens, 0)
  const cachedInput = cacheRuns.reduce((sum, run) => sum + run.cachedInputTokens, 0)
  const cold = own.find(
    (run): run is ProbeRun & { reportedCostUsd: number } =>
      run.kind === 'cache' &&
      run.cachedInputTokens === 0 &&
      run.reportedCostUsd !== null &&
      run.inputTokens > 0
  )
  const uncachedCost = (run: ProbeRun): number => {
    const listedCost = costOf(billedAt, run.inputTokens, run.outputTokens, 0)
    if (cold === undefined) return listedCost
    const coldListed = costOf(billedAt, cold.inputTokens, cold.outputTokens, 0)
    if (coldListed <= 0) return listedCost
    return Math.min(listedCost, (cold.reportedCostUsd * listedCost) / coldListed)
  }
  const cachedBilledLower = own.some(
    (run) =>
      run.cachedInputTokens > 0 &&
      run.reportedCostUsd !== null &&
      run.reportedCostUsd < CACHE_DISCOUNT_SEEN * uncachedCost(run)
  )
  const modeSummary = (mode: ReasoningMode): ModeSummary | null => {
    const modeRuns = own.filter((run) => run.kind === 'reasoning' && run.reasoning === mode)
    return modeRuns.length === 0
      ? null
      : {
          runs: modeRuns.length,
          medianReasoningTokens: median(modeRuns.map((run) => run.reasoningTokens)),
          medianOutputTokens: median(modeRuns.map((run) => run.outputTokens)),
          cutOff: modeRuns.filter((run) => run.finishReason === 'length').length
        }
  }
  const reasoning: Record<ReasoningMode, ModeSummary | null> = {
    off: modeSummary('off'),
    low: modeSummary('low'),
    default: modeSummary('default')
  }
  const finishReasons: Record<string, number> = {}
  for (const run of own) {
    const reason = run.finishReason ?? 'unknown'
    finishReasons[reason] = (finishReasons[reason] ?? 0) + 1
  }
  return {
    model,
    runs: own.length,
    medianInputTokens: median(own.map((run) => run.inputTokens)),
    medianOutputTokens: median(own.map((run) => run.outputTokens)),
    cacheHitShare: cacheInput === 0 ? 0 : cachedInput / cacheInput,
    cachedBilledLower,
    reasoning,
    finishReasons,
    reportedCostUsd: own.reduce((sum, run) => sum + (run.reportedCostUsd ?? 0), 0),
    unreportedCostRuns: own.filter((run) => run.reportedCostUsd === null).length,
    estimatedCostUsd: own.reduce(
      (sum, run) => sum + costOf(uncached, run.inputTokens, run.outputTokens, 0),
      0
    )
  }
}

/**
 * The prices the app should carry: OpenRouter's list price for input and output, and the listed
 * cached price only when the runs saw cache hits billed lower (otherwise cached input bills at
 * the input rate, over-counted, never under-counted). A model the listing lacks keeps its price,
 * and so does a model whose three prices the run confirmed (its `source` too), so a plain run
 * passes when nothing changed.
 */
export function proposePrices(
  listing: readonly ListedPrice[],
  summaries: readonly RunSummary[],
  current: Record<ProbedModelId, ProbedPrice>
): Record<ProbedModelId, ProbedPrice> {
  const proposed = { ...current }
  for (const model of PROBED_MODELS) {
    const listed = listing.find((entry) => entry.id === model)
    if (listed === undefined) continue
    const billedLower = summaries.find((s) => s.model === model)?.cachedBilledLower ?? false
    const cachedInUsdPerM =
      billedLower && listed.cachedInUsdPerM !== null && listed.cachedInUsdPerM < listed.inUsdPerM
        ? listed.cachedInUsdPerM
        : null
    const now = current[model]
    const unchanged =
      now.inUsdPerM === listed.inUsdPerM &&
      now.outUsdPerM === listed.outUsdPerM &&
      now.cachedInUsdPerM === cachedInUsdPerM
    proposed[model] = unchanged
      ? now
      : {
          inUsdPerM: listed.inUsdPerM,
          outUsdPerM: listed.outUsdPerM,
          cachedInUsdPerM,
          source: 'probe'
        }
  }
  return proposed
}

const PRICE_MODULE_HEADER = `/**
 * The DeepSeek V4 default models' prices on OpenRouter, in USD per million tokens (F-16.1).
 * Generated by \`npm run ai:probe\` (\`renderPriceModule\` in \`src/main/ai/probe/probe.ts\`); do not
 * edit by hand. The own-key table (\`OPENROUTER_PRICING\`) and the hosted defaults
 * (\`DEFAULT_HOSTED_MODELS\`) both read it. \`source: 'list'\` is the researched list price;
 * \`'probe'\` is what the probe measured. A null cached price bills cached tokens at the input rate.
 */
export interface ProbedPrice {
  inUsdPerM: number
  outUsdPerM: number
  cachedInUsdPerM: number | null
  source: 'list' | 'probe'
}
`

/** The source of `src/shared/modelPrices.ts` for `prices`, formatted as Prettier leaves it. */
export function renderPriceModule(prices: Record<ProbedModelId, ProbedPrice>): string {
  const ids = PROBED_MODELS.map((id) => `'${id}'`).join(' | ')
  const entries = PROBED_MODELS.map((id) => {
    const price = prices[id]
    return [
      `  '${id}': {`,
      `    inUsdPerM: ${String(price.inUsdPerM)},`,
      `    outUsdPerM: ${String(price.outUsdPerM)},`,
      `    cachedInUsdPerM: ${price.cachedInUsdPerM === null ? 'null' : String(price.cachedInUsdPerM)},`,
      `    source: '${price.source}'`,
      '  }'
    ].join('\n')
  })
  return [
    PRICE_MODULE_HEADER,
    `export type ProbedModelId = ${ids}`,
    '',
    'export const OPENROUTER_PROBED_PRICES: Readonly<Record<ProbedModelId, ProbedPrice>> = {',
    entries.join(',\n'),
    '}',
    ''
  ].join('\n')
}

function usd(value: number): string {
  if (value === 0) return '$0'
  return value >= 1 ? `$${value.toFixed(2)}` : `$${value.toPrecision(3)}`
}

function price(value: number | null): string {
  return value === null ? '—' : `$${String(value)}`
}

function percent(share: number): string {
  return `${Math.round(share * 100)} %`
}

/** What the report recommends for one model's reasoning entry in the hosted price table. */
export function reasoningAdvice(summary: RunSummary): string {
  const byDefault = summary.reasoning.default?.medianReasoningTokens ?? null
  const off = summary.reasoning.off?.medianReasoningTokens ?? null
  if (byDefault === null || off === null) return 'Not measured.'
  if (byDefault === 0) {
    return 'Does not think by default: set `"reasoning": "off"` in its `models` entry, so a request asking for `low` can never add thinking.'
  }
  if (off < byDefault) {
    return `Thinks by default (median ${byDefault} reasoning tokens); \`off\` brings it to ${off}. Keep \`off\` for background JSON.`
  }
  return `Thinks by default (median ${byDefault} reasoning tokens) and \`off\` does not lower it (${off}): check OpenRouter's reasoning support for this model before relying on \`off\`.`
}

/** The cached-price recommendation for one model. */
export function cacheAdvice(summary: RunSummary, listed: ListedPrice | undefined): string {
  if (summary.cacheHitShare === 0) {
    return 'No cache hits seen: keep cached input billed at the input rate (`cachedInUsdPerM: null`).'
  }
  if (!summary.cachedBilledLower) {
    return `Cache hits seen (${percent(summary.cacheHitShare)} of repeated input) but not billed lower: keep \`cachedInUsdPerM: null\`.`
  }
  return `Cache hits seen (${percent(summary.cacheHitShare)} of repeated input) and billed lower: carry the listed cached price (${price(listed?.cachedInUsdPerM ?? null)} per M).`
}

/** Whether to pin OpenRouter's provider order: only when the providers' prices differ. */
export function routingAdvice(endpoints: readonly EndpointPrice[]): string {
  if (endpoints.length <= 1) {
    return 'One provider (or none listed): leave `provider.order` and `provider.sort` unset.'
  }
  const inputs = endpoints.map((endpoint) => endpoint.inUsdPerM)
  const spread = Math.max(...inputs) / Math.max(Math.min(...inputs), 1e-9)
  if (spread <= 1.2) {
    return 'The providers charge within 20 % of each other: leave `provider.order` and `provider.sort` unset (the default).'
  }
  return 'The providers charge differently: consider `provider.sort: "price"`, but only among providers that meet the privacy settings (`docs/OPERATOR-SETUP.md` 1.2).'
}

/** The dated markdown report of one probe run. */
export function renderProbeReport(result: ProbeResult): string {
  const lines: string[] = [
    `# AI price probe, ${result.date}`,
    '',
    'Generated by `npm run ai:probe` (F-16.1). It reads OpenRouter’s listing and endpoints for the',
    'DeepSeek V4 defaults, then makes small calls to measure prompt-cache hits and thinking tokens',
    'with reasoning at default, off and low. Prices are USD per million tokens.',
    '',
    result.stoppedAtLimit
      ? '**The run stopped early at its $0.25 cost limit; the numbers below are partial.**'
      : 'The run finished under its $0.25 cost limit.',
    '',
    '## Prices',
    '',
    '| Model | Table in / out / cached | Listed in / out / cached | Proposed in / out / cached |',
    '| --- | --- | --- | --- |'
  ]
  for (const model of PROBED_MODELS) {
    const table = result.table[model]
    const listed = result.listing.find((entry) => entry.id === model)
    const proposed = result.proposed[model]
    lines.push(
      `| \`${model}\` | ${price(table.inUsdPerM)} / ${price(table.outUsdPerM)} / ${price(table.cachedInUsdPerM)} | ${listed === undefined ? 'not listed' : `${price(listed.inUsdPerM)} / ${price(listed.outUsdPerM)} / ${price(listed.cachedInUsdPerM)}`} | ${price(proposed.inUsdPerM)} / ${price(proposed.outUsdPerM)} / ${price(proposed.cachedInUsdPerM)} |`
    )
  }
  lines.push('', '## Providers', '')
  for (const model of PROBED_MODELS) {
    const endpoints = result.endpoints[model] ?? []
    lines.push(`### \`${model}\``, '')
    if (endpoints.length === 0) {
      lines.push('No endpoints listed.', '')
    } else {
      lines.push('| Provider | In / out / cached | Quantization |', '| --- | --- | --- |')
      for (const endpoint of endpoints) {
        lines.push(
          `| ${endpoint.provider} | ${price(endpoint.inUsdPerM)} / ${price(endpoint.outUsdPerM)} / ${price(endpoint.cachedInUsdPerM)} | ${endpoint.quantization ?? '—'} |`
        )
      }
      lines.push('')
    }
  }
  lines.push(
    '## Runs',
    '',
    '| Model | Runs | Median in / out | Cache hits (repeated input) | Reasoning tokens default / off / low | Cut off | Finish reasons | Reported cost | Table estimate |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  )
  for (const summary of result.summaries) {
    const mode = (m: ReasoningMode): string =>
      summary.reasoning[m] === null ? '—' : String(summary.reasoning[m]?.medianReasoningTokens)
    const cutOff = REASONING_MODES.reduce((sum, m) => sum + (summary.reasoning[m]?.cutOff ?? 0), 0)
    const finish = Object.entries(summary.finishReasons)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([reason, count]) => `${reason} ${count}`)
      .join(', ')
    lines.push(
      `| \`${summary.model}\` | ${summary.runs} | ${summary.medianInputTokens} / ${summary.medianOutputTokens} | ${percent(summary.cacheHitShare)} | ${mode('default')} / ${mode('off')} / ${mode('low')} | ${cutOff} | ${finish} | ${usd(summary.reportedCostUsd)}${summary.unreportedCostRuns > 0 ? ` (${summary.unreportedCostRuns} runs unreported)` : ''} | ${usd(summary.estimatedCostUsd)} |`
    )
  }
  lines.push('', '## Recommendations', '')
  for (const summary of result.summaries) {
    const listed = result.listing.find((entry) => entry.id === summary.model)
    lines.push(`### \`${summary.model}\``, '')
    lines.push(`- **Cached price:** ${cacheAdvice(summary, listed)}`)
    lines.push(`- **Reasoning entry:** ${reasoningAdvice(summary)}`)
    lines.push(
      `- **Provider routing:** ${routingAdvice(result.endpoints[summary.model] ?? [])}`,
      ''
    )
  }
  lines.push(
    '## Next steps',
    '',
    '1. If the proposed prices differ from the table: after `npm run ai:probe -- -u` they are',
    '   already in `src/shared/modelPrices.ts` (check with `git diff`); after a plain run (which',
    '   fails on the difference), write them from this run’s saved numbers without calling',
    '   anything: `AI_PROBE_REPLAY=<path to this report’s .json> npm run ai:probe -- -u`.',
    '   If they match, a plain run passes and there is nothing to write.',
    '2. Run `npm run eval:ai -- -u` to reprice `docs/AI-COST-REGISTRY.md`.',
    '3. Commit this report, its JSON, the price module and the registry diff; then update the',
    '   Worker’s `models` row (`docs/OPERATOR-SETUP.md` 4.3) if it is deployed.'
  )
  return `${lines.join('\n')}\n`
}
