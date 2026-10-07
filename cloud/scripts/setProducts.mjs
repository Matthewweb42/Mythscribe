/**
 * `npm run cloud:products`: enter the four Lemon Squeezy products (the $30 app license and the
 * $10 / $25 / $50 balance packs) one by one, checked as you go, and write them into
 * cloud/wrangler.toml as LEMONSQUEEZY_APP_LICENSE and LEMONSQUEEZY_PACKS. Re-running offers what is
 * already there, so changing one product is a few Enters. Asks before deploying.
 * The walkthrough is docs/OPERATOR-SETUP.md, Part 2.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import {
  PRODUCT_SLOTS,
  checkProducts,
  parseBuyLink,
  parsePriceCents,
  parseVariantId,
  readProducts,
  renderProductLines,
  updateWranglerToml
} from '../src/productsConfig.ts'

const tomlPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'wrangler.toml')
const rl = createInterface({ input: process.stdin, terminal: false })
// One queue of input lines: typed or piped, none is lost before its question is asked.
const inputLines = rl[Symbol.asyncIterator]()
/** Prints `text` and answers the next input line ('' once input has ended). */
let inputEnded = false
const prompt = async (text) => {
  process.stdout.write(text)
  const next = await inputLines.next()
  if (next.done) {
    inputEnded = true
    process.stdout.write('\n')
    return ''
  }
  return next.value
}
/** Prints one line; the scripts' only output channel. */
const say = (text = '') => process.stdout.write(`${text}\n`)
const dollars = (cents) => `$${(cents / 100).toFixed(2).replace(/\.00$/, '')}`

/** Asks until `parse` accepts the answer; Enter keeps `current` when there is one. */
async function ask(question, current, parse) {
  for (;;) {
    const hint = current === undefined ? '' : ` [Enter keeps ${current}]`
    const answer = (await prompt(`  ${question}${hint}: `)).trim()
    if (answer === '' && current !== undefined) return parse(String(current))
    const result = parse(answer)
    if (!('error' in result)) return result
    if (inputEnded) {
      say('\nInput ended before every product was entered. Nothing was written.')
      process.exit(1)
    }
    say(`    ✗ ${result.error}`)
  }
}

say(`
Lemon Squeezy products → ${tomlPath}

For each product, from the Lemon Squeezy dashboard:
  • Buy link:   the product's Share button → checkout URL (https://<store>.lemonsqueezy.com/buy/…)
  • Variant ID: open the product's variant; the number is in the page URL (…/variants/123456).
    Pasting that whole URL works too.
  • Price:      must match the price in Lemon Squeezy (it is what the balance grows by).
`)

const toml = readFileSync(tomlPath, 'utf8')
const existing = readProducts(toml)
const entries = {}

for (const slot of PRODUCT_SLOTS) {
  const before = existing[slot.key]
  say(`${slot.label}`)
  const { url } = await ask('Buy link', before?.url, parseBuyLink)
  const { variantId } = await ask('Variant ID', before?.variantId, parseVariantId)
  const { priceCents } = await ask(
    'Price in dollars',
    dollars(before?.priceCents ?? slot.defaultPriceCents),
    (text) => {
      const cents = parsePriceCents(text)
      return cents === null ? { error: 'Enter an amount like 30 or 25.00.' } : { priceCents: cents }
    }
  )
  entries[slot.key] = { variantId, url, priceCents }
  say(`    ✓ variant ${variantId}, ${dollars(priceCents)}\n`)
}

const problems = checkProducts(entries)
if (problems.length > 0) {
  for (const problem of problems) say(`✗ ${problem}`)
  say('\nNothing was written. Run `npm run cloud:products` again to fix it.')
  rl.close()
  process.exit(1)
}

const lines = renderProductLines(entries)
const next = updateWranglerToml(toml, lines)
say('These two lines go into cloud/wrangler.toml:\n')
say(`  ${lines.appLicense}`)
say(`  ${lines.packs}\n`)
if (next === toml) {
  say('No change: wrangler.toml already has exactly these values.')
} else {
  writeFileSync(tomlPath, next)
  say('✓ Saved cloud/wrangler.toml (commit it: these values are public, not secrets).')
}

const deploy = (await prompt('\nDeploy the Worker now so they take effect? (y/N): '))
  .trim()
  .toLowerCase()
rl.close()
if (deploy === 'y' || deploy === 'yes') {
  const run = spawnSync('npm', ['run', 'cloud:deploy'], {
    stdio: 'inherit',
    shell: process.platform === 'win32'
  })
  process.exit(run.status ?? 1)
}
say('Not deployed. Run `npm run cloud:deploy` when you are ready.')
