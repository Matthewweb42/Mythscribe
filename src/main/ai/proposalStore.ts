import { randomUUID } from 'node:crypto'
import { and, eq, sql } from 'drizzle-orm'
import { PROPOSAL_RETENTION_MAX, type SettledStatus } from '@shared/proposal'
import { aiProposal, type AiProposalInsert, type AiProposalRow } from '../db/schema'
import type { AiDb } from './usageStore'

/**
 * The proposal rows (F-14.5). Every AI feature that shows the author something to act on
 * creates one right after the request path answers (the handler does it, so the use cases
 * stay pure over the request), and the renderer settles it through `proposal:settle` once
 * the author accepts, accepts part, rejects, or asks again. The table is bounded like the
 * cache: the oldest rows go first, whatever their status.
 */

/** What a feature knows when it creates a proposal; the id, the status, and the settlement are minted here. */
export type ProposalInput = Omit<
  AiProposalInsert,
  'id' | 'createdAt' | 'status' | 'note' | 'settledAt'
> & {
  /** ISO timestamp; defaults to now. */
  createdAt?: string
}

/**
 * Inserts one `pending` proposal, evicts the oldest rows beyond the cap, and returns the row.
 * A `regeneratedFrom` that no longer exists (evicted) is stored as null rather than refused.
 */
export function createProposal(db: AiDb, input: ProposalInput): AiProposalRow {
  const predecessor = input.regeneratedFrom ?? null
  const row: AiProposalInsert = {
    id: randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    status: 'pending',
    note: null,
    settledAt: null,
    ...withoutCreatedAt(input),
    regeneratedFrom: predecessor !== null && getProposal(db, predecessor) ? predecessor : null
  }
  db.insert(aiProposal).values(row).run()
  evictProposals(db)
  return db.select().from(aiProposal).where(eq(aiProposal.id, row.id)).get() as AiProposalRow
}

/**
 * Records how the author settled a proposal. Idempotent: only a `pending` row changes, so a
 * second settlement (or one for an evicted id) is a silent no-op. Returns whether a row changed.
 */
export function settleProposal(
  db: AiDb,
  id: string,
  status: SettledStatus,
  note: string | null = null
): boolean {
  const result = db
    .update(aiProposal)
    .set({ status, note, settledAt: new Date().toISOString() })
    .where(and(eq(aiProposal.id, id), eq(aiProposal.status, 'pending')))
    .run()
  return result.changes > 0
}

/** The row for `id`, or undefined once it is gone. */
export function getProposal(db: AiDb, id: string): AiProposalRow | undefined {
  return db.select().from(aiProposal).where(eq(aiProposal.id, id)).get()
}

/** Deletes every row outside the newest `max` (by `created_at`, then id) and returns how many went. */
export function evictProposals(db: AiDb, max = PROPOSAL_RETENTION_MAX): number {
  return db.run(
    sql`DELETE FROM ${aiProposal} WHERE ${aiProposal.id} NOT IN (
      SELECT ${aiProposal.id} FROM ${aiProposal}
      ORDER BY ${aiProposal.createdAt} DESC, ${aiProposal.id} DESC LIMIT ${max}
    )`
  ).changes
}

export function proposalCount(db: AiDb): number {
  return (
    db
      .select({ n: sql<number>`count(*)` })
      .from(aiProposal)
      .get()?.n ?? 0
  )
}

function withoutCreatedAt(input: ProposalInput): Omit<ProposalInput, 'createdAt'> {
  const { createdAt: _createdAt, ...rest } = input
  return rest
}
