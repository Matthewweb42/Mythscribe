import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { buildParams, costMicros, errorCode, parseAiBody, ROUTES } from './ai'

const user = (content: string) => ({ role: 'user', content })

describe('parseAiBody', () => {
  it('takes a plain conversation and defaults the tier', () => {
    const b = parseAiBody({ messages: [user('hi')] })
    expect(typeof b).toBe('object')
    if (typeof b === 'string') return
    expect(b.tier).toBe('default')
    expect(b.tools).toEqual([])
  })
  it('refuses a conversation that ends on the assistant (no prefill on Sonnet 5.5)', () => {
    expect(parseAiBody({ messages: [user('a'), { role: 'assistant', content: 'b' }] })).toMatch(/end with the user/)
  })
  it('refuses unknown tiers and roles', () => {
    expect(parseAiBody({ tier: 'max', messages: [user('a')] })).toMatch(/tier/)
    expect(parseAiBody({ messages: [{ role: 'system', content: 'x' }] })).toMatch(/role/)
  })
  it('keeps tool schemas and fills a missing one', () => {
    const b = parseAiBody({ messages: [user('a')], tools: [{ name: 'read_chapter', description: 'd' }] })
    if (typeof b === 'string') throw new Error(b)
    expect(b.tools[0]).toEqual({ name: 'read_chapter', description: 'd', input_schema: { type: 'object', properties: {} } })
  })
})

describe('buildParams', () => {
  it('sends quick work to Haiku 5.5 with caching and no fallback', () => {
    const p = buildParams({ tier: 'quick', messages: [{ role: 'user', content: 'x' }], tools: [] })
    expect(p.model).toBe('claude-haiku-5-5')
    expect(p.cache_control).toEqual({ type: 'ephemeral' })
    expect(p.fallbacks).toBeUndefined()
    expect(p.tools).toBeUndefined()
  })
  it('sends chat to Sonnet 5.5 with the server-side refusal fallback', () => {
    const p = buildParams({ tier: 'complex', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 't', description: '', input_schema: { properties: {} } }] })
    expect(p.model).toBe('claude-sonnet-5-5')
    expect(p.output_config).toEqual({ effort: 'high' })
    expect(p.betas).toEqual(['server-side-fallback-2026-07-01'])
    expect(p.fallbacks).toBe('default')
    expect(p.tools?.[0]).toMatchObject({ name: 't', input_schema: { type: 'object' } })
  })
  it('never sets thinking, so Sonnet and Haiku run adaptive', () => {
    for (const tier of Object.keys(ROUTES) as (keyof typeof ROUTES)[]) {
      expect('thinking' in buildParams({ tier, messages: [{ role: 'user', content: 'x' }], tools: [] })).toBe(false)
    }
  })
})

describe('costMicros', () => {
  it('prices Sonnet 5.5 at $2 in, $10 out, $0.10 cached', () => {
    expect(costMicros('claude-sonnet-5-5', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(2_000_000)
    expect(costMicros('claude-sonnet-5-5', { input: 0, output: 1000, cacheRead: 10_000, cacheWrite: 0 })).toBe(10_000 + 1000)
  })
  it('prices long Haiku prompts at the higher rate', () => {
    expect(costMicros('claude-haiku-5-5', { input: 50_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(5000)
    expect(costMicros('claude-haiku-5-5', { input: 200_000, output: 0, cacheRead: 0, cacheWrite: 0 })).toBe(100_000)
  })
})

describe('errorCode', () => {
  it('maps the SDK errors to the codes Desk knows', () => {
    const headers = new Headers()
    expect(errorCode(new Anthropic.RateLimitError(429, { type: 'error' }, 'slow down', headers)).code).toBe('rate_limited')
    expect(errorCode(new Anthropic.BadRequestError(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 1200000 tokens' } }, undefined, headers)).code).toBe('prompt_too_large')
    expect(errorCode(new Anthropic.InternalServerError(500, { type: 'error' }, 'boom', headers)).code).toBe('upstream_error')
  })
})
