import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_MODELS, OPENROUTER_BASE_URL, OPENROUTER_DEFAULT_MODELS } from '@shared/ai'
import { resetInflight } from '../inflight'
import { runAiRequest, runAiStream, sha256 } from '../request'
import { fakeChatServer, type ChatCall } from './fakeChatServer'
import { AiRateLimitError } from '../providers/types'
import {
  LIVE_KEY_MISSING,
  OPENAI_API_URL,
  isLoopbackUrl,
  isOpenRouterUrl,
  liveProviderError,
  liveProviderFromEnv,
  liveRequestDeps,
  liveSettingsFromEnv,
  liveSettingsOrNull,
  openRouterKeyFromEnv,
  type LiveEnv
} from './liveProvider'

/**
 * One key for every live path (F-16.22; plan P2b §3.1): each environment shape gives the right
 * route, flags and models, and a request leaves for the right server as the app sends it, all
 * against a fake `fetch` (no request leaves the machine, nothing is spent).
 */

const OR_KEY = 'sk-or-test-key'
const OPENAI_KEY = 'sk-test-key'

beforeEach(() => {
  resetInflight()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('liveSettingsFromEnv: every environment shape (F-16.22)', () => {
  const shapes: {
    name: string
    env: LiveEnv
    want: {
      keyVar: string
      key: string
      baseURL: string | undefined
      openRouter: boolean
      models: Record<'fast' | 'strong', string>
    }
  }[] = [
    {
      name: 'OPENROUTER_API_KEY alone',
      env: { OPENROUTER_API_KEY: OR_KEY },
      want: {
        keyVar: 'OPENROUTER_API_KEY',
        key: OR_KEY,
        baseURL: OPENROUTER_BASE_URL,
        openRouter: true,
        models: OPENROUTER_DEFAULT_MODELS
      }
    },
    {
      name: 'OPENROUTER_API_KEY wins over OPENAI_API_KEY and its base URL',
      env: {
        OPENROUTER_API_KEY: OR_KEY,
        OPENAI_API_KEY: OPENAI_KEY,
        OPENAI_BASE_URL: 'http://localhost:11434/v1'
      },
      want: {
        keyVar: 'OPENROUTER_API_KEY',
        key: OR_KEY,
        baseURL: OPENROUTER_BASE_URL,
        openRouter: true,
        models: OPENROUTER_DEFAULT_MODELS
      }
    },
    {
      name: 'OPENAI_API_KEY alone (OpenAI itself)',
      env: { OPENAI_API_KEY: OPENAI_KEY },
      want: {
        keyVar: 'OPENAI_API_KEY',
        key: OPENAI_KEY,
        baseURL: undefined,
        openRouter: false,
        models: DEFAULT_MODELS
      }
    },
    {
      name: 'OPENAI_API_KEY with an OpenRouter base URL (the old command)',
      env: { OPENAI_API_KEY: OR_KEY, OPENAI_BASE_URL: 'https://openrouter.ai/api/v1/' },
      want: {
        keyVar: 'OPENAI_API_KEY',
        key: OR_KEY,
        baseURL: 'https://openrouter.ai/api/v1/',
        openRouter: true,
        models: OPENROUTER_DEFAULT_MODELS
      }
    },
    {
      name: 'OPENAI_API_KEY with another compatible server',
      env: { OPENAI_API_KEY: OPENAI_KEY, OPENAI_BASE_URL: 'http://localhost:11434/v1' },
      want: {
        keyVar: 'OPENAI_API_KEY',
        key: OPENAI_KEY,
        baseURL: 'http://localhost:11434/v1',
        openRouter: false,
        models: DEFAULT_MODELS
      }
    },
    {
      name: 'a blank OPENROUTER_API_KEY is unset',
      env: { OPENROUTER_API_KEY: '  ', OPENAI_API_KEY: OPENAI_KEY },
      want: {
        keyVar: 'OPENAI_API_KEY',
        key: OPENAI_KEY,
        baseURL: undefined,
        openRouter: false,
        models: DEFAULT_MODELS
      }
    },
    {
      name: 'the eval model overrides',
      env: {
        OPENROUTER_API_KEY: OR_KEY,
        MYTHSCRIBE_EVAL_FAST_MODEL: 'vendor/fast-one',
        MYTHSCRIBE_EVAL_STRONG_MODEL: 'vendor/strong-one'
      },
      want: {
        keyVar: 'OPENROUTER_API_KEY',
        key: OR_KEY,
        baseURL: OPENROUTER_BASE_URL,
        openRouter: true,
        models: { fast: 'vendor/fast-one', strong: 'vendor/strong-one' }
      }
    }
  ]

  for (const shape of shapes) {
    it(shape.name, () => {
      expect(liveSettingsFromEnv(shape.env)).toEqual(shape.want)
    })
  }

  it('names both keys when neither is set', () => {
    expect(liveSettingsOrNull({})).toBeNull()
    expect(() => liveSettingsFromEnv({ OPENAI_BASE_URL: OPENROUTER_BASE_URL })).toThrow(
      LIVE_KEY_MISSING
    )
    expect(LIVE_KEY_MISSING).toMatch(/OPENROUTER_API_KEY.*OPENAI_API_KEY/)
    expect(() => liveProviderFromEnv({ OPENROUTER_API_KEY: '' })).toThrow(LIVE_KEY_MISSING)
  })

  it('tells this machine’s servers from others', () => {
    expect(isLoopbackUrl('http://localhost:11434/v1')).toBe(true)
    expect(isLoopbackUrl('http://127.0.0.1:1234/v1')).toBe(true)
    expect(isLoopbackUrl('http://[::1]:8080/v1')).toBe(true)
    expect(isLoopbackUrl(OPENROUTER_BASE_URL)).toBe(false)
    expect(isLoopbackUrl('http://localhost.example.com/v1')).toBe(false)
    expect(isLoopbackUrl(undefined)).toBe(false)
  })

  it('tells OpenRouter base URLs from others', () => {
    expect(isOpenRouterUrl(OPENROUTER_BASE_URL)).toBe(true)
    expect(isOpenRouterUrl('https://eu.openrouter.ai/api/v1')).toBe(true)
    expect(isOpenRouterUrl('https://api.openai.com/v1')).toBe(false)
    expect(isOpenRouterUrl('https://example.com/openrouter.ai/v1')).toBe(false)
    expect(isOpenRouterUrl('not a url')).toBe(false)
    expect(isOpenRouterUrl(undefined)).toBe(false)
  })
})

describe('openRouterKeyFromEnv: the price probe’s key (F-16.1, F-16.22)', () => {
  it('takes OPENROUTER_API_KEY, or OPENAI_API_KEY only on an OpenRouter base URL', () => {
    expect(openRouterKeyFromEnv({ OPENROUTER_API_KEY: OR_KEY })).toBe(OR_KEY)
    expect(
      openRouterKeyFromEnv({ OPENAI_API_KEY: OR_KEY, OPENAI_BASE_URL: OPENROUTER_BASE_URL })
    ).toBe(OR_KEY)
    expect(openRouterKeyFromEnv({ OPENAI_API_KEY: OPENAI_KEY })).toBeNull()
    expect(
      openRouterKeyFromEnv({ OPENAI_API_KEY: OPENAI_KEY, OPENAI_BASE_URL: 'http://localhost:1/v1' })
    ).toBeNull()
    expect(openRouterKeyFromEnv({})).toBeNull()
  })
})

describe('liveProviderFromEnv: a request leaves as the app sends it (F-16.22)', () => {
  /** A `reader.v2` request through the request path, as the knows and planted runs send it. */
  async function readerRequest(
    env: LiveEnv,
    reported: number | null = 0.0042
  ): Promise<{ call: ChatCall; costUsd: number; costUnknown: string | null }> {
    const { fetch, calls } = fakeChatServer(() => ({
      text: '{"c":[]}',
      usage: { inputTokens: 100, outputTokens: 10 },
      costUsd: reported
    }))
    const live = liveProviderFromEnv(env, { fetch })
    const run = liveRequestDeps(live)
    const messages = [
      { role: 'system' as const, content: 'You are the story-memory reader.' },
      { role: 'user' as const, content: 'Paragraphs:\n¶0 Mara sold the map.' }
    ]
    await runAiRequest(run.deps, {
      feature: 'reader',
      tier: 'fast',
      messages,
      maxTokens: 200,
      json: true,
      contextHash: sha256(JSON.stringify(messages)),
      promptVersion: 'reader.v2'
    })
    const call = calls[0]
    if (call === undefined) throw new Error('no request')
    expect(calls).toHaveLength(1)
    expect(run.ledger).toHaveLength(1)
    return { call, costUsd: run.spent(), costUnknown: run.costUnknown() }
  }

  it('OPENROUTER_API_KEY alone: OpenRouter, V4 Flash, reasoning off, the reported cost', async () => {
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: OR_KEY })
    expect([live.openRouter, live.models, live.describe, live.provider.id]).toEqual([
      true,
      OPENROUTER_DEFAULT_MODELS,
      'OpenRouter (OPENROUTER_API_KEY)',
      'openrouter'
    ])
    expect(live.describe).not.toContain(OR_KEY)
    const { call, costUsd } = await readerRequest({ OPENROUTER_API_KEY: OR_KEY })
    expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
    expect(call.headers.get('authorization')).toBe(`Bearer ${OR_KEY}`)
    expect(call.headers.get('x-title')).toBe('MythScribe')
    expect(call.body).toMatchObject({
      model: OPENROUTER_DEFAULT_MODELS.fast,
      reasoning: { enabled: false },
      usage: { include: true },
      response_format: { type: 'json_object' }
    })
    expect(call.body.reasoning_effort).toBeUndefined()
    // The ledger counts what OpenRouter reported, not the table's estimate.
    expect(costUsd).toBe(0.0042)
  })

  it('streams a streamed request (Ms Scribe’s answer, F-16.25) as events, its reported cost counted', async () => {
    const { fetch, calls } = fakeChatServer(() => ({
      text: '{"answer":"Orrin overheard Tomas.","found":true}',
      usage: { inputTokens: 300, outputTokens: 20 },
      costUsd: 0.0031
    }))
    const run = liveRequestDeps(liveProviderFromEnv({ OPENROUTER_API_KEY: OR_KEY }, { fetch }))
    const messages = [
      { role: 'system' as const, content: 'You are the story assistant.' },
      { role: 'user' as const, content: 'Question: What did Orrin hear?' }
    ]
    const deltas: string[] = []
    const result = await runAiStream(
      run.deps,
      {
        feature: 'agent',
        tier: 'strong',
        messages,
        maxTokens: 700,
        json: true,
        contextHash: sha256(JSON.stringify(messages)),
        promptVersion: 'agent.v9',
        reasoning: 'off'
      },
      (delta) => deltas.push(delta)
    )
    expect(calls[0]?.body).toMatchObject({
      model: OPENROUTER_DEFAULT_MODELS.strong,
      stream: true,
      reasoning: { enabled: false }
    })
    expect(deltas.length).toBeGreaterThan(1)
    expect(deltas.join('')).toBe('{"answer":"Orrin overheard Tomas.","found":true}')
    expect(result.text).toBe(deltas.join(''))
    expect(result.usage).toMatchObject({ inputTokens: 300, outputTokens: 20 })
    expect(run.spent()).toBe(0.0031)
  })

  it('OPENAI_API_KEY alone: OpenAI itself, its lowest effort, no OpenRouter fields', async () => {
    const live = liveProviderFromEnv({ OPENAI_API_KEY: OPENAI_KEY })
    expect([live.openRouter, live.describe, live.provider.id]).toEqual([
      false,
      'OpenAI (OPENAI_API_KEY)',
      'openai'
    ])
    const { call } = await readerRequest({ OPENAI_API_KEY: OPENAI_KEY })
    expect(call.url).toBe(`${OPENAI_API_URL}/chat/completions`)
    expect(call.headers.get('authorization')).toBe(`Bearer ${OPENAI_KEY}`)
    expect(call.body).toMatchObject({
      model: DEFAULT_MODELS.fast,
      reasoning_effort: 'none',
      max_completion_tokens: 200
    })
    expect(call.body.max_tokens).toBeUndefined()
    expect(call.body.reasoning).toBeUndefined()
    expect(call.body.usage).toBeUndefined()
  })

  it('OPENAI_API_KEY alone: OpenAI itself even when the shell exports OPENAI_BASE_URL', async () => {
    // The SDK reads `process.env.OPENAI_BASE_URL` on its own; the route comes from `env` only.
    vi.stubEnv('OPENAI_BASE_URL', OPENROUTER_BASE_URL)
    const { call } = await readerRequest({ OPENAI_API_KEY: OPENAI_KEY })
    expect(call.url).toBe(`${OPENAI_API_URL}/chat/completions`)
    expect(call.body).toMatchObject({ reasoning_effort: 'none', max_completion_tokens: 200 })
    expect(call.body.reasoning).toBeUndefined()
  })

  it('OPENAI_API_KEY on an OpenRouter base URL: still OpenRouter', async () => {
    const env = { OPENAI_API_KEY: OR_KEY, OPENAI_BASE_URL: OPENROUTER_BASE_URL }
    expect(liveProviderFromEnv(env).describe).toBe('OpenRouter (OPENAI_API_KEY)')
    const { call, costUsd } = await readerRequest(env)
    expect(call.url).toBe(`${OPENROUTER_BASE_URL}/chat/completions`)
    expect(call.body).toMatchObject({
      model: OPENROUTER_DEFAULT_MODELS.fast,
      reasoning: { enabled: false },
      usage: { include: true }
    })
    expect(costUsd).toBe(0.0042)
  })

  it('OPENAI_API_KEY on another compatible server: that server, named by its host', async () => {
    const env = { OPENAI_API_KEY: OPENAI_KEY, OPENAI_BASE_URL: 'http://localhost:11434/v1' }
    expect(liveProviderFromEnv(env).describe).toBe('OpenAI at localhost:11434 (OPENAI_API_KEY)')
    const { call } = await readerRequest(env)
    expect(call.url).toBe('http://localhost:11434/v1/chat/completions')
    expect(call.body.max_tokens).toBe(200)
    expect(call.body.reasoning).toBeUndefined()
  })

  it('says when the cost stop cannot hold: no reported cost on a model the tables lack', async () => {
    // V4 Flash is on the tables: no reported cost falls back to its price, and the stop holds.
    expect((await readerRequest({ OPENROUTER_API_KEY: OR_KEY }, null)).costUnknown).toBeNull()
    const unlisted = {
      OPENROUTER_API_KEY: OR_KEY,
      MYTHSCRIBE_EVAL_FAST_MODEL: 'vendor/unlisted-model'
    }
    // Reported: the cost is known whatever the model.
    expect((await readerRequest(unlisted)).costUnknown).toBeNull()
    const unknown = await readerRequest(unlisted, null)
    expect(unknown.costUsd).toBe(0)
    expect(unknown.costUnknown).toMatch(/cost unknown for vendor\/unlisted-model/)
    // A server on this machine charges nothing: its unpriced models stop nothing.
    const local = {
      OPENAI_API_KEY: OPENAI_KEY,
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
      MYTHSCRIBE_EVAL_FAST_MODEL: 'llama3'
    }
    expect(liveProviderFromEnv(local).local).toBe(true)
    expect((await readerRequest(local, null)).costUnknown).toBeNull()
  })
})

describe('liveProviderError: what a live run stops on (F-16.22)', () => {
  it('names a provider error by its code and copy, and lets anything else throw', async () => {
    expect(liveProviderError(new AiRateLimitError('OpenRouter is rate limiting requests.'))).toBe(
      'RATE_LIMIT: OpenRouter is rate limiting requests.'
    )
    expect(liveProviderError(new Error('a bug'))).toBeNull()
    // A 429 from the server comes back through the adapter as a provider error.
    const { fetch } = fakeChatServer(() => ({ text: 'slow down', status: 429 }))
    const live = liveProviderFromEnv({ OPENROUTER_API_KEY: OR_KEY }, { fetch })
    const run = liveRequestDeps(live)
    const messages = [{ role: 'user' as const, content: 'hello' }]
    const failed = await runAiRequest(run.deps, {
      feature: 'reader',
      tier: 'fast',
      messages,
      maxTokens: 10,
      contextHash: sha256('hello'),
      promptVersion: 'reader.v2'
    }).catch((err: unknown) => err)
    expect(liveProviderError(failed)).toMatch(/^RATE_LIMIT: /)
    expect(liveProviderError(failed)).not.toContain(OR_KEY)
  })
})
