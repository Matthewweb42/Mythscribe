import { and, eq } from 'drizzle-orm'
import type { MemoryOwnerKind } from '@shared/memory/passages'
import { memoryScan } from '../db/schema'
import type { TreeDb } from '../tree/treeStore'

/**
 * `memory_scan` (F-16.5): what the last name scan and passage index of an owner read, as two
 * hashes. The name indexer and the passage indexer each write their own column; a hash that
 * still matches skips the work.
 */

export interface MemoryScanHashes {
  namesHash: string | null
  passagesHash: string | null
}

export function getScanHashes(db: TreeDb, kind: MemoryOwnerKind, id: string): MemoryScanHashes {
  const row = db
    .select({ namesHash: memoryScan.namesHash, passagesHash: memoryScan.passagesHash })
    .from(memoryScan)
    .where(and(eq(memoryScan.ownerKind, kind), eq(memoryScan.ownerId, id)))
    .get()
  return row ?? { namesHash: null, passagesHash: null }
}

/** Every owner's hashes of one kind, by owner id. */
export function scanHashesOf(db: TreeDb, kind: MemoryOwnerKind): Map<string, MemoryScanHashes> {
  return new Map(
    db
      .select({
        id: memoryScan.ownerId,
        namesHash: memoryScan.namesHash,
        passagesHash: memoryScan.passagesHash
      })
      .from(memoryScan)
      .where(eq(memoryScan.ownerKind, kind))
      .all()
      .map((row) => [row.id, { namesHash: row.namesHash, passagesHash: row.passagesHash }])
  )
}

/** Records one of the two hashes for an owner (upsert), leaving the other as it was. */
export function setScanHash(
  db: TreeDb,
  kind: MemoryOwnerKind,
  id: string,
  column: 'names' | 'passages',
  hash: string,
  now: Date
): void {
  const at = now.toISOString()
  const set = column === 'names' ? { namesHash: hash } : { passagesHash: hash }
  db.insert(memoryScan)
    .values({
      ownerKind: kind,
      ownerId: id,
      namesHash: column === 'names' ? hash : null,
      passagesHash: column === 'passages' ? hash : null,
      scannedAt: at
    })
    .onConflictDoUpdate({
      target: [memoryScan.ownerKind, memoryScan.ownerId],
      set: { ...set, scannedAt: at }
    })
    .run()
}

/** Forgets an owner's hashes (its rows went), so it is indexed afresh if it comes back. */
export function deleteScanRow(db: TreeDb, kind: MemoryOwnerKind, id: string): void {
  db.delete(memoryScan)
    .where(and(eq(memoryScan.ownerKind, kind), eq(memoryScan.ownerId, id)))
    .run()
}
