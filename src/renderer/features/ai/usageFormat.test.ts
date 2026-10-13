import { describe, expect, it } from 'vitest'
import {
  formatCents,
  describeCostParts,
  describeRequest,
  describeTotals,
  formatCount,
  formatRequestCost,
  formatUsd
} from './usageFormat'

describe('usageFormat (F-5.14)', () => {
  it('formatUsd shows two decimals and floors a fraction of a cent instead of reading as free', () => {
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(0.005)).toBe('$0.01')
    expect(formatUsd(12.345)).toBe('$12.35')
  })

  it('formatRequestCost shows four decimals and floors below a hundredth of a cent (F-4.7)', () => {
    expect(formatRequestCost(0)).toBe('$0.0000')
    expect(formatRequestCost(0.00003)).toBe('<$0.0001')
    expect(formatRequestCost(0.00005)).toBe('$0.0001')
    expect(formatRequestCost(0.0012)).toBe('$0.0012')
    expect(formatRequestCost(1.23456)).toBe('$1.2346')
  })

  it('formatCount groups thousands and pluralizes the unit', () => {
    expect(formatCount(0, 'request')).toBe('0 requests')
    expect(formatCount(1, 'request')).toBe('1 request')
    expect(formatCount(15_400, 'token')).toBe('15,400 tokens')
    expect(formatCount(15_400)).toBe('15,400')
  })

  it('describeTotals joins cost, requests, and tokens', () => {
    expect(describeTotals({ requests: 12, tokens: 15_400, costUsd: 0.75 })).toBe(
      '$0.75 · 12 requests · 15,400 tokens'
    )
  })

  it('describeRequest names the model, the cost, and the tokens in and out (F-5.9)', () => {
    expect(
      describeRequest({
        model: 'gpt-5.4-mini',
        costUsd: 0.0012,
        usage: { inputTokens: 1_300, outputTokens: 20 },
        cached: false
      })
    ).toBe('gpt-5.4-mini · $0.0012 · 1,300 in · 20 out')
  })

  it('describeRequest marks a cache hit', () => {
    expect(
      describeRequest({
        model: 'gpt-5.4-mini',
        costUsd: 0,
        usage: { inputTokens: 300, outputTokens: 20 },
        cached: true
      })
    ).toBe('gpt-5.4-mini · $0.0000 · 300 in · 20 out · cached')
  })

  it('describeRequest leaves the tokens out when none were stored (a turn before F-5.9)', () => {
    expect(describeRequest({ model: 'gpt-5.4', costUsd: 0.0123, usage: null, cached: false })).toBe(
      'gpt-5.4 · $0.0123'
    )
  })
})

describe('formatCents (F-16.16, F-16.19)', () => {
  it('says small sums in cents and a dollar or more in dollars', () => {
    expect(formatCents(0)).toBe('0¢')
    expect(formatCents(0.0000001)).toBe('<0.01¢')
    expect(formatCents(0.003)).toBe('0.3¢')
    expect(formatCents(0.0011)).toBe('0.1¢')
    expect(formatCents(0.0009)).toBe('0.09¢')
    expect(formatCents(0.05)).toBe('5¢')
    expect(formatCents(0.12)).toBe('12¢')
    expect(formatCents(1)).toBe('$1')
    expect(formatCents(1.25)).toBe('$1.25')
  })

  it('switches to dollars once the sum rounds to a dollar, with no trailing .00', () => {
    expect(formatCents(0.994)).toBe('99¢')
    expect(formatCents(0.996)).toBe('$1')
    expect(formatCents(0.9999)).toBe('$1')
    expect(formatCents(1.004)).toBe('$1')
    expect(formatCents(1.006)).toBe('$1.01')
    expect(formatCents(20)).toBe('$20')
  })
})

describe('describeCostParts (P3-D23)', () => {
  it('names each part of a turn’s cost, the read-first as the chat shows it', () => {
    expect(
      describeCostParts([
        { part: 'read', costUsd: 0.001 },
        { part: 'navigator', costUsd: 0.0018 },
        { part: 'answer', costUsd: 0.0126 },
        { part: 'check', costUsd: 0.0001 }
      ])
    ).toBe(
      `read first ${formatCents(0.001)} · navigator ${formatCents(0.0018)} · answer ${formatCents(0.0126)} · check ${formatCents(0.0001)}`
    )
  })
})
