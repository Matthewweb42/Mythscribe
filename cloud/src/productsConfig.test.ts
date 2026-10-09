import { describe, expect, it } from 'vitest'
import { ConfiguredPack } from './credits'
import {
  checkProducts,
  parseBuyLink,
  parsePriceCents,
  parseVariantId,
  readProducts,
  renderProductLines,
  updateWranglerToml,
  type ProductEntry
} from './productsConfig'

const link = (id: string): string => `https://mythscribe.lemonsqueezy.com/buy/${id}`
const entries: Record<'app' | 'pack10' | 'pack25' | 'pack50' | 'starter', ProductEntry> = {
  app: { variantId: '444', url: link('a-1'), priceCents: 3000 },
  pack10: { variantId: '111', url: link('p-10'), priceCents: 1000 },
  pack25: { variantId: '222', url: link('p-25'), priceCents: 2500 },
  pack50: { variantId: '333', url: link('p-50'), priceCents: 5000 },
  starter: { variantId: '777', url: link('s-5'), priceCents: 500 }
}

const TOML = `name = "mythscribe-api"

[vars]
EMAIL_TRANSPORT = "resend"
# LEMONSQUEEZY_PACKS = '[{"variantId":"123456","url":"https://x.lemonsqueezy.com/buy/0","priceCents":500}]'
# LEMONSQUEEZY_SUPPORTER = '{"variantId":"123457","url":"https://x.lemonsqueezy.com/buy/0","priceCents":3900}'
# LEMONSQUEEZY_APP_LICENSE = '{"variantId":"123458","url":"https://x.lemonsqueezy.com/buy/0","priceCents":3000}'

[[d1_databases]]
binding = "DB"
`

describe('productsConfig (operator tooling)', () => {
  it('accepts a trimmed Lemon Squeezy buy link and refuses anything else', () => {
    expect(parseBuyLink(`  ${link('9f1c-22')}  `)).toEqual({ url: link('9f1c-22') })
    // The share link Lemon Squeezy gives today (2026-10-07, from the author's dashboard).
    const real =
      'https://mythscribe.lemonsqueezy.com/checkout/buy/f74c3cc6-9fc7-42c6-a9cd-23ba102c1e1b'
    expect(parseBuyLink(real)).toEqual({ url: real })
    expect(parseBuyLink('http://mythscribe.lemonsqueezy.com/buy/x')).toHaveProperty('error')
    expect(parseBuyLink('https://evil.example.com/buy/x')).toHaveProperty('error')
    expect(parseBuyLink('https://app.lemonsqueezy.com/products/12')).toHaveProperty('error')
    expect(parseBuyLink('not a link')).toHaveProperty('error')
  })

  it('reads a variant ID from the number or from a dashboard URL', () => {
    expect(parseVariantId(' 123456 ')).toEqual({ variantId: '123456' })
    expect(parseVariantId('https://app.lemonsqueezy.com/products/987/variants/654321')).toEqual({
      variantId: '654321'
    })
    expect(parseVariantId('none')).toHaveProperty('error')
  })

  it('reads prices in dollars', () => {
    expect(parsePriceCents('30')).toBe(3000)
    expect(parsePriceCents('$25.00')).toBe(2500)
    expect(parsePriceCents('0')).toBeNull()
    expect(parsePriceCents('ten')).toBeNull()
  })

  it('refuses a pack under $10 (the $5 starter is exempt) and a variant used twice', () => {
    expect(checkProducts(entries)).toEqual([])
    expect(
      checkProducts({ ...entries, pack10: { ...entries.pack10, priceCents: 500 } })
    ).toHaveLength(1)
    expect(
      checkProducts({ ...entries, pack50: { ...entries.pack50, variantId: '111' } })
    ).toHaveLength(1)
  })

  it('writes both lines in place of the commented examples, in the Worker’s shape', () => {
    const out = updateWranglerToml(TOML, renderProductLines(entries))
    expect(out).toContain(`LEMONSQUEEZY_APP_LICENSE = '{"variantId":"444"`)
    expect(out).toContain(`LEMONSQUEEZY_STARTER = '{"variantId":"777"`)
    expect(out).not.toContain('# LEMONSQUEEZY_APP_LICENSE')
    expect(out).not.toContain('# LEMONSQUEEZY_PACKS')
    // The Supporter example and the rest of the file are untouched.
    expect(out).toContain('# LEMONSQUEEZY_SUPPORTER')
    expect(out).toContain('[[d1_databases]]')
    // What it wrote is what the Worker accepts.
    const read = readProducts(out)
    expect(read).toEqual(entries)
    for (const entry of Object.values(read)) expect(ConfiguredPack.parse(entry)).toEqual(entry)
  })

  it('adds the lines to [vars] when the file has none, and a second run changes nothing', () => {
    const bare = 'name = "x"\n\n[vars]\nEMAIL_TRANSPORT = "resend"\n\n[triggers]\ncrons = []\n'
    const once = updateWranglerToml(bare, renderProductLines(entries))
    expect(once.indexOf('LEMONSQUEEZY_PACKS')).toBeLessThan(once.indexOf('[triggers]'))
    expect(updateWranglerToml(once, renderProductLines(entries))).toBe(once)
  })
})
