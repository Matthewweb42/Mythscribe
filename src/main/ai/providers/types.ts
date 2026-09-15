import type { AiErrorCode, AiProviderId, Tier } from '@shared/ai'

/**
 * The provider interface every adapter implements (PLAN.md §3, F-5.1). Feature code in main
 * talks to this and nothing else, so a second adapter (Cloud, Anthropic) is a config change.
 * Provider-agnostic on purpose: only an adapter file may import its SDK.
 */

export interface AiMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionUsage {
  inputTokens: number
  outputTokens: number
}

export interface CompletionRequest {
  /** A tier, never a model name; the adapter maps it (`DEFAULT_MODELS` until F-5.11). */
  tier: Tier
  messages: AiMessage[]
  /** The per-feature output cap (CLAUDE.md, token efficiency rule 6). */
  maxTokens: number
  /** Ask for a JSON object so tags, summaries, and critique parse exactly. */
  json?: boolean
  /** Sampling temperature (the writing preset's, F-5.2); the provider's default when absent. */
  temperature?: number
}

/** `usage` is on every result so the ledger (F-5.14) can price it. */
export interface CompletionResult {
  text: string
  model: string
  usage: CompletionUsage
}

export interface StreamChunk {
  delta: string
  /**
   * The whole request's token count, on the final chunk only (F-5.4: the streamed request
   * path prices it like `complete`'s). Absent when the provider does not report it; the
   * request path then falls back to its own estimate.
   */
  usage?: CompletionUsage
}

export interface Provider {
  readonly id: AiProviderId
  /**
   * The model a tier maps to right now (F-5.11), so the request path (F-5.14) can hash the
   * cache key and estimate the cost before the call; `complete` resolves it again itself.
   */
  resolveModel(tier: Tier): string
  /** Throws an `AiProviderError` subclass for every expected failure. */
  complete(request: CompletionRequest): Promise<CompletionResult>
  /** Same errors as `complete`, thrown from the first `next()` or mid-stream. */
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>
  /** A token-free authenticated request; resolves with the model that answered or throws like `complete`. */
  testConnection(): Promise<{ model: string }>
}

/**
 * The expected failures, one class per `AiErrorCode`. Messages are fixed copy and never carry
 * the key or the request; the original error rides along as `cause` for logs.
 */
export abstract class AiProviderError extends Error {
  abstract readonly code: AiErrorCode
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = 'AiProviderError'
  }
}
export class NoKeyError extends AiProviderError {
  readonly code = 'NO_KEY' as const
}
export class InvalidKeyError extends AiProviderError {
  readonly code = 'INVALID_KEY' as const
}
export class AiRateLimitError extends AiProviderError {
  readonly code = 'RATE_LIMIT' as const
}
export class AiQuotaError extends AiProviderError {
  readonly code = 'QUOTA' as const
}
export class AiNetworkError extends AiProviderError {
  readonly code = 'NETWORK' as const
}
export class AiFallbackError extends AiProviderError {
  readonly code = 'PROVIDER' as const
}
/** The request path refused before sending anything (F-5.14): over the feature budget or the daily cap. */
export class AiBudgetError extends AiProviderError {
  readonly code = 'BUDGET' as const
}
/**
 * The AI dial or the feature's own toggle refused the request before anything was sent
 * (F-14.4, `assertFeatureAllowed`); the next step names the Settings tab that changes it.
 */
export class AiDisabledError extends AiProviderError {
  readonly code = 'DISABLED' as const
}
