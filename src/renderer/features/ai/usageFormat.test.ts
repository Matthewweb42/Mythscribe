import { describe, expect, it } from 'vitest'
import { describeTotals, formatCount, formatRequestCost, formatUsd } from './usageFormat'

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
})
