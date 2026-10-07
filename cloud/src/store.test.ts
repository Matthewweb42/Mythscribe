import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it } from 'vitest'
import { lockPrices } from '../../src/shared/cloudBilling'
import { DEFAULT_BILLING_CONFIG } from './config'
import { type HoldRow, type LedgerEntryRow, plainEntry } from './store'
import { MIGRATION_NAMES, migrate, testStore, type TestStore } from './testing/sqliteD1'

/**
 * The billing store's SQL (migration 0005) on a real SQLite database: the ledger is append-only,
 * the balance is the ledger's sum minus active holds (L6), the hold is refused when the balance
 * is short — even for two holds placed at once (L7) — and every money write is idempotent (L8).
 */

const USER = 'user-1'
const NOW = Date.parse('2026-10-07T12:00:00.000Z')
const MINUTE = 60_000
const PRICES = lockPrices(DEFAULT_BILLING_CONFIG.models[0]!, 0.2)

let store: TestStore
let ids: number

function topup(micros: number, key = `order_created:${(ids += 1)}`): LedgerEntryRow {
  return plainEntry({
    id: `e${(ids += 1)}`,
    userId: USER,
    type: 'topup',
    amountMicros: micros,
    idempotencyKey: key,
    createdAt: NOW
  })
}

function hold(amountMicros: number, overrides: Partial<HoldRow> = {}): HoldRow {
  const n = (ids += 1)
  return {
    id: `h${n}`,
    userId: USER,
    idempotencyKey: `key-${n}`,
    requestId: `r${n}`,
    feature: 'chat',
    model: 'openai/gpt-5.4-mini',
    amountMicros,
    prices: PRICES,
    status: 'active',
    createdAt: NOW,
    expiresAt: NOW + 10 * MINUTE,
    closedAt: null,
    chargeMicros: null,
    ...overrides
  }
}

function charge(h: HoldRow, micros: number): LedgerEntryRow {
  return {
    ...plainEntry({
      id: `c${(ids += 1)}`,
      userId: USER,
      type: 'charge',
      amountMicros: -micros,
      idempotencyKey: `charge:${h.requestId}`,
      createdAt: NOW
    }),
    requestId: h.requestId,
    feature: h.feature,
    model: h.model,
    tokensIn: 10,
    tokensOut: 5,
    tokensCached: 0,
    providerCostMicros: micros,
    markupBps: 2000
  }
}

async function available(at = NOW): Promise<number> {
  const balance = await store.getBalance(USER, at)
  return balance.ledgerMicros - balance.heldMicros
}

beforeEach(() => {
  store = testStore()
  ids = 0
})

describe('migrations', () => {
  it('applies every numbered migration in order', () => {
    expect(MIGRATION_NAMES).toEqual([
      '0001_auth.sql',
      '0002_credits.sql',
      '0003_diagnostics.sql',
      '0004_supporter.sql',
      '0005_billing.sql'
    ])
  })

  it('carries every 0002 credit event into the ledger with the same balance', async () => {
    const db = new DatabaseSync(':memory:')
    migrate(db, { until: '0005_billing.sql' })
    const insert = db.prepare(
      `INSERT INTO credit_events (id, user_id, kind, amount_micros, feature, model, tokens_in,
         tokens_out, order_ref, request_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run(
      'p1',
      USER,
      'purchase',
      5_000_000,
      null,
      null,
      null,
      null,
      'order_created:9',
      null,
      1
    )
    insert.run('c1', USER, 'charge', -1_234, 'chat', 'gpt-5.4-mini', 100, 20, null, 'rq', 2)
    insert.run(
      'r1',
      USER,
      'refund',
      -5_000_000,
      null,
      null,
      null,
      null,
      'order_refunded:9',
      null,
      3
    )
    insert.run(
      'p2',
      USER,
      'purchase',
      2_000_000,
      null,
      null,
      null,
      null,
      'order_created:10',
      null,
      4
    )
    migrate(db, { from: '0005_billing.sql' })
    store = testStore(db)

    const ledger = await store.ledger()
    expect(ledger.map((row) => [row.id, row.type, row.amountMicros, row.orderId])).toEqual([
      ['p1', 'topup', 5_000_000, '9'],
      ['c1', 'charge', -1_234, null],
      ['r1', 'refund', -5_000_000, '9'],
      ['p2', 'topup', 2_000_000, '10']
    ])
    expect(await available()).toBe(2_000_000 - 1_234)
    // A replay of a webhook delivered before the migration is still a duplicate.
    expect(await store.appendLedgerEntry(topup(2_000_000, 'order_created:10'))).toBe('duplicate')
    // A refund replayed in the new key format finds the order already refunded.
    expect(
      await store.refundOrder({
        id: 'x',
        userId: USER,
        orderId: '9',
        refundedMicros: 5_000_000,
        idempotencyKey: 'order_refunded:9:500',
        createdAt: NOW
      })
    ).toBe('duplicate')
  })
})

describe('the ledger (L1-L4)', () => {
  it('refuses to update or delete a money row', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    expect(() => store.db.exec('UPDATE ledger_entries SET amount_micros = 0')).toThrow(
      /append-only/
    )
    expect(() => store.db.exec('DELETE FROM ledger_entries')).toThrow(/append-only/)
    expect(await available()).toBe(1_000_000)
  })

  it('applies an idempotency key once', async () => {
    expect(await store.appendLedgerEntry(topup(1_000_000, 'k'))).toBe('applied')
    expect(await store.appendLedgerEntry(topup(1_000_000, 'k'))).toBe('duplicate')
    expect(await available()).toBe(1_000_000)
  })

  it('refuses a top-up that is not positive and a charge that is', () => {
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO ledger_entries (id, user_id, type, amount_micros, idempotency_key, created_at)
           VALUES ('a', 'u', 'topup', -1, 'a', 0)`
        )
        .run()
    ).toThrow(/CHECK/)
    expect(() =>
      store.db
        .prepare(
          `INSERT INTO ledger_entries (id, user_id, type, amount_micros, idempotency_key, created_at)
           VALUES ('b', 'u', 'charge', 5, 'b', 0)`
        )
        .run()
    ).toThrow(/CHECK/)
  })

  it('refunds only what a later partial refund adds, never twice', async () => {
    await store.appendLedgerEntry({ ...topup(25_000_000), orderId: 'o1' })
    const refund = (cents: number) =>
      store.refundOrder({
        id: `rf${(ids += 1)}`,
        userId: USER,
        orderId: 'o1',
        refundedMicros: cents * 10_000,
        idempotencyKey: `order_refunded:o1:${cents}`,
        createdAt: NOW
      })
    expect(await refund(1_000)).toBe('applied')
    expect(await refund(1_000)).toBe('duplicate')
    expect(await refund(1_500)).toBe('applied')
    expect(await available()).toBe(10_000_000)
    expect(
      (await store.ledger()).filter((row) => row.type === 'refund').map((row) => row.amountMicros)
    ).toEqual([-10_000_000, -5_000_000])
  })
})

describe('holds (L5-L7)', () => {
  it('reserves the hold and keeps ledger sum = available + held (L6)', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    const placed = await store.placeHold(hold(400_000), NOW)
    expect(placed.status).toBe('placed')
    const balance = await store.getBalance(USER, NOW)
    expect(balance).toEqual({ ledgerMicros: 1_000_000, heldMicros: 400_000 })
    expect(await available()).toBe(600_000)
  })

  it('refuses a hold the available balance does not cover', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    expect((await store.placeHold(hold(700_000), NOW)).status).toBe('placed')
    expect((await store.placeHold(hold(700_000), NOW)).status).toBe('insufficient')
    expect(await store.holds()).toHaveLength(1)
  })

  it('lets exactly one of two holds placed at once take the last of the balance', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    const outcomes = await Promise.all([
      store.placeHold(hold(800_000), NOW),
      store.placeHold(hold(800_000), NOW)
    ])
    expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(['insufficient', 'placed'])
    expect(await available()).toBe(200_000)
  })

  it('answers a duplicate for a key that is running or settled, and takes over a released one', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    const first = hold(300_000, { idempotencyKey: 'same-key' })
    const placed = await store.placeHold(first, NOW)
    if (placed.status !== 'placed') throw new Error('not placed')

    const retry = hold(300_000, { idempotencyKey: 'same-key' })
    expect(await store.placeHold(retry, NOW)).toMatchObject({
      status: 'duplicate',
      hold: { status: 'active' }
    })

    await store.releaseHold(placed.hold, NOW)
    const takeover = await store.placeHold(retry, NOW)
    expect(takeover).toMatchObject({
      status: 'placed',
      hold: { id: first.id, requestId: retry.requestId }
    })
    if (takeover.status !== 'placed') throw new Error('not placed')

    await store.settleHold(takeover.hold, charge(takeover.hold, 1_000), NOW)
    expect(await store.placeHold(hold(300_000, { idempotencyKey: 'same-key' }), NOW)).toMatchObject(
      {
        status: 'duplicate',
        hold: { status: 'settled', chargeMicros: 1_000 }
      }
    )
  })

  it('charges once when a hold is settled twice', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    const placed = await store.placeHold(hold(300_000), NOW)
    if (placed.status !== 'placed') throw new Error('not placed')
    await store.settleHold(placed.hold, charge(placed.hold, 2_000), NOW)
    await store.settleHold(placed.hold, charge(placed.hold, 2_000), NOW)
    expect(await available()).toBe(998_000)
    expect((await store.getBalance(USER, NOW)).heldMicros).toBe(0)
  })

  it('stops counting an expired hold, and the sweep marks it released', async () => {
    await store.appendLedgerEntry(topup(1_000_000))
    await store.placeHold(hold(900_000), NOW)
    expect(await available(NOW)).toBe(100_000)
    const later = NOW + 10 * MINUTE
    expect(await available(later)).toBe(1_000_000)
    expect(await store.releaseExpiredHolds(later)).toBe(1)
    expect((await store.holds())[0]).toMatchObject({ status: 'released', closedAt: later })
    expect(await store.releaseExpiredHolds(later)).toBe(0)
  })
})

describe('rate limits and the usage page', () => {
  it('counts requests per account per window', async () => {
    expect(await store.hitRateLimit(USER, NOW)).toBe(1)
    expect(await store.hitRateLimit(USER, NOW)).toBe(2)
    expect(await store.hitRateLimit('other', NOW)).toBe(1)
    expect(await store.hitRateLimit(USER, NOW + MINUTE)).toBe(1)
    await store.pruneExpired(NOW + MINUTE)
    expect(await store.hitRateLimit(USER, NOW)).toBe(1)
  })

  it('pages the ledger newest first', async () => {
    for (let i = 0; i < 5; i += 1) {
      await store.appendLedgerEntry({ ...topup(1_000), createdAt: NOW + i, id: `t${i}` })
    }
    const first = await store.listLedger(USER, 2, null)
    expect(first.map((row) => row.id)).toEqual(['t4', 't3'])
    const second = await store.listLedger(USER, 2, { createdAt: NOW + 3, id: 't3' })
    expect(second.map((row) => row.id)).toEqual(['t2', 't1'])
  })
})
