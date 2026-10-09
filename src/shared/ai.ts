import { z } from 'zod'

/**
 * The AI provider surface shared by main and the renderer (F-5.1): provider ids, the model tiers
 * feature code asks for, the error taxonomy every adapter maps onto, and the status the AI tab
 * shows. The key itself never crosses this boundary: status carries only `hasKey` and a mask.
 */

/** The provider ids as a tuple, so Drizzle enum columns and the zod enum share one owner. */
export const AI_PROVIDER_IDS = ['openai', 'cloud', 'local', 'openrouter'] as const
export const AiProviderId = z.enum(AI_PROVIDER_IDS)
export type AiProviderId = z.infer<typeof AiProviderId>

export const AI_PROVIDER_LABEL: Record<AiProviderId, string> = {
  openai: 'OpenAI',
  cloud: 'MythScribe Cloud',
  local: 'Local model',
  openrouter: 'OpenRouter'
}

/**
 * The providers an own key can be for (AI-BILLING-SPEC A2): OpenRouter, the default since
 * 2026-10-07 (one key, every model), or OpenAI directly. App-wide, like the key itself.
 */
export const OWN_KEY_PROVIDERS = ['openrouter', 'openai'] as const
export const OwnKeyProvider = z.enum(OWN_KEY_PROVIDERS)
export type OwnKeyProvider = z.infer<typeof OwnKeyProvider>
export const DEFAULT_OWN_KEY_PROVIDER: OwnKeyProvider = 'openrouter'

/**
 * The own-key provider in effect. A choice the author made wins; with none stored, an install
 * that already holds an OpenAI key keeps using it (never break a working setup), and anything
 * else gets the default, OpenRouter.
 */
export function effectiveOwnKeyProvider(
  stored: OwnKeyProvider | undefined,
  hasOpenAiKey: boolean
): OwnKeyProvider {
  if (stored !== undefined) return stored
  return hasOpenAiKey ? 'openai' : DEFAULT_OWN_KEY_PROVIDER
}

/** OpenRouter's OpenAI-compatible API root; the OpenAI adapter talks to it with a `baseURL`. */
export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'

/** Feature code requests a tier, never a model name (CLAUDE.md, token efficiency rule 1). */
export const Tier = z.enum(['fast', 'strong'])
export type Tier = z.infer<typeof Tier>

/** What each tier serves (CLAUDE.md, token efficiency rule 1); shown under the model fields in Settings. */
export const TIER_USE: Record<Tier, string> = {
  fast: 'Ghost text, tags, summaries, proofreading, and classification.',
  strong:
    'Author mode, critique, the beta reader, Story Intelligence queries, and Check consistency.'
}

/**
 * The default tier → model mapping; the effective one is the `models` setting (F-5.11), read
 * live by the provider on every request. Snapshots and `-chat-latest` aliases are avoided so
 * golden tests stay stable.
 */
export const DEFAULT_MODELS: Record<Tier, string> = { fast: 'gpt-5.4-mini', strong: 'gpt-5.4' }

/**
 * The own-key OpenRouter defaults, by OpenRouter's `vendor/model` ids: DeepSeek V4 Flash (fast)
 * and V4 Pro (strong), approved by the author on 2026-10-07 as cheap and permissive enough for
 * dark and romance fiction. MythScribe Cloud defaults to the same two (`HOSTED_DEFAULT_MODELS`).
 */
export const OPENROUTER_DEFAULT_MODELS: Record<Tier, string> = {
  fast: 'deepseek/deepseek-v4-flash',
  strong: 'deepseek/deepseek-v4-pro'
}

/**
 * MythScribe Cloud's default tier models (approved 2026-10-07). The Worker's routing table names
 * the same two (`DEFAULT_HOSTED_ROUTING`) and serves its own in `GET /pricing`, which wins for a
 * tier the author left at a default (`hostedModelFor`).
 */
export const HOSTED_DEFAULT_MODELS: Record<Tier, string> = { ...OPENROUTER_DEFAULT_MODELS }

/** The Cloud defaults before 2026-10-07; a stored map still holding them was never chosen. */
export const LEGACY_HOSTED_DEFAULT_MODELS: Record<Tier, string> = { ...DEFAULT_MODELS }

/**
 * F-5.15: what a local server is asked for until the author names their own models. Ollama's
 * names; one model for both tiers, since most machines hold one model in memory at a time.
 */
export const LOCAL_DEFAULT_MODELS: Record<Tier, string> = { fast: 'llama3.1', strong: 'llama3.1' }

/** The default tier → model mapping of one provider (F-5.11 "Reset to defaults"). */
export function defaultModelsFor(provider: AiProviderId): Record<Tier, string> {
  if (provider === 'local') return { ...LOCAL_DEFAULT_MODELS }
  if (provider === 'openrouter') return { ...OPENROUTER_DEFAULT_MODELS }
  if (provider === 'cloud') return { ...HOSTED_DEFAULT_MODELS }
  return { ...DEFAULT_MODELS }
}

/**
 * F-5.15: where the local model answers. Any OpenAI-compatible server: Ollama's default is
 * below; LM Studio's is `http://localhost:1234/v1`. App-wide, like the key.
 */
export const LOCAL_AI_DEFAULT_BASE_URL = 'http://localhost:11434/v1'
export const LOCAL_AI_BASE_URL_MAX = 300
export const LocalAiBaseUrl = z
  .string()
  .trim()
  .max(LOCAL_AI_BASE_URL_MAX)
  .refine((value) => /^https?:\/\/[^\s/]+/i.test(value), 'Enter an http:// or https:// address')
export const LocalAiSettings = z.object({ baseUrl: LocalAiBaseUrl })
export type LocalAiSettings = z.infer<typeof LocalAiSettings>

export function defaultLocalAiSettings(): LocalAiSettings {
  return { baseUrl: LOCAL_AI_DEFAULT_BASE_URL }
}

/** Whether an endpoint is on this computer, so "nothing leaves the machine" holds (F-5.15). */
export function isLoopbackUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.replace(/^\[|\]$/g, '')
    return host === 'localhost' || host === '::1' || host.startsWith('127.')
  } catch {
    return false
  }
}

export const AI_MODEL_MAX = 100
/** A model id as entered in Settings (F-5.11); non-empty, trimmed, bounded. */
export const ModelName = z.string().trim().min(1).max(AI_MODEL_MAX)
/** The tier → model mapping for one provider; feature code never sees this, only the tier. */
export const AiModelMap = z.object({ fast: ModelName, strong: ModelName })
export type AiModelMap = z.infer<typeof AiModelMap>
/**
 * One map per provider id, spelled out rather than an enum-keyed record: a file written before
 * a provider existed (F-15.4 added `cloud`) carries only the older keys, and a record would
 * fail the whole app state — recents included — instead of filling the new map in. A new
 * `AiProviderId` member is a type error here until it gets its own defaulted field.
 */
export const AiModels = z.object({
  openai: AiModelMap,
  /**
   * F-15.4: the models the MythScribe Cloud proxy is asked for. A tier left at a default (this
   * one or the pre-2026-10-07 one) follows the server's routing table (`hostedModelFor`).
   */
  cloud: AiModelMap.default(() => ({ ...HOSTED_DEFAULT_MODELS })),
  /** F-5.15: the models a local OpenAI-compatible server is asked for. */
  local: AiModelMap.default(() => ({ ...LOCAL_DEFAULT_MODELS })),
  /** 2026-10-07: the models an OpenRouter key asks for, by OpenRouter's ids. */
  openrouter: AiModelMap.default(() => ({ ...OPENROUTER_DEFAULT_MODELS }))
})
export type AiModels = z.infer<typeof AiModels>

export function defaultAiModels(): AiModels {
  return {
    openai: { ...DEFAULT_MODELS },
    cloud: { ...HOSTED_DEFAULT_MODELS },
    local: { ...LOCAL_DEFAULT_MODELS },
    openrouter: { ...OPENROUTER_DEFAULT_MODELS }
  }
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
  'CANCELLED',
  // F-15.4: the project sends its requests through MythScribe Cloud but no account is signed in.
  'SIGNED_OUT',
  // F-15.4: the Cloud proxy refused the request because the account's balance is used up.
  'NO_CREDIT',
  // The project's source is MythScribe Cloud, which does not serve AI yet (`CLOUD_AI_AVAILABLE`),
  // or the Worker answered `/ai/complete` with NOT_FOUND.
  'CLOUD_UNAVAILABLE',
  // AI-BILLING-SPEC S4: the Cloud proxy refused a request longer than its configured input cap.
  'TOO_LARGE',
  // The Cloud proxy does not sell the requested model (not on its price table, or gone upstream).
  'MODEL_UNAVAILABLE',
  // AI-BILLING-SPEC M1: the 30-day trial has ended without the app license; the app is read-only.
  'TRIAL_ENDED'
])
export type AiErrorCode = z.infer<typeof AiErrorCode>

/** What the author should do about each expected failure; shown under the message in the AI tab. */
export const AI_NEXT_STEP: Record<AiErrorCode, string> = {
  NO_KEY: 'Add a key above and save it.',
  INVALID_KEY: 'Check the key and try again.',
  RATE_LIMIT: 'Wait a moment and retry.',
  QUOTA: 'Add credit to your provider account (OpenRouter or OpenAI).',
  NETWORK: 'Check your internet connection and retry.',
  PROVIDER: 'Try again in a moment.',
  BUDGET: 'Raise the daily cap in Settings or wait until tomorrow.',
  DISABLED: 'Turn on Use AI in Settings › AI, or enable the feature there.',
  CANCELLED: 'Send it again whenever you like.',
  SIGNED_OUT: 'Sign in on the Account tab in Settings.',
  NO_CREDIT: 'Open the Account tab in Settings to add to your balance.',
  CLOUD_UNAVAILABLE: 'Switch to My own key or Local model in Settings › AI.',
  TOO_LARGE: 'Select less text, or ask about a shorter passage, and try again.',
  MODEL_UNAVAILABLE: 'Pick another model in Settings › AI, or reset the models to their defaults.',
  TRIAL_ENDED: 'Buy MythScribe on the Account tab in Settings.'
}

/**
 * How the stored key is protected: `os` is the platform keychain, `plain` is Electron's
 * obfuscating fallback on a Linux box without a keyring, `none` means the key cannot be stored.
 */
export const AiKeyEncryption = z.enum(['os', 'plain', 'none'])
export type AiKeyEncryption = z.infer<typeof AiKeyEncryption>

export const AiStatus = z.object({
  /**
   * The provider an own key is for (`OwnKeyProvider`, AI-BILLING-SPEC A2); `hasKey` and `hint`
   * describe that provider's key.
   */
  provider: AiProviderId,
  hasKey: z.boolean(),
  /** The masked key while one is saved, null otherwise. */
  hint: z.string().nullable(),
  encryption: AiKeyEncryption,
  /**
   * Whether a provider key can be saved here (AI-BILLING-SPEC S2: only in the OS keychain).
   * Main owns the rule; absent from an older main, where `encryption` decides.
   */
  canStoreKey: z.boolean().optional(),
  /**
   * The effective tier → model mapping of every provider (F-5.11); the AI tab edits the map of
   * the source the project sends through (F-15.4), so both are carried rather than one.
   */
  models: AiModels,
  /** F-5.15: the local server's address. */
  local: LocalAiSettings
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
 * F-14.10 rewrite, F-14.3 brief, F-13.4 continuity, F-14.12 proofread, F-5.19 route, F-5.20
 * synopsis and notes suggestions, F-5.22 the chat agent).
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
  'rewrite',
  // F-14.3: drafting a scene's brief from its text.
  'brief',
  // F-14.11: the beta-reader read-through up to a scene, over the scene summaries.
  'betaReader',
  // F-12.3: chapter and scene boundaries, titles, and tag candidates for an imported manuscript.
  'importStructure',
  // F-13.4: the consistency checker, a scene against the story bible.
  'continuity',
  // F-14.12: the proofreading pass over a scene or a selection.
  'proofread',
  // F-5.17: the "What should come next?" quick action, three short directions as JSON.
  'whatNext',
  // F-5.19: the assistant router, which picks the feature that answers a chat message.
  'route',
  // F-5.20: a suggested synopsis for the side panel.
  'synopsis',
  // F-5.20: suggested key points for the scene's notes.
  'notesSuggest',
  // F-14.14: the learned style notes, refreshed in the background from the author's own prose.
  'voiceNotes',
  // F-14.15: the edit passes (developmental, line, copy, proofread, continuity, custom).
  'editPass',
  // F-5.22: the chat agent, which looks things up in the project before it answers or edits.
  'agent',
  // F-9.8: the context library, sorting the author's uploaded worldbuilding documents into sheets.
  'contextImport',
  // F-9.9: the review chat, turning the author's instruction into changes to a pending upload review.
  'reviewChat',
  // F-11.1d: plan links, tying the author's planned scenes and beats to the written scene that fulfils them.
  'planLinks',
  // F-9.10: organise, a plan of changes to the tags, the story bible, the notes, and the binder.
  'organise'
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
  // F-5.6: the ~100-token summary, up to four key points, and the characters present as one JSON
  // object; F-5.16 adds up to six observed facts, each with a value and a quote (300 → 600);
  // F-4.13 adds up to eight tags, each a name and a category (600 → 800).
  summary: 800,
  // F-5.4: ten paragraphs at ~120 tokens each in Agent mode; Plan answers share the cap.
  chat: 1_200,
  // F-14.10: a 4,000-character passage (~1,000 tokens) rewritten at up to 1.5× its length.
  rewrite: 1_500,
  // F-14.8: up to 8 editor's notes as JSON, each with a quote, a reason, and an optional fix.
  critique: 1_500,
  // F-14.3: five one-line brief fields as JSON.
  brief: 200,
  // F-14.11: up to 12 reader items as JSON, each with a scene number, a quote, and a note.
  betaReader: 1_200,
  // F-5.7: a short cited answer as JSON with up to 6 citations, each quoting a passage.
  query: 600,
  // F-12.3: one chunk's breaks, scene titles, and tag candidates as JSON.
  importStructure: 400,
  // F-13.4: up to 6 contradictions as JSON, each with a reference number, a quote, a reason, and a fix.
  continuity: 800,
  // F-14.12: up to 30 fixes as JSON, each a kind, a short quote, and its corrected form.
  proofread: 2_000,
  // F-5.17: three directions as JSON, each a short title and up to ~40 words.
  whatNext: 300,
  // F-5.19: one action id and a one-sentence instruction as JSON.
  route: 120,
  // F-5.20: one synopsis of up to 1,000 characters as JSON.
  synopsis: 350,
  // F-5.20: up to 8 key points as JSON, each up to 200 characters.
  notesSuggest: 600,
  // F-14.14: up to 8 style notes of at most 160 characters each as JSON.
  voiceNotes: 400,
  // F-14.15: up to 40 changes or notes for one chunk as JSON, each a quote, a replacement, and a reason.
  editPass: 4_000,
  // F-5.22: one step as JSON: a tool call, or the answer with citations and up to 8 edits. A step
  // asks `AGENT_STEP_MAX_TOKENS` (1,500); the cap is twice that so the one retry of a reply that
  // was cut off can ask for more (2026-10-07).
  agent: 3_000,
  // F-9.8: one chunk's people, places, and things as JSON, each with its fields and details
  // (raised from 3,000 on 2026-10-08: dense worldbuilding pages were cut off).
  contextImport: 6_000,
  // F-9.9: up to 30 operations on the pending review and a one-sentence reply as JSON. A request
  // asks `REVIEW_CHAT_MAX_TOKENS` (1,500); the cap is twice that for the one retry of an answer
  // that was cut off (the agent's pattern).
  reviewChat: 3_000,
  // F-11.1d: up to 30 links as JSON, each two labels and a one-sentence reason.
  planLinks: 400,
  // F-9.10: up to 40 operations on tags, sheets, notes, and the binder as JSON, a sheet's tidied
  // text included. organise.v2 asks `ORGANISE_V2_MAX_TOKENS` (6,000; raised from 5,000 on
  // 2026-10-08 with reasoning off: a large project's chunks were cut off); a chunk whose answer is
  // still cut off is halved rather than asked again.
  organise: 6_000
}

/**
 * Hard cap on the estimated prompt tokens per built feature (CLAUDE.md, token efficiency rule 8):
 * ghost text sends ~500 characters at the caret plus a short brief; tags and summaries send one
 * scene (a long scene runs ~4 000 words) plus the bible context. A request over its cap is
 * refused with `BUDGET` before anything is sent; trimming to fit is the context builder's job.
 */
export const FEATURE_INPUT_BUDGETS: Partial<Record<AiFeatureId, number>> = {
  // F-14.3 raised it from 1,500 for the scene brief block; F-14.9 adds the story bible at its
  // 150-token ghost budget (the maxed regenerate case sits just under 2,000).
  ghostText: 2_200,
  tags: 8_000,
  summary: 8_000,
  // F-5.4: one scene head-truncated to 6 000 characters, the voice block, referenced notes, and ten turns of history.
  chat: 8_000,
  // F-14.10: the passage (≤ 4,000 characters), 300 characters of context each side, the metadata, and the voice block.
  rewrite: 3_000,
  // F-14.8: one scene head-truncated to 20,000 characters, the brief, the metadata, and the voice block.
  critique: 8_000,
  // F-14.3: one scene head-truncated to 20,000 characters and its metadata line.
  brief: 6_000,
  // F-14.11: one scene head-truncated to 20,000 characters plus the summaries and key points of
  // every earlier scene (~250 tokens each); the fit shrinks the scene, then drops the farthest.
  betaReader: 12_000,
  // F-5.7: the top 3 scenes head-truncated to 12,000 characters each plus up to 10 summaries
  // (~250 tokens each) and ten turns of history; the fit shrinks the scenes, then drops
  // summaries, then the lowest-ranked full scene.
  query: 12_000,
  // F-12.3: one chunk of about 2,500 words (~3,400 tokens; long paragraphs shortened), the
  // rules, and the tag bank names.
  importStructure: 6_000,
  // F-13.4: one scene head-truncated to 20,000 characters (in the background only the paragraphs
  // holding a candidate) plus the numbered references within `CONTINUITY_REFS_TOKEN_BUDGET`.
  continuity: 6_000,
  // F-14.12: one scene or selection head-truncated to 20,000 characters, the brief, the voice
  // block, and up to 200 names and dictionary words to leave alone.
  proofread: 8_000,
  // F-5.17: the last 6,000 characters of the scene (or up to the selection's end), the brief,
  // and the story bible at its 400-token budget.
  whatNext: 4_000,
  // F-5.19: the opening 1,000 characters of the message, two turns of 300 characters, the
  // opening of the selection, and the open document's kind and title.
  route: 1_200,
  // F-5.20: one scene head-truncated to 12,000 characters and its stored summary.
  synopsis: 4_000,
  // F-5.20: the scene head-truncated to 12,000 characters, its summary, brief, current notes,
  // the author's focus, and the story bible at its 400-token budget.
  notesSuggest: 6_000,
  // F-14.14: up to 6,000 characters of the author's paragraphs, the previous notes, and the rules.
  voiceNotes: 2_500,
  // F-14.15: one chunk of up to 12,000 characters (~3,000 tokens), the rules, the instruction,
  // the voice block, and the keep list or the story bible.
  editPass: 7_000,
  // F-5.22: per step: the rules, the voice block, the open document (synopsis, notes head,
  // summary, caret window, selection), recent turns, and the tool results so far (each capped at
  // 6,000 characters; the oldest are dropped first when the step would go over).
  agent: 12_000,
  // F-9.8: one chunk of an uploaded document (≤ 16,000 characters, ~4,000 tokens), the rules,
  // the existing sheet names (≤ 6,000 characters), and up to 40 image file names.
  contextImport: 8_000,
  // F-9.9: the rules, the pending review listed within 14,000 characters of items and 3,000 of
  // Project notes, four earlier turns of 400 characters, and the message (≤ 2,000 characters).
  reviewChat: 7_000,
  // F-11.1d: the rules, up to 30 plans and 40 written scenes, each a title cut to 80 characters
  // and a synopsis, beat hint, or summary cut to 240.
  planLinks: 7_000,
  // F-9.10: per chunk: the rules, the instruction (≤ 2,000 characters), the name index of every
  // tag and sheet (≤ 6,000 characters), the local findings about what the chunk lists, and one
  // chunk of the listing (≤ 14,000 characters of tags, sheets with their fields and observed
  // facts, notes, or outline).
  organise: 8_000
}

/** The feature's `max_tokens` cap, or `DEFAULT_OUTPUT_BUDGET` until its line exists. */
export function outputBudget(feature: AiFeatureId): number {
  return FEATURE_BUDGETS[feature] ?? DEFAULT_OUTPUT_BUDGET
}

/** The feature's prompt-token cap, or `DEFAULT_INPUT_BUDGET` until its line exists. */
export function inputBudget(feature: AiFeatureId): number {
  return FEATURE_INPUT_BUDGETS[feature] ?? DEFAULT_INPUT_BUDGET
}

/**
 * How much a reasoning model may think before it answers (2026-10-07, "measure, then decide"):
 * `default` sends nothing, so the model does what it does by default; `low` asks for little
 * thinking; `off` asks for none. Sent to OpenRouter as its `reasoning` request parameter
 * (`reasoningParam`); other providers ignore it. Every output cap budgets visible text only, which
 * holds when reasoning is off; with reasoning on, thinking tokens count against the same cap.
 */
export const REASONING_MODES = ['off', 'low', 'default'] as const
export const ReasoningMode = z.enum(REASONING_MODES)
export type ReasoningMode = z.infer<typeof ReasoningMode>

/** What Settings says for each reasoning mode. */
export const REASONING_LABEL: Record<ReasoningMode, string> = {
  off: 'Off',
  low: 'Low',
  default: "The model's default"
}

/**
 * OpenRouter's `reasoning` request parameter for a mode (its unified reasoning control:
 * `{ enabled: false }` turns thinking off on models that can skip it, `{ effort: 'low' }` asks
 * for little); undefined for `default`, which sends nothing, so the request is unchanged.
 */
export function reasoningParam(
  mode: ReasoningMode
): { enabled: false } | { effort: 'low' } | undefined {
  if (mode === 'off') return { enabled: false }
  if (mode === 'low') return { effort: 'low' }
  return undefined
}

/** USD per million tokens for one model; `priced: false` marks a model this table does not know. */
export interface ModelPrice {
  inUsdPerM: number
  outUsdPerM: number
  /** The price of an input token the provider served from its prompt cache (AI-BILLING-SPEC R6). */
  cachedInUsdPerM?: number
  priced: boolean
  /** The model's reasoning mode on an own key (2026-10-07); absent is `default`. */
  reasoning?: ReasoningMode
}

/**
 * Published OpenAI rates (USD per million tokens, standard tier, no batch discount), keyed by
 * the exact model id since the tier → model mapping is a setting. Copied from OpenAI's pricing
 * page; nothing fetches it, so keep it current by hand when a default model changes. A model
 * outside this table costs 0 with `priced: false` (the ledger never invents a price). Checked
 * against developers.openai.com/api/docs/pricing on 2026-10-05 (`gpt-5.4` at the under-272K
 * context rate). Cached input is a tenth of the input rate (AI-BILLING-SPEC R6); a model with no
 * cached price bills cached tokens at the full input rate, over-counted, never under-counted.
 * This is the own-key estimate only: hosted prices come from the server (`GET /pricing`, cached
 * by `CloudPricingService`), with `bundledPricing` (`hostedPricing.ts`) until it has answered.
 */
const GPT_5_4: ModelPrice = { inUsdPerM: 2.5, outUsdPerM: 15, cachedInUsdPerM: 0.25, priced: true }
const GPT_5_4_MINI: ModelPrice = {
  inUsdPerM: 0.75,
  outUsdPerM: 4.5,
  cachedInUsdPerM: 0.075,
  priced: true
}
const GPT_5_4_NANO: ModelPrice = {
  inUsdPerM: 0.2,
  outUsdPerM: 1.25,
  cachedInUsdPerM: 0.02,
  priced: true
}
export const MODEL_PRICING: Record<string, ModelPrice> = {
  'gpt-5.4': GPT_5_4,
  'gpt-5.4-mini': GPT_5_4_MINI,
  'gpt-5.4-nano': GPT_5_4_NANO
}

/**
 * The models by their OpenRouter ids (2026-10-07). OpenRouter passes the provider's price
 * through, so the OpenAI ones carry the same rates; the DeepSeek defaults are OpenRouter's live
 * prices of 2026-10-07 (re-check whenever a default changes).
 */
export const OPENROUTER_PRICING: Record<string, ModelPrice> = {
  'deepseek/deepseek-v4-flash': {
    inUsdPerM: 0.03,
    outUsdPerM: 1.28,
    cachedInUsdPerM: 0.03,
    priced: true
  },
  'deepseek/deepseek-v4-pro': {
    inUsdPerM: 0.21,
    outUsdPerM: 0.42,
    cachedInUsdPerM: 0.017,
    priced: true
  },
  'openai/gpt-5.4': GPT_5_4,
  'openai/gpt-5.4-mini': GPT_5_4_MINI,
  'openai/gpt-5.4-nano': GPT_5_4_NANO
}

const UNPRICED: ModelPrice = { inUsdPerM: 0, outUsdPerM: 0, priced: false }

/**
 * The bundled reasoning mode of a model (its price-table entry's `reasoning`), `default` for a
 * model the tables do not know or do not set. Settings › AI can override it per tier.
 */
export function bundledReasoning(model: string): ReasoningMode {
  return (MODEL_PRICING[model] ?? OPENROUTER_PRICING[model])?.reasoning ?? 'default'
}

/**
 * The cost of `inTok` prompt and `outTok` completion tokens on `model`, of which `cachedInTok`
 * prompt tokens were served from the provider's cache at the cached-input price; 0 and unpriced
 * for an unknown model.
 */
export function priceFor(
  model: string,
  inTok: number,
  outTok: number,
  cachedInTok = 0
): { costUsd: number; priced: boolean } {
  const price = MODEL_PRICING[model] ?? OPENROUTER_PRICING[model] ?? UNPRICED
  return { costUsd: costOf(price, inTok, outTok, cachedInTok), priced: price.priced }
}

/** USD for one request at `price`; cached prompt tokens (at most `inTok`) at the cached rate. */
export function costOf(
  price: Pick<ModelPrice, 'inUsdPerM' | 'outUsdPerM' | 'cachedInUsdPerM'>,
  inTok: number,
  outTok: number,
  cachedInTok = 0
): number {
  const cached = Math.min(Math.max(cachedInTok, 0), inTok)
  const cachedRate = price.cachedInUsdPerM ?? price.inUsdPerM
  return (
    ((inTok - cached) * price.inUsdPerM + cached * cachedRate + outTok * price.outUsdPerM) /
    1_000_000
  )
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

/** One request as the Usage block lists it (F-5.9); the newest rows of the project's ledger. */
export const AiUsageRecent = z.object({
  id: z.string(),
  /** ISO timestamp, as the ledger stored it. */
  at: z.string(),
  feature: z.string(),
  model: z.string(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  /** Prompt tokens the provider served from its cache; null when it did not say (AI-BILLING-SPEC A4). */
  cachedTokens: z.number().int().nonnegative().nullable().optional(),
  costUsd: z.number(),
  cached: z.boolean()
})
export type AiUsageRecent = z.infer<typeof AiUsageRecent>

/** How many of the newest ledger rows `ai:usageSummary` carries. */
export const USAGE_RECENT_LIMIT = 10

/** One page of the usage history (AI-BILLING-SPEC E7): every ledger row, newest first. */
export const USAGE_HISTORY_PAGE = 50
export const AiUsageHistory = z.object({
  rows: z.array(AiUsageRecent),
  /** Every row in the project's ledger, for the pager. */
  total: z.number().int().nonnegative()
})
export type AiUsageHistory = z.infer<typeof AiUsageHistory>

/**
 * What the AI tab's Usage block shows (F-5.14, extended by F-5.9). `today`, `session` and
 * `dailyCapUsd` are app-wide (every project opened today spends against one cap, and the
 * session tally spans every project this run opened); `total`, `byFeature` and `recent` are
 * the open project's ledger since it was created.
 */
export const AiUsageSummary = z.object({
  today: UsageTotals,
  /** This run of the app, across every project (F-5.9); zeroed when the app restarts. */
  session: UsageTotals,
  total: UsageTotals,
  byFeature: z.array(UsageTotals.extend({ feature: z.string() })),
  /** The newest `USAGE_RECENT_LIMIT` requests of this project, newest first. */
  recent: z.array(AiUsageRecent),
  dailyCapUsd: DailyCapUsd
})
export type AiUsageSummary = z.infer<typeof AiUsageSummary>
