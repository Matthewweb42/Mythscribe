import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  DISMISSED_LABEL_MAX,
  DISMISSED_QUOTE_MAX,
  type Dismissed,
  type DismissedKind,
  type DismissedList
} from '@shared/memory/dismissed'
import { dismissed, type DismissedRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/**
 * The one Dismissed list of story memory v2 (F-16.10): every tombstone in one table, unique per
 * kind and key (`dismissedKey`). `dismiss` is idempotent; `undoDismissed` deletes the row, so the
 * thing may come back, and nothing else is reversed.
 */

function toDismissed(row: DismissedRow): Dismissed {
  return {
    id: row.id,
    kind: row.kind,
    key: row.key,
    recordId: row.recordId,
    nodeId: row.nodeId,
    label: row.label,
    quote: row.quote,
    created: row.created
  }
}

export interface DismissInput {
  kind: DismissedKind
  key: string
  recordId?: string | null
  nodeId?: string | null
  label: string
  quote?: string | null
}

/** Writes a tombstone, or answers the one already there for this kind and key. */
export function dismiss(db: TreeDb, input: DismissInput, now: Date): Dismissed {
  const existing = getDismissedByKey(db, input.kind, input.key)
  if (existing !== null) return existing
  const row: DismissedRow = {
    id: randomUUID(),
    kind: input.kind,
    key: input.key,
    recordId: input.recordId ?? null,
    nodeId: input.nodeId ?? null,
    label: input.label.slice(0, DISMISSED_LABEL_MAX),
    quote:
      input.quote === undefined || input.quote === null
        ? null
        : input.quote.slice(0, DISMISSED_QUOTE_MAX),
    created: now.toISOString()
  }
  db.insert(dismissed).values(row).run()
  return toDismissed(row)
}

export function getDismissedByKey(db: TreeDb, kind: DismissedKind, key: string): Dismissed | null {
  const row = db
    .select()
    .from(dismissed)
    .where(and(eq(dismissed.kind, kind), eq(dismissed.key, key)))
    .get()
  return row === undefined ? null : toDismissed(row)
}

export function isDismissed(db: TreeDb, kind: DismissedKind, key: string): boolean {
  return getDismissedByKey(db, kind, key) !== null
}

/** Every key of one kind, for the scans and the gate. */
export function dismissedKeys(db: TreeDb, kind: DismissedKind): Set<string> {
  return new Set(
    db
      .select({ key: dismissed.key })
      .from(dismissed)
      .where(eq(dismissed.kind, kind))
      .all()
      .map((row) => row.key)
  )
}

/** The list as the author sees it: newest first, with the count. */
export function listDismissed(db: TreeDb): DismissedList {
  const items = db
    .select()
    .from(dismissed)
    .orderBy(desc(dismissed.created), desc(sql`rowid`))
    .all()
    .map(toDismissed)
  return { items, count: items.length }
}

/** Undo: the tombstone goes (the thing may come back). Answers the row that went. */
export function undoDismissed(db: TreeDb, id: string): Dismissed {
  const row = db.select().from(dismissed).where(eq(dismissed.id, id)).get()
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'That entry is no longer dismissed', { id })
  db.delete(dismissed).where(eq(dismissed.id, id)).run()
  return toDismissed(row)
}

/** Removes a tombstone by kind and key, if there is one (an alias the author added back). */
export function forgetDismissed(db: TreeDb, kind: DismissedKind, key: string): void {
  db.delete(dismissed)
    .where(and(eq(dismissed.kind, kind), eq(dismissed.key, key)))
    .run()
}
