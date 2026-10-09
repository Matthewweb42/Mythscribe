/**
 * The five Lemon Squeezy products in `wrangler.toml` (operator tooling, 2026-10-07): the $30 app
 * license, the $10 / $25 / $50 balance packs, and (2026-10-08) the $5 starter pack, written as
 * `LEMONSQUEEZY_APP_LICENSE`, `LEMONSQUEEZY_PACKS`, and `LEMONSQUEEZY_STARTER`. Pure, so `npm run cloud:products` (cloud/scripts/setProducts.mjs) and the
 * tests share it. The shapes match `ConfiguredPack` in credits.ts: `{ variantId, url, priceCents }`.
 * Erasable TypeScript only: Node runs this file directly, without a build.
 */

export interface ProductEntry {
  variantId: string
  url: string
  priceCents: number
}

export interface ProductSlot {
  key: 'app' | 'pack10' | 'pack25' | 'pack50' | 'starter'
  label: string
  defaultPriceCents: number
}

/** In the order the script asks for them. */
export const PRODUCT_SLOTS: readonly ProductSlot[] = [
  { key: 'app', label: 'MythScribe app license', defaultPriceCents: 3000 },
  { key: 'pack10', label: 'AI balance pack $10', defaultPriceCents: 1000 },
  { key: 'pack25', label: 'AI balance pack $25', defaultPriceCents: 2500 },
  { key: 'pack50', label: 'AI balance pack $50', defaultPriceCents: 5000 },
  {
    key: 'starter',
    label: 'AI starter pack $5 (one per account, exempt from the $10 minimum)',
    defaultPriceCents: 500
  }
]

/** The slots sold as `LEMONSQUEEZY_PACKS`, under the minimum pack. */
const PACK_KEYS: readonly ProductSlot['key'][] = ['pack10', 'pack25', 'pack50']

/** The smallest pack the Worker sells (`min_pack_usd`, default 10). */
export const MIN_PACK_CENTS = 1000

/**
 * A pasted buy link, trimmed: an https URL on a `*.lemonsqueezy.com` host whose path is
 * `/checkout/buy/<id>` (the share link from the product page; older links were `/buy/<id>`). Null with
 * the reason otherwise.
 */
export function parseBuyLink(input: string): { url: string } | { error: string } {
  const text = input.trim()
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { error: 'That is not a link. Paste the product’s Share › checkout URL.' }
  }
  if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.lemonsqueezy.com')) {
    return { error: 'The link must start with https:// and be on a .lemonsqueezy.com address.' }
  }
  if (!/^\/(checkout\/)?buy\/[A-Za-z0-9-]+\/?$/.test(parsed.pathname)) {
    return {
      error:
        'That is not a buy link. It should look like https://<store>.lemonsqueezy.com/checkout/buy/<id>.'
    }
  }
  return { url: text }
}

/**
 * A pasted variant ID: the number itself, or a dashboard URL that ends with it (…/variants/123456).
 * The last run of digits wins.
 */
export function parseVariantId(input: string): { variantId: string } | { error: string } {
  const runs = input.trim().match(/\d+/g)
  if (runs === null) return { error: 'No number found. The variant ID is a number, like 123456.' }
  return { variantId: runs[runs.length - 1] ?? '' }
}

/** A price in dollars ("30", "$25.00") to cents; null when it is not a positive amount. */
export function parsePriceCents(input: string): number | null {
  const text = input.trim().replace(/^\$/, '')
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null
  const cents = Math.round(Number(text) * 100)
  return cents > 0 ? cents : null
}

/**
 * Problems with the entries together: a pack under the minimum (the starter is exempt), or a
 * variant used twice.
 */
export function checkProducts(entries: Record<ProductSlot['key'], ProductEntry>): string[] {
  const problems: string[] = []
  for (const slot of PRODUCT_SLOTS) {
    if (PACK_KEYS.includes(slot.key) && entries[slot.key].priceCents < MIN_PACK_CENTS) {
      problems.push(`${slot.label}: packs under $10 are not sold (min_pack_usd).`)
    }
  }
  const ids = PRODUCT_SLOTS.map((slot) => entries[slot.key].variantId)
  if (new Set(ids).size !== ids.length) {
    problems.push('Two products have the same variant ID; each product has its own.')
  }
  return problems
}

function entryJson(entry: ProductEntry): string {
  return JSON.stringify({
    variantId: entry.variantId,
    url: entry.url,
    priceCents: entry.priceCents
  })
}

export interface ProductLines {
  packs: string
  appLicense: string
  starter: string
}

/** The three `wrangler.toml` lines, uncommented, single-quoted as TOML literal strings. */
export function renderProductLines(
  entries: Record<ProductSlot['key'], ProductEntry>
): ProductLines {
  const packs = `[${[entries.pack10, entries.pack25, entries.pack50].map(entryJson).join(',')}]`
  return {
    packs: `LEMONSQUEEZY_PACKS = '${packs}'`,
    appLicense: `LEMONSQUEEZY_APP_LICENSE = '${entryJson(entries.app)}'`,
    starter: `LEMONSQUEEZY_STARTER = '${entryJson(entries.starter)}'`
  }
}

function lineFor(name: string): RegExp {
  return new RegExp(`^#?[ \\t]*${name}[ \\t]*=.*$`, 'm')
}

/**
 * `toml` with the lines replaced where they are (commented or not), or added at the end of
 * `[vars]` when absent. Everything else is left as it was.
 */
export function updateWranglerToml(toml: string, lines: ProductLines): string {
  let out = toml
  for (const [name, line] of [
    ['LEMONSQUEEZY_PACKS', lines.packs],
    ['LEMONSQUEEZY_APP_LICENSE', lines.appLicense],
    ['LEMONSQUEEZY_STARTER', lines.starter]
  ] as const) {
    const pattern = lineFor(name)
    if (pattern.test(out)) {
      out = out.replace(pattern, () => line)
    } else {
      const vars = out.indexOf('[vars]')
      if (vars === -1) {
        out = `${out.trimEnd()}\n\n[vars]\n${line}\n`
      } else {
        const next = out.indexOf('\n[', vars + 1)
        const at = next === -1 ? out.length : next
        out = `${out.slice(0, at).trimEnd()}\n${line}\n${out.slice(at)}`
      }
    }
  }
  return out
}

/** What `toml` already has, uncommented, so a re-run can offer it as the default. */
export function readProducts(toml: string): Partial<Record<ProductSlot['key'], ProductEntry>> {
  const found: Partial<Record<ProductSlot['key'], ProductEntry>> = {}
  const value = (name: string): unknown => {
    const match = new RegExp(`^[ \\t]*${name}[ \\t]*=[ \\t]*'(.*)'[ \\t]*$`, 'm').exec(toml)
    if (match === null) return undefined
    try {
      return JSON.parse(match[1] ?? '')
    } catch {
      return undefined
    }
  }
  const asEntry = (raw: unknown): ProductEntry | undefined => {
    if (typeof raw !== 'object' || raw === null) return undefined
    const { variantId, url, priceCents } = raw as Record<string, unknown>
    if (
      typeof variantId !== 'string' ||
      typeof url !== 'string' ||
      typeof priceCents !== 'number'
    ) {
      return undefined
    }
    return { variantId, url, priceCents }
  }
  const app = asEntry(value('LEMONSQUEEZY_APP_LICENSE'))
  if (app) found.app = app
  const starter = asEntry(value('LEMONSQUEEZY_STARTER'))
  if (starter) found.starter = starter
  const packs = value('LEMONSQUEEZY_PACKS')
  if (Array.isArray(packs)) {
    for (const raw of packs) {
      const entry = asEntry(raw)
      if (!entry) continue
      const slot = PRODUCT_SLOTS.find(
        (s) => PACK_KEYS.includes(s.key) && s.defaultPriceCents === entry.priceCents
      )
      if (slot) found[slot.key] = entry
    }
  }
  return found
}
