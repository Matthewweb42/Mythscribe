import { describe, expect, it } from 'vitest'
import { DEFAULT_MODELS, MODEL_PRICING } from './ai'
import {
  CLOUD_RATE_MULTIPLIER,
  CLOUD_RATES,
  cloudChargeMicros,
  cloudRateFor,
  MICROS_PER_USD
} from './cloudRates'

describe('cloudRateFor', () => {
  it('applies the multiplier to the provider price', () => {
    const rate = cloudRateFor('gpt-5.4')
    expect(rate).toEqual({
      model: 'gpt-5.4',
      inUsdPerM: MODEL_PRICING['gpt-5.4']!.inUsdPerM * CLOUD_RATE_MULTIPLIER,
      outUsdPerM: MODEL_PRICING['gpt-5.4']!.outUsdPerM * CLOUD_RATE_MULTIPLIER,
      priced: true
    })
  })

  it('marks an unknown model unpriced at 0', () => {
    expect(cloudRateFor('gpt-unknown')).toEqual({
      model: 'gpt-unknown',
      inUsdPerM: 0,
      outUsdPerM: 0,
      priced: false
    })
  })
})

describe('cloudChargeMicros', () => {
  it('charges tokens at the Cloud rate in micro-USD, rounded up', () => {
    const rate = cloudRateFor('gpt-5.4-mini')
    const usd = (1000 * rate.inUsdPerM + 100 * rate.outUsdPerM) / 1_000_000
    expect(cloudChargeMicros('gpt-5.4-mini', 1000, 100)).toBe(Math.ceil(usd * MICROS_PER_USD))
  })

  it('never charges less than one micro for a priced answer', () => {
    expect(cloudChargeMicros('gpt-5.4-nano', 1, 0)).toBe(1)
    expect(cloudChargeMicros('gpt-5.4-nano', 0, 0)).toBe(1)
  })

  it('refuses an unpriced model', () => {
    expect(() => cloudChargeMicros('gpt-unknown', 10, 10)).toThrow(/No MythScribe Cloud rate/)
  })
})

describe('CLOUD_RATES', () => {
  it('lists every priced model with the tiers it is the default for, defaults first', () => {
    expect(CLOUD_RATES.map((rate) => rate.model)).toEqual(
      expect.arrayContaining(Object.keys(MODEL_PRICING))
    )
    expect(CLOUD_RATES.every((rate) => rate.priced)).toBe(true)
    const fast = CLOUD_RATES.find((rate) => rate.model === DEFAULT_MODELS.fast)
    const strong = CLOUD_RATES.find((rate) => rate.model === DEFAULT_MODELS.strong)
    expect(fast?.tiers).toEqual(['fast'])
    expect(strong?.tiers).toEqual(['strong'])
    const firstNonDefault = CLOUD_RATES.findIndex((rate) => rate.tiers.length === 0)
    const lastDefault = CLOUD_RATES.map((rate) => rate.tiers.length > 0).lastIndexOf(true)
    expect(firstNonDefault === -1 || firstNonDefault > lastDefault).toBe(true)
  })
})
