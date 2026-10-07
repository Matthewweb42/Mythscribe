import OpenAI, {
  APIConnectionError,
  APIError,
  APIUserAbortError,
  AuthenticationError,
  RateLimitError
} from 'openai'
import { DEFAULT_MODELS, type AiProviderId, type Tier } from '@shared/ai'
import {
  AiCancelledError,
  AiFallbackError,
  AiNetworkError,
  AiProviderError,
  AiQuotaError,
  AiRateLimitError,
  InvalidKeyError,
  type CompletionRequest,
  type CompletionResult,
  type CompletionUsage,
  type Provider,
  type StreamChunk
} from './types'

/** The SDK's `fetch` shape; injectable so tests answer requests without a network. */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface OpenAiProviderOptions {
  fetch?: FetchLike
  /**
   * The tier → model mapping, asked on every request so a Settings change (F-5.11) applies
   * to the next call without rebuilding the client. Defaults to `DEFAULT_MODELS`.
   */
  resolveModel?: (tier: Tier) => string
  /**
   * F-5.15: an OpenAI-compatible server other than OpenAI (a local Ollama or LM Studio). Its
   * requests are logged under `id`, named `label` in error messages, and cap the output with
   * `max_tokens`, the field every compatible server reads (OpenAI's reasoning-era
   * `max_completion_tokens` is not universal).
   */
  baseURL?: string
  id?: AiProviderId
  label?: string
  /**
   * 2026-10-07: OpenRouter (AI-BILLING-SPEC A2), OpenAI-compatible at `OPENROUTER_BASE_URL`.
   * Its own model ids and error copy, its attribution headers, and a key check on `GET /key`
   * (its `/models` answers without a key, so it would not test one).
   */
  openRouter?: boolean
}

/** OpenRouter's optional attribution headers: the app's site and name on its dashboard. */
const OPENROUTER_HEADERS = { 'HTTP-Referer': 'https://mythscribe.app', 'X-Title': 'MythScribe' }

/** The usage block every Chat Completions answer (and the final stream chunk) carries. */
interface UsageBlock {
  prompt_tokens: number
  completion_tokens: number
  prompt_tokens_details?: { cached_tokens?: number } | null
}

/**
 * The SDK's usage in the provider-neutral shape; `cachedInputTokens` only when the provider
 * reported prompt-cache hits (OpenAI and OpenRouter both use `prompt_tokens_details`).
 */
export function usageOf(usage: UsageBlock | undefined | null): CompletionUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens
  return {
    inputTokens: usage?.prompt_tokens ?? 0,
    outputTokens: usage?.completion_tokens ?? 0,
    ...(typeof cached === 'number' && cached >= 0 ? { cachedInputTokens: cached } : {})
  }
}

/**
 * The OpenAI adapter (F-5.1) over Chat Completions. Retries are off: the callers own the retry
 * policy (the job queue, F-5.13; ghost text never retries), and "Test connection" must answer
 * a 429 at once instead of backing off. Every SDK failure is mapped once, in `mapOpenAiError`.
 * This is the only file that imports the `openai` package.
 */
export function buildOpenAiProvider(key: string, options: OpenAiProviderOptions = {}): Provider {
  const client = new OpenAI({
    apiKey: key,
    fetch: options.fetch,
    maxRetries: 0,
    ...(options.baseURL === undefined ? {} : { baseURL: options.baseURL }),
    ...(options.openRouter ? { defaultHeaders: OPENROUTER_HEADERS } : {})
  })
  const resolveModel = options.resolveModel ?? ((tier: Tier): string => DEFAULT_MODELS[tier])
  const label = options.label ?? 'OpenAI'
  const mapError = (err: unknown): AiProviderError =>
    mapOpenAiError(err, label, options.openRouter ? OPENROUTER_NOT_FOUND : undefined)
  const compatible = options.baseURL !== undefined

  const params = (request: CompletionRequest): OpenAI.ChatCompletionCreateParamsNonStreaming => ({
    model: resolveModel(request.tier),
    messages: request.messages,
    ...(compatible
      ? { max_tokens: request.maxTokens }
      : { max_completion_tokens: request.maxTokens }),
    ...(request.json ? { response_format: { type: 'json_object' as const } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature })
  })

  return {
    id: options.id ?? 'openai',
    resolveModel,

    async complete(request): Promise<CompletionResult> {
      try {
        const completion = await client.chat.completions.create(params(request), {
          signal: request.signal
        })
        return {
          text: completion.choices[0]?.message.content ?? '',
          model: completion.model,
          usage: usageOf(completion.usage)
        }
      } catch (err) {
        throw mapError(err)
      }
    },

    async *stream(request): AsyncGenerator<StreamChunk> {
      try {
        // `include_usage`: one final chunk with no choices and the whole request's usage (F-5.4).
        const chunks = await client.chat.completions.create(
          { ...params(request), stream: true, stream_options: { include_usage: true } },
          { signal: request.signal }
        )
        for await (const chunk of chunks) {
          assertNotCancelled(request.signal)
          const delta = chunk.choices[0]?.delta.content ?? ''
          const usage = chunk.usage
          if (usage) {
            yield { delta, usage: usageOf(usage) }
          } else if (delta) {
            yield { delta }
          }
        }
        // The SDK ends an aborted stream quietly instead of throwing (F-5.10); a cancelled
        // request must not read as a short answer that gets logged and cached.
        assertNotCancelled(request.signal)
      } catch (err) {
        throw mapError(err)
      }
    },

    async testConnection(): Promise<{ model: string }> {
      try {
        if (options.openRouter) {
          // OpenRouter's key check: authenticated, token-free, 401 for a bad key.
          await client.get('/key')
          return { model: resolveModel('fast') }
        }
        // A plain authenticated GET: costs no tokens, still answers 401 / 429 like a completion.
        const model = await client.models.retrieve(resolveModel('fast'))
        return { model: model.id }
      } catch (err) {
        throw mapError(err)
      }
    }
  }
}

const CANCELLED_MESSAGE = 'The request was stopped.'

const OPENROUTER_NOT_FOUND =
  'OpenRouter does not have that model. Check the model names in Settings against openrouter.ai/models (ids look like vendor/model).'

function assertNotCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiCancelledError(CANCELLED_MESSAGE)
}

/**
 * The one mapping from SDK errors to the error taxonomy. Messages are fixed copy: OpenAI's own
 * 401 text echoes (a masked form of) the key, and a 400 can echo the request, so neither is
 * passed through. The original error stays reachable as `cause` for the console.
 */
export function mapOpenAiError(err: unknown, label = 'OpenAI', notFound?: string): AiProviderError {
  if (err instanceof AiProviderError) return err
  if (err instanceof APIUserAbortError || (err instanceof Error && err.name === 'AbortError')) {
    return new AiCancelledError(CANCELLED_MESSAGE, err)
  }
  if (err instanceof APIConnectionError) return new AiNetworkError(`Could not reach ${label}.`, err)
  if (err instanceof AuthenticationError) {
    return new InvalidKeyError(`${label} rejected the API key.`, err)
  }
  if (err instanceof RateLimitError) {
    if (err.code === 'insufficient_quota') {
      return new AiQuotaError(`This key's ${label} account has no credit left.`, err)
    }
    return new AiRateLimitError(`${label} is rate-limiting this key.`, err)
  }
  if (err instanceof APIError) {
    // OpenRouter answers 402 when the account's credits are used up.
    if (err.status === 402) {
      return new AiQuotaError(`This key's ${label} account has no credit left.`, err)
    }
    if (err.status === 404 && notFound !== undefined) return new AiFallbackError(notFound, err)
    if (err.status === 404 && label !== 'OpenAI') {
      return new AiFallbackError(
        `${label} does not have that model. Check the model names in Settings, or download it (for Ollama: ollama pull <model>).`,
        err
      )
    }
    const status = typeof err.status === 'number' ? ` (HTTP ${err.status})` : ''
    return new AiFallbackError(`${label} reported a problem${status}.`, err)
  }
  return new AiFallbackError(`${label} reported a problem.`, err)
}
