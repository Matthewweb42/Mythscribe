/**
 * The Worker's billing config (AI-BILLING-SPEC "Config defaults", P1, S4): built-in defaults,
 * each overridable by one row of the `billing_config` table (migration 0005), so the operator
 * changes a price, the markup, a limit, or the routing table with `wrangler d1 execute` — no app
 * release and no deploy. A row is a snake_case key and a JSON value; a malformed row is logged
 * and ignored (the default stands), so a typo can never take the proxy down.
 */
import { z } from 'zod'
import { AI_COMPLETE_MAX_CHARS } from '../../src/shared/cloudApi'
import {
  DEFAULT_HOSTED_MODELS,
  DEFAULT_HOSTED_ROUTING,
  DEFAULT_WORD_COSTS,
  findHostedModel,
  HostedModelPrice,
  HostedRouting,
  WordCostConstants
} from '../../src/shared/cloudBilling'
import type { Store } from './store'

export const BillingConfig = z.object({
  /** The one-time app license, in USD (M1). */
  appPriceUsd: z.number().nonnegative(),
  /** The smallest pack offered (M4); a configured pack below it is not sold. */
  minPackUsd: z.number().nonnegative(),
  /** Over the provider cost (M6): 0.2 is cost + 20 %. */
  markup: z.number().min(0).max(5),
  /** Granted once per verified email (M7). */
  trialGrantUsd: z.number().nonnegative(),
  quoteThresholdUsd: z.number().nonnegative(),
  estimateSafetyFactor: z.number().min(1).max(10),
  lowBalanceWarningUsd: z.number().nonnegative(),
  /** An unsettled hold is released this long after it was placed (L5). */
  holdExpiryMinutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
  /** Proxy requests per account per minute (S4). */
  requestsPerMinute: z.number().int().positive(),
  /** Characters of message content per proxy request (S4). */
  maxInputChars: z.number().int().positive().max(2_000_000),
  /** Unused balance is refundable this long after purchase (author decision, unconfirmed window). */
  refundWindowDays: z.number().int().nonnegative(),
  /** A signed webhook older than this is refused as a replay (S5). */
  webhookMaxAgeHours: z.number().int().positive(),
  models: z.array(HostedModelPrice).min(1),
  routing: HostedRouting,
  wordCosts: WordCostConstants
})
export type BillingConfig = z.infer<typeof BillingConfig>

export const DEFAULT_BILLING_CONFIG: BillingConfig = {
  appPriceUsd: 30,
  minPackUsd: 10,
  markup: 0.2,
  trialGrantUsd: 2,
  quoteThresholdUsd: 0.25,
  estimateSafetyFactor: 1.2,
  lowBalanceWarningUsd: 2,
  holdExpiryMinutes: 10,
  requestsPerMinute: 60,
  maxInputChars: AI_COMPLETE_MAX_CHARS,
  refundWindowDays: 30,
  webhookMaxAgeHours: 72,
  models: [...DEFAULT_HOSTED_MODELS],
  routing: DEFAULT_HOSTED_ROUTING,
  wordCosts: DEFAULT_WORD_COSTS
}

/** The `billing_config` key for each field: the spec's names where it has one. */
export const CONFIG_KEYS: Readonly<Record<string, keyof BillingConfig>> = {
  app_price_usd: 'appPriceUsd',
  min_pack_usd: 'minPackUsd',
  markup: 'markup',
  trial_grant_usd: 'trialGrantUsd',
  quote_threshold_usd: 'quoteThresholdUsd',
  estimate_safety_factor: 'estimateSafetyFactor',
  low_balance_warning_usd: 'lowBalanceWarningUsd',
  hold_expiry_minutes: 'holdExpiryMinutes',
  requests_per_minute: 'requestsPerMinute',
  max_input_chars: 'maxInputChars',
  refund_window_days: 'refundWindowDays',
  webhook_max_age_hours: 'webhookMaxAgeHours',
  models: 'models',
  routing: 'routing',
  word_costs: 'wordCosts'
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** Every tier of the routing table must name a model on the price table. */
function routingIsPriced(config: BillingConfig): boolean {
  return Object.values(config.routing.tiers).every(
    (model) => findHostedModel(config.models, model) !== undefined
  )
}

/**
 * The defaults with every valid row applied. Rows are checked one key at a time, then the result
 * as a whole: a routing table that names a model the price table lacks falls back to the default
 * routing, or, if that is unpriced too, to the default price table as well.
 */
export function resolveBillingConfig(
  rows: readonly { key: string; value: string }[]
): BillingConfig {
  const merged: Record<string, unknown> = { ...DEFAULT_BILLING_CONFIG }
  for (const row of rows) {
    const field = CONFIG_KEYS[row.key]
    if (field === undefined) {
      console.warn(`billing_config: unknown key "${row.key}"; ignored`)
      continue
    }
    const parsed = BillingConfig.shape[field].safeParse(parseJson(row.value))
    if (!parsed.success) {
      console.warn(`billing_config: "${row.key}" is not valid; the default stands`)
      continue
    }
    merged[field] = parsed.data
  }

  let config = BillingConfig.parse(merged)
  if (!routingIsPriced(config)) {
    console.warn('billing_config: the routing table names an unpriced model; default routing used')
    config = { ...config, routing: DEFAULT_HOSTED_ROUTING }
    if (!routingIsPriced(config)) config = { ...config, models: [...DEFAULT_HOSTED_MODELS] }
  }
  return config
}

/** The config as the store holds it now; read once per request that needs it. */
export async function loadBillingConfig(store: Store): Promise<BillingConfig> {
  return resolveBillingConfig(await store.readBillingConfig())
}
