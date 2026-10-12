import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { z } from 'zod'
import type { TopicQuoteRole, TopicQuoteState } from '@shared/memory/claims'
import { dismissedKey } from '@shared/memory/dismissed'
import type { RecordOrigin } from '@shared/memory/records'
import { topicLabel, type TopicKind } from '@shared/memory/topics'
import type { InvariantTopic } from '@shared/memory/invariants'
import { claim, topicQuote, type TopicQuoteRow } from '../../db/schema'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { dismiss } from '../dismissedStore'
import { insertTopicRecord, listRecords, requireRecord } from '../recordStore'
import { topicBackings } from './recordEvidence'

/**
 * Secrets' and threads' reveals (F-16.22, F-16.23; plan P2b §1.3): the one writer of
 * `topic_quote`, and the topic lifecycle the reading drives:
 * - `createTopic`: a new AI-made secret or thread, made silently once its reveal is proved
 *   (P2b-D3), with its label as its one name and its reveal as the `defining` quote;
 * - `mergeInto`: a new topic the checker judged the same as an open one (P2b-D4) becomes a
 *   `merged` reveal on it, and the claims that came with it move to it, tagged;
 * - `splitTopic`: *Split* undoes a merge (P2b-D5): a new AI-made topic from the merged reveal, its
 *   tagged claims moved back, and a `split` Dismissed row so the two never merge again;
 * - `deleteTopicEvidence`: a topic's reveals and claims, for *Not a secret* (slice 4).
 * Rows are per draft and anchored like claims (`anchor`, `stating`); only the active draft's are
 * live. Pruning an AI-made topic nothing backs is the record store's (`pruneTopics`).
 */

const Strings = z.array(z.string())

/** A stored reveal. */
export interface TopicQuote {
  id: string
  recordId: string
  draftId: string
  nodeId: string
  role: TopicQuoteRole
  label: string
  para: number
  quote: string
  anchor: string[]
  stating: string[]
  readingId: string | null
  state: TopicQuoteState
  created: string
  proved: string
}

function parseStrings(raw: string): string[] | null {
  try {
    const parsed = Strings.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** A stored row as a reveal; null when its JSON no longer parses (skipped, never thrown on). */
export function toTopicQuote(row: TopicQuoteRow): TopicQuote | null {
  const anchor = parseStrings(row.anchor)
  const stating = parseStrings(row.stating)
  if (anchor === null || stating === null) return null
  return { ...row, anchor, stating }
}

const toQuotes = (rows: readonly TopicQuoteRow[]): TopicQuote[] =>
  rows.flatMap((row) => {
    const parsed = toTopicQuote(row)
    return parsed === null ? [] : [parsed]
  })

/** A reveal to store: where it is, what it reads, and the reading that proved it. */
export interface NewTopicQuote {
  nodeId: string
  draftId: string
  para: number
  quote: string
  /** The reader's label for it (at most 8 words). */
  label: string
  anchor: readonly string[]
  /** The gate texts of the quote's sentences (`gateText`): a Dismissed key's input. */
  stating: readonly string[]
  readingId: string | null
}

/** Stores one reveal on a topic; answers its id. */
export function insertTopicQuote(
  db: TreeDb,
  recordId: string,
  role: TopicQuoteRole,
  input: NewTopicQuote,
  now: Date
): string {
  const id = randomUUID()
  const at = now.toISOString()
  db.insert(topicQuote)
    .values({
      id,
      recordId,
      draftId: input.draftId,
      nodeId: input.nodeId,
      role,
      label: topicLabel(input.label),
      para: input.para,
      quote: input.quote,
      anchor: JSON.stringify(input.anchor),
      stating: JSON.stringify(input.stating),
      readingId: input.readingId,
      state: 'live',
      created: at,
      proved: at
    })
    .run()
  return id
}

export function getTopicQuote(db: TreeDb, id: string): TopicQuote | null {
  const row = db.select().from(topicQuote).where(eq(topicQuote.id, id)).get()
  return row === undefined ? null : toTopicQuote(row)
}

/** Every reveal of one draft, in the order they were stored. */
export function listTopicQuotes(db: TreeDb, draftId: string): TopicQuote[] {
  return toQuotes(
    db
      .select()
      .from(topicQuote)
      .where(eq(topicQuote.draftId, draftId))
      .orderBy(asc(topicQuote.created), sql`rowid`)
      .all()
  )
}

/** One scene's reveals in one draft, in paragraph order. */
export function sceneTopicQuotes(db: TreeDb, nodeId: string, draftId: string): TopicQuote[] {
  return toQuotes(
    db
      .select()
      .from(topicQuote)
      .where(and(eq(topicQuote.nodeId, nodeId), eq(topicQuote.draftId, draftId)))
      .orderBy(asc(topicQuote.para), asc(topicQuote.created), sql`rowid`)
      .all()
  )
}

/** One topic's reveals in every draft. */
export function recordTopicQuotes(db: TreeDb, recordId: string): TopicQuote[] {
  return toQuotes(
    db
      .select()
      .from(topicQuote)
      .where(eq(topicQuote.recordId, recordId))
      .orderBy(asc(topicQuote.created), sql`rowid`)
      .all()
  )
}

/** Reveals by id, as stored (Rename in book keeps them for its undo). */
export function topicQuoteRows(db: TreeDb, ids: readonly string[]): TopicQuoteRow[] {
  if (ids.length === 0) return []
  return db
    .select()
    .from(topicQuote)
    .where(inArray(topicQuote.id, [...ids]))
    .all()
}

/** Every reveal row of one scene in every draft (Rename in book's rewrite). */
export function sceneTopicQuoteRows(db: TreeDb, nodeId: string): TopicQuoteRow[] {
  return db.select().from(topicQuote).where(eq(topicQuote.nodeId, nodeId)).all()
}

/** Writes a reveal row as it is (Rename in book's rewrite, and its undo). */
export function writeTopicQuoteRow(db: TreeDb, row: TopicQuoteRow): void {
  db.update(topicQuote).set(row).where(eq(topicQuote.id, row.id)).run()
}

/** A reveal whose anchor holds, following its quote to another paragraph (`moved`). */
export function setTopicQuotePara(db: TreeDb, id: string, para: number): void {
  db.update(topicQuote).set({ para }).where(eq(topicQuote.id, id)).run()
}

/** Reveals whose sentences changed (`stale`), or whose sentences stand in place again (`live`). */
export function setTopicQuotesState(
  db: TreeDb,
  ids: readonly string[],
  state: TopicQuoteState
): void {
  if (ids.length === 0) return
  db.update(topicQuote)
    .set({ state })
    .where(inArray(topicQuote.id, [...ids]))
    .run()
}

/** A restored reveal: live again where its quote sits now. */
export function restoreTopicQuote(db: TreeDb, id: string, para: number): void {
  db.update(topicQuote).set({ state: 'live', para }).where(eq(topicQuote.id, id)).run()
}

/** A re-checking reveal the reading found stated again: new quote, anchor and proof (slice 2). */
export function reviveTopicQuote(
  db: TreeDb,
  id: string,
  fresh: {
    para: number
    quote: string
    anchor: readonly string[]
    stating: readonly string[]
    readingId: string | null
  },
  now: Date
): void {
  db.update(topicQuote)
    .set({
      para: fresh.para,
      quote: fresh.quote,
      anchor: JSON.stringify(fresh.anchor),
      stating: JSON.stringify(fresh.stating),
      readingId: fresh.readingId,
      state: 'live',
      proved: now.toISOString()
    })
    .where(eq(topicQuote.id, id))
    .run()
}

export function deleteTopicQuotes(db: TreeDb, ids: readonly string[]): void {
  if (ids.length === 0) return
  db.delete(topicQuote)
    .where(inArray(topicQuote.id, [...ids]))
    .run()
}

/**
 * A new AI-made secret or thread (P2b-D3): a record in the `secret` or `thread` category, its
 * label (cut to 8 words) as its one name (" (secret)" / " (thread)" and then the scene reference
 * added when another record holds it, P2b-D1), and its reveal as the `defining` quote. Answers
 * both ids. The caller holds the reading's transaction.
 */
export function createTopic(
  db: TreeDb,
  input: { kind: TopicKind; label: string; quote: NewTopicQuote; ref?: () => string | null },
  now: Date
): { recordId: string; topicQuoteId: string } {
  const label = topicLabel(input.label)
  if (label === '') throw new AppError('VALIDATION', 'A secret or thread needs a label')
  let ids = { recordId: '', topicQuoteId: '' }
  db.transaction((tx) => {
    const made = insertTopicRecord(
      tx,
      {
        kind: input.kind,
        label,
        origin: 'ai',
        ...(input.ref === undefined ? {} : { ref: input.ref })
      },
      now
    )
    const topicQuoteId = insertTopicQuote(tx, made.id, 'defining', { ...input.quote, label }, now)
    ids = { recordId: made.id, topicQuoteId }
  })
  return ids
}

/** Moves claims onto a topic: a knows claim's secret is its object, a thread step's its record. */
function pointClaimsAt(
  db: TreeDb,
  topicId: string,
  claimIds: readonly string[],
  tag: string | null
): void {
  if (claimIds.length === 0) return
  const ids = [...claimIds]
  db.update(claim)
    .set({ objectId: topicId, topicQuoteId: tag })
    .where(and(inArray(claim.id, ids), eq(claim.slot, 'knows')))
    .run()
  db.update(claim)
    .set({ recordId: topicId, topicQuoteId: tag })
    .where(and(inArray(claim.id, ids), eq(claim.slot, 'thread')))
    .run()
}

/**
 * A new topic judged the same as `targetId` (P2b-D4): its reveal is stored on the target as a
 * `merged` quote, and the claims that came with it (`claimIds`: knows lines about it, its thread
 * steps) are moved to the target and tagged with that quote, so *Split* moves exactly those back.
 * Answers the merged quote's id.
 */
export function mergeInto(
  db: TreeDb,
  targetId: string,
  quote: NewTopicQuote,
  claimIds: readonly string[],
  now: Date
): string {
  const target = requireRecord(db, targetId)
  if (target.kind !== 'secret' && target.kind !== 'thread') {
    throw new AppError('VALIDATION', 'Only a secret or a thread takes a merged reveal')
  }
  let id = ''
  db.transaction((tx) => {
    id = insertTopicQuote(tx, targetId, 'merged', quote, now)
    pointClaimsAt(tx, targetId, claimIds, id)
  })
  return id
}

/**
 * *Split* a merged reveal off its topic (P2b-D5): a new AI-made topic of the same kind, labelled as
 * the reveal was read, takes the reveal (as its `defining` quote) and the claims tagged with it;
 * a `split` Dismissed row keeps the two from merging again (its *Undo* only allows a later merge,
 * it never re-merges). Answers the new topic's id.
 */
export function splitTopic(
  db: TreeDb,
  topicQuoteId: string,
  now: Date,
  ref?: () => string | null
): { recordId: string } {
  const merged = getTopicQuote(db, topicQuoteId)
  if (merged === null) {
    throw new AppError('NOT_FOUND', 'That reveal is no longer there', { topicQuoteId })
  }
  if (merged.role !== 'merged') {
    throw new AppError('VALIDATION', 'Only a reveal merged into another can be split off')
  }
  const from = requireRecord(db, merged.recordId)
  const kind = from.kind
  if (kind !== 'secret' && kind !== 'thread') {
    throw new AppError('VALIDATION', 'Only a secret or a thread splits by reveal')
  }
  let recordId = ''
  db.transaction((tx) => {
    const made = insertTopicRecord(
      tx,
      { kind, label: merged.label, origin: 'ai', ...(ref === undefined ? {} : { ref }) },
      now
    )
    recordId = made.id
    tx.update(topicQuote)
      .set({ recordId, role: 'defining', label: made.label })
      .where(eq(topicQuote.id, topicQuoteId))
      .run()
    const tagged = tx
      .select({ id: claim.id })
      .from(claim)
      .where(eq(claim.topicQuoteId, topicQuoteId))
      .all()
      .map((row) => row.id)
    pointClaimsAt(tx, recordId, tagged, null)
    dismiss(
      tx,
      {
        kind: 'split',
        key: dismissedKey({ kind: 'split', a: from.id, b: recordId }),
        recordId: from.id,
        label: `${from.name} and ${made.label} are different`,
        quote: merged.quote
      },
      now
    )
  })
  return { recordId }
}

/**
 * A topic's reveals and claims in every draft (*Not a secret* / *Not a thread*, slice 4): the
 * knows lines about a secret, a thread's steps. The record itself stays for the caller to prune.
 */
export function deleteTopicEvidence(db: TreeDb, recordId: string): void {
  db.transaction((tx) => {
    tx.delete(topicQuote).where(eq(topicQuote.recordId, recordId)).run()
    tx.delete(claim)
      .where(and(eq(claim.objectId, recordId), eq(claim.slot, 'knows')))
      .run()
    tx.delete(claim).where(eq(claim.recordId, recordId)).run()
  })
}

/** Every secret and thread as the memory invariants read them (`topicEmpty`). */
export function invariantTopics(db: TreeDb): InvariantTopic[] {
  return topicBackings(db)
}

/**
 * Every secret or thread record, oldest first, with its label and origin (the views and the
 * reader's topics roster read them). The topics roster follows them by comparing (P2b-D10), so a
 * topic made, merged, split or pruned never moves the cached record lines.
 */
export function listTopics(
  db: TreeDb,
  kind?: TopicKind
): { recordId: string; kind: TopicKind; label: string; origin: RecordOrigin; created: string }[] {
  return listRecords(db)
    .flatMap((each) =>
      (each.kind === 'secret' || each.kind === 'thread') &&
      (kind === undefined || each.kind === kind)
        ? [
            {
              recordId: each.id,
              kind: each.kind,
              label: each.name,
              origin: each.origin,
              created: each.created
            }
          ]
        : []
    )
    .sort((a, b) => a.created.localeCompare(b.created) || a.recordId.localeCompare(b.recordId))
}
