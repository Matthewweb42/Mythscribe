import { z } from 'zod'

/**
 * The AI provider surface shared by main and the renderer (F-5.1): provider ids, the model tiers
 * feature code asks for, the error taxonomy every adapter maps onto, and the status the AI tab
 * shows. The key itself never crosses this boundary: status carries only `hasKey` and a mask.
 */

export const AiProviderId = z.enum(['openai'])
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
  'PROVIDER'
])
export type AiErrorCode = z.infer<typeof AiErrorCode>

/** What the author should do about each expected failure; shown under the message in the AI tab. */
export const AI_NEXT_STEP: Record<AiErrorCode, string> = {
  NO_KEY: 'Add a key above and save it.',
  INVALID_KEY: 'Check the key and try again.',
  RATE_LIMIT: 'Wait a moment and retry.',
  QUOTA: 'Add credit to your OpenAI account.',
  NETWORK: 'Check your internet connection and retry.',
  PROVIDER: 'Try again in a moment.'
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

export function testConnectionFailure(code: AiErrorCode, message: string): AiTestConnectionResult {
  return { ok: false, code, message, nextStep: AI_NEXT_STEP[code] }
}
