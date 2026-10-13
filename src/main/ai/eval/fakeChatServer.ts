import type { FetchLike } from '../providers/openai'
import type { AiMessage } from '../providers/types'

/**
 * A fake OpenAI-compatible chat server behind a `fetch` (F-16.22): the live paths' tests point
 * `liveProviderFromEnv` at it, so a live run is driven end to end from `OPENROUTER_API_KEY` alone
 * without a request leaving the machine or a cent being spent. It answers every chat completion
 * with `answer`, reports OpenRouter's `usage.cost`, and records each call (URL, headers, body).
 * Test support only: nothing in the app imports it.
 */

export interface ChatCall {
  url: string
  headers: Headers
  body: Record<string, unknown>
  messages: AiMessage[]
}

export interface ChatServerReply {
  text: string
  finishReason?: string
  /** Tokens in and out the server reports (defaults: 1,000 and 100). */
  usage?: { inputTokens: number; outputTokens: number }
  /** OpenRouter's reported cost in USD (default 0.0001). */
  costUsd?: number
}

export interface ChatServer {
  fetch: FetchLike
  calls: ChatCall[]
}

const isMessage = (value: unknown): value is AiMessage =>
  typeof value === 'object' &&
  value !== null &&
  'role' in value &&
  'content' in value &&
  typeof value.content === 'string' &&
  (value.role === 'system' || value.role === 'user' || value.role === 'assistant')

/** A chat server answering each request with `answer(messages, body)`. */
export function fakeChatServer(
  answer: (messages: AiMessage[], body: Record<string, unknown>) => ChatServerReply
): ChatServer {
  const calls: ChatCall[] = []
  const fetch: FetchLike = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const raw: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    const body: Record<string, unknown> = typeof raw === 'object' && raw !== null ? { ...raw } : {}
    const messages = Array.isArray(body.messages) ? body.messages.filter(isMessage) : []
    calls.push({ url, headers: new Headers(init?.headers), body, messages })
    const reply = answer(messages, body)
    const usage = reply.usage ?? { inputTokens: 1_000, outputTokens: 100 }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          id: `fake-${calls.length}`,
          object: 'chat.completion',
          created: 0,
          model: typeof body.model === 'string' ? body.model : 'fake-model',
          choices: [
            {
              index: 0,
              finish_reason: reply.finishReason ?? 'stop',
              message: { role: 'assistant', content: reply.text }
            }
          ],
          usage: {
            prompt_tokens: usage.inputTokens,
            completion_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
            cost: reply.costUsd ?? 0.0001
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    )
  }
  return { fetch, calls }
}
