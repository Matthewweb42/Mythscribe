import { z } from 'zod'

/**
 * The AI provider surface shared by main and the renderer (F-5.1): provider ids, the model tiers
 * feature code asks for, the error taxonomy every adapter maps onto, and the status the AI tab
 * shows. The key itself never crosses this boundary: status carries only `hasKey` and a mask.
 */

/** The provider ids as a tuple, so Drizzle enum columns and the zod enum share one owner. */
export const AI_PROVIDER_IDS = ['openai'] as const
export const AiProviderId = z.enum(AI_PROVIDER_IDS)
export type AiProviderId = z.infer<typeof AiProviderId>

export const AI_PROVIDER_LABEL: Record<AiProviderId, string> = { openai: 'OpenAI' }

/** Feature code requests a tier, never a model name (CLAUDE.md, token efficiency rule 1). */
export const Tier = z.enum(['fast', 'strong'])
export type Tier = z.infer<typeof Tier>

/** What each tier serves (CLAUDE.md, token efficiency rule 1); shown under the model fields in Settings. */
export const TIER_USE: Record<Tier, string> = {
  fast: 'Ghost text, tags, summaries, and classification.',
  strong: 'Author mode, critique, and Story Intelligence queries.'
}

/**
 * The default tier → model mapping; the effective one is the `models` setting (F-5.11), read
 * live by the provider on every request. Snapshots and `-chat-latest` aliases are avoided so
 * golden tests stay stable.
 */
export const DEFAULT_MODELS: Record<Tier, string> = { fast: 'gpt-5.4-mini', strong: 'gpt-5.4' }

export const AI_MODEL_MAX = 100
/** A model id as entered in Settings (F-5.11); non-empty, trimmed, bounded. */
export const ModelName = z.string().trim().min(1).max(AI_MODEL_MAX)
/** The tier → model mapping for one provider; feature code never sees this, only the tier. */
export const AiModelMap = z.object({ fast: ModelName, strong: ModelName })
export type AiModelMap = z.infer<typeof AiModelMap>
/**
 * One map per provider id. zod's enum-keyed record is exhaustive: a new `AiProviderId` member
 * is a parse and type error here until `defaultAiModels` gets defaults for it too.
 */
export const AiModels = z.record(AiProviderId, AiModelMap)
export type AiModels = z.infer<typeof AiModels>

export function defaultAiModels(): AiModels {
  return { openai: { ...DEFAULT_MODELS } }
}

/** Length bounds for a key as entered; a shape outside them is refused with VALIDATION. */
export const AI_KEY_MIN = 10
export const AI_KEY_MAX = 300

/** What the author sees once a key is saved: the first three characters, an ellipsis, the last four. */
export function maskKey(key: string): string {
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export const AiErrorCode = z.enum([
  'NO_KEY',
  'INVALID_KEY',
  'RATE_LIMIT',
  'QUOTA',
  'NETWORK',
  'PROVIDER',
  'BUDGET',
  'DISABLED',
  // F-5.10: the author stopped the request; never logged, never cached, never toasted.
  'CANCELLED'
])
export type AiErrorCode = z.infer<typeof AiErrorCode>

/** What the author should do about each expected failure; shown under the message in the AI tab. */
export const AI_NEXT_STEP: Record<AiErrorCode, string> = {
  NO_KEY: 'Add a key above and save it.',
  INVALID_KEY: 'Check the key and try again.',
  RATE_LIMIT: 'Wait a moment and retry.',
  QUOTA: 'Add credit to your OpenAI account.',
  NETWORK: 'Check your internet connection and retry.',
  PROVIDER: 'Try again in a moment.',
  BUDGET: 'Raise the daily cap in Settings or wait until tomorrow.',
  DISABLED: 'Turn the AI dial up in Settings, or enable the feature there.',
  CANCELLED: 'Send it again whenever you like.'
}

/**
 * How the stored key is protected: `os` is the platform keychain, `plain` is Electron's
 * obfuscating fallback on a Linux box without a keyring, `none` means the key cannot be stored.
 */
export const AiKeyEncryption = z.enum(['os', 'plain', 'none'])
export type AiKeyEncryption = z.infer<typeof AiKeyEncryption>

export const AiStatus = z.object({
  provider: AiProviderId,
  hasKey: z.boolean(),
  /** The masked key while one is saved, null otherwise. */
  hint: z.string().nullable(),
  encryption: AiKeyEncryption,
  /** The effective tier → model mapping for `provider` (F-5.11). */
  models: AiModelMap
})
export type AiStatus = z.infer<typeof AiStatus>

export const AiTestConnectionResult = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), model: z.string() }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type AiTestConnectionResult = z.infer<typeof AiTestConnectionResult>

/** The failure branch every `ai:*` channel answers as data: the code, its message, and the next step. */
export function aiFailure(
  code: AiErrorCode,
  message: string
): { ok: false; code: AiErrorCode; message: string; nextStep: string } {
  return { ok: false, code, message, nextStep: AI_NEXT_STEP[code] }
}

export function testConnectionFailure(code: AiErrorCode, message: string): AiTestConnectionResult {
  return aiFailure(code, message)
}

/** The provider's token count for one request, as the result of a feature channel carries it. */
export const AiUsage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative()
})
export type AiUsage = z.infer<typeof AiUsage>

/** Characters of plain text a document needs before tag suggestions can be asked for (F-4.7). */
export const TAGS_MIN_CHARS = 50

/**
 * The caret window ghost text sends (F-5.3; CLAUDE.md, token efficiency rule 2): at most this
 * many characters of manuscript text before the caret and after it. One owner for the IPC
 * contract's bounds, the prompt, and the renderer's slicer, so the data-sharing panel's line
 * stays true.
 */
export const GHOST_BEFORE_CHARS = 500
export const GHOST_AFTER_CHARS = 100

/**
 * Every AI feature, built or not (F-5.14, F-14.4), as a tuple so the ledger's `feature` column,
 * the dial's per-feature toggles, and the data-sharing registry (`AI_DATA_SHARING` in
 * `aiSettings.ts`) share one owner. The string values are stored in project settings and ledger
 * rows, so a member is never renamed. A feature's budget lines join `FEATURE_BUDGETS` and
 * `FEATURE_INPUT_BUDGETS` in the change that builds it (F-5.3 ghost text, F-4.7 tags, F-5.6
 * summaries, F-5.4 chat, F-5.5 Author mode, F-5.7 queries, F-14.8 critique, F-5.8 embeddings,
 * F-14.10 rewrite).
 */
export const AI_FEATURE_IDS = [
  'ghostText',
  'tags',
  'summary',
  'chat',
  'authorMode',
  'query',
  'critique',
  'embeddings',
  // F-14.10: rewrite-in-my-voice on a selection.
  'rewrite'
] as const
export const AiFeatureId = z.enum(AI_FEATURE_IDS)
export type AiFeatureId = z.infer<typeof AiFeatureId>

/**
 * The output cap for a feature with no `FEATURE_BUDGETS` line yet: short, so a feature that
 * reaches the request path before its budget is set cannot run long. Not a licence to skip the
 * line (CLAUDE.md, token efficiency rule 6).
 */
export const DEFAULT_OUTPUT_BUDGET = 150
/** The prompt cap for a feature with no `FEATURE_INPUT_BUDGETS` line yet: one long scene plus the bible context. */
export const DEFAULT_INPUT_BUDGET = 8_000

/** Hard cap on `max_tokens` per built feature (CLAUDE.md, token efficiency rule 6); the request path clamps to `outputBudget`. */
export const FEATURE_BUDGETS: Partial<Record<AiFeatureId, number>> = {
  ghostText: 60,
  tags: 200,
  summary: 150,
  // F-5.4: ten paragraphs at ~120 tokens each in Agent mode; Plan answers share the cap.
  chat: 1_200,
  // F-14.10: a 4,000-character passage (~1,000 tokens) rewritten at up to 1.5× its length.
  rewrite: 1_500,
  // F-14.8: up to 8 editor's notes as JSON, each with a quote, a reason, and an optional fix.
  critique: 1_500
}

/**
 * Hard cap on the estimated prompt tokens per built feature (CLAUDE.md, token efficiency rule 8):
 * ghost text sends ~500 characters at the caret plus a short brief; tags and summaries send one
 * scene (a long scene runs ~4 000 words) plus the bible context. A request over its cap is
 * refused with `BUDGET` before anything is sent; trimming to fit is the context builder's job.
 */
export const FEATURE_INPUT_BUDGETS: Partial<Record<AiFeatureId, number>> = {
  ghostText: 1_500,
  tags: 8_000,
  summary: 8_000,
  // F-5.4: one scene head-truncated to 6 000 characters, the voice block, referenced notes, and ten turns of history.
  chat: 8_000,
  // F-14.10: the passage (≤ 4,000 characters), 300 characters of context each side, the metadata, and the voice block.
  rewrite: 3_000,
  // F-14.8: one scene head-truncated to 20,000 characters, its notes, the metadata, and the voice block.
  critique: 8_000
}

/** The feature's `max_tokens` cap, or `DEFAULT_OUTPUT_BUDGET` until its line exists. */
export function outputBudget(feature: AiFeatureId): number {
  return FEATURE_BUDGETS[feature] ?? DEFAULT_OUTPUT_BUDGET
}

/** The feature's prompt-token cap, or `DEFAULT_INPUT_BUDGET` until its line exists. */
export function inputBudget(feature: AiFeatureId): number {
  return FEATURE_INPUT_BUDGETS[feature] ?? DEFAULT_INPUT_BUDGET
}

/** USD per million tokens for one model; `priced: false` marks a model this table does not know. */
export interface ModelPrice {
  inUsdPerM: number
  outUsdPerM: number
  priced: boolean
}

/**
 * Published OpenAI rates (USD per million tokens, standard tier, no batch discount), keyed by
 * the exact model id since the tier → model mapping is a setting. Copied from OpenAI's pricing
 * page; nothing fetches it, so keep it current by hand when a default model changes. A model
 * outside this table costs 0 with `priced: false` (the ledger never invents a price).
 */
export const MODEL_PRICING: Record<string, ModelPrice> = {
  'gpt-5.4': { inUsdPerM: 1.25, outUsdPerM: 10, priced: true },
  'gpt-5.4-mini': { inUsdPerM: 0.25, outUsdPerM: 2, priced: true },
  'gpt-5.4-nano': { inUsdPerM: 0.05, outUsdPerM: 0.4, priced: true }
}

const UNPRICED: ModelPrice = { inUsdPerM: 0, outUsdPerM: 0, priced: false }

/** The cost of `inTok` prompt and `outTok` completion tokens on `model`; 0 and unpriced for an unknown model. */
export function priceFor(
  model: string,
  inTok: number,
  outTok: number
): { costUsd: number; priced: boolean } {
  const price = MODEL_PRICING[model] ?? UNPRICED
  return {
    costUsd: (inTok * price.inUsdPerM + outTok * price.outUsdPerM) / 1_000_000,
    priced: price.priced
  }
}

/**
 * A local token estimate (about four characters per token for English prose), used only for
 * the pre-flight budget and cap guards, never logged: the ledger records the provider's count.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Bounds for the app-wide daily spend cap (USD); 0 pauses AI for the day. */
export const DAILY_CAP_MIN = 0
export const DAILY_CAP_MAX = 500
export const DEFAULT_DAILY_CAP_USD = 2
export const DailyCapUsd = z.number().min(DAILY_CAP_MIN).max(DAILY_CAP_MAX)

const UsageTotals = z.object({ requests: z.number(), tokens: z.number(), costUsd: z.number() })
export type UsageTotals = z.infer<typeof UsageTotals>

/**
 * What the AI tab's Usage block shows (F-5.14). `today` and `dailyCapUsd` are app-wide (every
 * project opened today spends against one cap); `total` and `byFeature` are the open project's
 * ledger since it was created.
 */
export const AiUsageSummary = z.object({
  today: UsageTotals,
  total: UsageTotals,
  byFeature: z.array(UsageTotals.extend({ feature: z.string() })),
  dailyCapUsd: DailyCapUsd
})
export type AiUsageSummary = z.infer<typeof AiUsageSummary>
