import OpenAI, { APIConnectionError, APIError, AuthenticationError, RateLimitError } from 'openai'
import { DEFAULT_MODELS, type Tier } from '@shared/ai'
import {
  AiFallbackError,
  AiNetworkError,
  AiProviderError,
  AiQuotaError,
  AiRateLimitError,
  InvalidKeyError,
  type CompletionRequest,
  type CompletionResult,
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
}

/**
 * The OpenAI adapter (F-5.1) over Chat Completions. Retries are off: the callers own the retry
 * policy (the job queue, F-5.13; ghost text never retries), and "Test connection" must answer
 * a 429 at once instead of backing off. Every SDK failure is mapped once, in `mapOpenAiError`.
 * This is the only file that imports the `openai` package.
 */
export function buildOpenAiProvider(key: string, options: OpenAiProviderOptions = {}): Provider {
  const client = new OpenAI({ apiKey: key, fetch: options.fetch, maxRetries: 0 })
  const resolveModel = options.resolveModel ?? ((tier: Tier): string => DEFAULT_MODELS[tier])

  const params = (request: CompletionRequest): OpenAI.ChatCompletionCreateParamsNonStreaming => ({
    model: resolveModel(request.tier),
    messages: request.messages,
    max_completion_tokens: request.maxTokens,
    ...(request.json ? { response_format: { type: 'json_object' as const } } : {}),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature })
  })

  return {
    id: 'openai',
    resolveModel,

    async complete(request): Promise<CompletionResult> {
      try {
        const completion = await client.chat.completions.create(params(request))
        return {
          text: completion.choices[0]?.message.content ?? '',
          model: completion.model,
          usage: {
            inputTokens: completion.usage?.prompt_tokens ?? 0,
            outputTokens: completion.usage?.completion_tokens ?? 0
          }
        }
      } catch (err) {
        throw mapOpenAiError(err)
      }
    },

    async *stream(request): AsyncGenerator<StreamChunk> {
      try {
        // `include_usage`: one final chunk with no choices and the whole request's usage (F-5.4).
        const chunks = await client.chat.completions.create({
          ...params(request),
          stream: true,
          stream_options: { include_usage: true }
        })
        for await (const chunk of chunks) {
          const delta = chunk.choices[0]?.delta.content ?? ''
          const usage = chunk.usage
          if (usage) {
            yield {
              delta,
              usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens }
            }
          } else if (delta) {
            yield { delta }
          }
        }
      } catch (err) {
        throw mapOpenAiError(err)
      }
    },

    async testConnection(): Promise<{ model: string }> {
      try {
        // A plain authenticated GET: costs no tokens, still answers 401 / 429 like a completion.
        const model = await client.models.retrieve(resolveModel('fast'))
        return { model: model.id }
      } catch (err) {
        throw mapOpenAiError(err)
      }
    }
  }
}

/**
 * The one mapping from SDK errors to the error taxonomy. Messages are fixed copy: OpenAI's own
 * 401 text echoes (a masked form of) the key, and a 400 can echo the request, so neither is
 * passed through. The original error stays reachable as `cause` for the console.
 */
export function mapOpenAiError(err: unknown): AiProviderError {
  if (err instanceof AiProviderError) return err
  if (err instanceof APIConnectionError) return new AiNetworkError('Could not reach OpenAI.', err)
  if (err instanceof AuthenticationError) {
    return new InvalidKeyError('OpenAI rejected the API key.', err)
  }
  if (err instanceof RateLimitError) {
    if (err.code === 'insufficient_quota') {
      return new AiQuotaError("This key's OpenAI account has no credit left.", err)
    }
    return new AiRateLimitError('OpenAI is rate-limiting this key.', err)
  }
  if (err instanceof APIError) {
    const status = typeof err.status === 'number' ? ` (HTTP ${err.status})` : ''
    return new AiFallbackError(`OpenAI reported a problem${status}.`, err)
  }
  return new AiFallbackError('OpenAI reported a problem.', err)
}
