import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { dismissedKey, type Dismissed } from '@shared/memory/dismissed'
import { isTopicKind, type TopicKind } from '@shared/memory/topics'
import { draft, node, reading, record, type ClaimRow } from '../../db/schema'
import { AppError } from '../../ipc/errors'
import type { TreeDb } from '../../tree/treeStore'
import { repointTodos, todoIdsOf } from '../authorTodoStore'
import {
  dismiss,
  dismissedIds,
  dismissedRowsOf,
  getDismissedByKey,
  insertDismissedRows,
  relabelDismissed,
  undoDismissed
} from '../dismissedStore'
import { deleteRecord, requireRecord, restoreTopicRecord, topicRecordRows } from '../recordStore'
import { insertClaimRows, taggedClaimRows, topicClaimRows } from './claimStore'
import { insertKnewBeforeRows, knewBeforeRowsOf } from './knewBeforeStore'
import { knowsThinker } from './recordEvidence'
import { getTopicSnapshots, setTopicSnapshots, type TopicSnapshot } from './readerRows'
import {
  deleteTopicEvidence,
  getTopicQuote,
  insertTopicQuoteRows,
  recordTopicQuoteRows,
  splitTopic
} from './topicStore'
import { readingOrder } from './views'

/**
 * The author's answers on secrets and threads (F-16.22; plan P2b §4.1, P2b-D5, D13), local and
 * free, behind `write` channels (refused after the trial):
 * - `splitReveal`: *Split* on a reveal the checker merged into a topic: a topic of its own again,
 *   with the lines that came with it, and a `split` Dismissed row so the two never merge again;
 * - `topicNotRight`: *Not a secret* / *Not a thread* on an AI-made topic: it goes with its reveals
 *   and lines, and one `notRight` row per reveal (keyed by the reveal's sentences) keeps the same
 *   sentences from making it again; the topic is kept as it was (`memoryTopicNotRight`);
 * - `restoreTopicNotRight`: *Undo* on any of those rows brings the topic back as it was, and
 *   takes its other rows off the list.
 */

/** What an action moved, for `memory:changed` and `record:changed`. */
export interface TopicChange {
  /** The topics made, gone or put back. */
  topicIds: string[]
  /** The scenes whose lines or reveals moved. */
  nodeIds: string[]
  /** The knowers whose lines moved. */
  recordIds: string[]
}

const unique = (ids: readonly string[]): string[] => [...new Set(ids)]

/** The knowers of knows lines (not the topic itself) and the scenes of some claim rows. */
function claimTouches(
  rows: readonly ClaimRow[],
  topicId: string
): { nodeIds: string[]; recordIds: string[] } {
  return {
    nodeIds: unique(rows.map((row) => row.nodeId)),
    recordIds: unique(
      rows.flatMap((row) =>
        row.recordId === null || row.recordId === topicId ? [] : [row.recordId]
      )
    )
  }
}

/**
 * *Split* (P2b-D5): the merged reveal becomes a topic of its own (AI-made, labelled as it was read;
 * a label another record holds gets " (secret)" and then its scene's reference), the lines tagged
 * with it move along, and a `split` Dismissed row is written. NOT_FOUND when the reveal is gone,
 * VALIDATION when it is no merged one.
 */
export function splitReveal(
  db: TreeDb,
  topicQuoteId: string,
  now: Date
): { recordId: string; dismissed: Dismissed; change: TopicChange } {
  const quote = getTopicQuote(db, topicQuoteId)
  if (quote === null) {
    throw new AppError('NOT_FOUND', 'That reveal is no longer there', { topicQuoteId })
  }
  const moved = taggedClaimRows(db, topicQuoteId)
  const { recordId, dismissed } = splitTopic(
    db,
    topicQuoteId,
    now,
    () => readingOrder(db).refs.get(quote.nodeId) ?? null
  )
  const touches = claimTouches(moved, quote.recordId)
  return {
    recordId,
    dismissed,
    change: {
      topicIds: [quote.recordId, recordId],
      nodeIds: unique([quote.nodeId, ...touches.nodeIds]),
      recordIds: touches.recordIds
    }
  }
}

const Stating = z.array(z.string())

/** A reveal row's stored sentences (its `stating` JSON); none when it no longer parses. */
function statingOf(raw: string): string[] {
  try {
    const parsed = Stating.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : []
  } catch {
    return []
  }
}

/** The word a topic kind is named by in a Dismissed row's label. */
const NOUN: Readonly<Record<TopicKind, string>> = { secret: 'a secret', thread: 'a thread' }

/**
 * *Not a secret* / *Not a thread* on an AI-made topic (P2b-D13): it goes with its reveals and the
 * lines it stood behind (the knows lines about a secret, a thread's steps) in every draft, and the
 * author's marks on it; one `notRight` row per reveal, keyed by the reveal's kind and sentences, so
 * those sentences never make it again while a new reveal elsewhere may (a topic whose reveals all
 * went gets one row keyed by its id, for *Undo*). Everything is kept as it was stored, for *Undo*.
 * VALIDATION for a named record or a topic the author made (she deletes hers from its sheet).
 * Answers the rows written, oldest reveal first.
 */
export function topicNotRight(
  db: TreeDb,
  recordId: string,
  now: Date
): { dismissed: Dismissed[]; change: TopicChange } {
  const topic = requireRecord(db, recordId)
  const kind = topic.kind
  if (!isTopicKind(kind)) {
    throw new AppError('VALIDATION', 'Only a secret or a thread can be said not to be one')
  }
  if (topic.origin !== 'ai') {
    throw new AppError('VALIDATION', `You made this ${kind}: delete it from its sheet instead`, {
      recordId
    })
  }
  const written: Dismissed[] = []
  let change: TopicChange = { topicIds: [recordId], nodeIds: [], recordIds: [] }
  db.transaction((tx) => {
    const rows = topicRecordRows(tx, recordId)
    if (rows === null) throw new AppError('NOT_FOUND', 'That record no longer exists', { recordId })
    const quotes = recordTopicQuoteRows(tx, recordId)
    const claims = topicClaimRows(tx, recordId)
    const snapshot: Omit<TopicSnapshot, 'rows'> = {
      record: rows.record,
      aliases: rows.aliases,
      quotes,
      claims,
      knewBefore: knewBeforeRowsOf(tx, recordId),
      dismissed: dismissedRowsOf(tx, recordId),
      todos: todoIdsOf(tx, recordId)
    }
    const label = `Not ${NOUN[kind]}: ${topic.name}`
    const reveals = quotes.length > 0 ? quotes : null
    for (const quote of reveals ?? []) {
      const key = dismissedKey({
        kind: 'notRight',
        topic: { kind, stating: statingOf(quote.stating) }
      })
      const before = getDismissedByKey(tx, 'notRight', key)
      let row = dismiss(
        tx,
        { kind: 'notRight', key, nodeId: quote.nodeId, label, quote: quote.quote },
        now
      )
      // A sentence that revealed two topics keys one row for both (the row another *Not a
      // secret* wrote): it names both, and its *Undo* brings back every topic that lists it.
      if (before !== null && !before.label.includes(label)) {
        row = relabelDismissed(tx, row.id, `${before.label}; ${label}`)
      }
      if (!written.some((each) => each.id === row.id)) written.push(row)
    }
    if (reveals === null) {
      written.push(
        dismiss(
          tx,
          {
            kind: 'notRight',
            key: dismissedKey({
              kind: 'notRight',
              topic: { kind, stating: [`record ${recordId}`] }
            }),
            label
          },
          now
        )
      )
    }
    deleteTopicEvidence(tx, recordId)
    const { pruned } = deleteRecord(tx, recordId)
    const live = new Set(dismissedIds(tx, 'notRight'))
    setTopicSnapshots(tx, [
      ...getTopicSnapshots(tx).filter((each) => each.rows.some((id) => live.has(id))),
      { ...snapshot, rows: written.map((row) => row.id) }
    ])
    const touches = claimTouches(claims, recordId)
    change = {
      topicIds: unique([recordId, ...pruned]),
      nodeIds: unique([...quotes.map((quote) => quote.nodeId), ...touches.nodeIds]),
      recordIds: touches.recordIds
    }
  })
  return { dismissed: written, change }
}

/** Whether a row with this id is in one of the tables a stored row points at. */
function exists(
  db: TreeDb,
  table: typeof node | typeof draft | typeof reading | typeof record,
  id: string
): boolean {
  return db.select({ id: table.id }).from(table).where(eq(table.id, id)).get() !== undefined
}

/**
 * *Undo* on a row *Not a secret* / *Not a thread* wrote (the row itself is gone already): every
 * topic that row stands for (one sentence may have revealed two) comes back as it was stored, with
 * its label (" (secret)" added when another record took it since), its reveals and lines where
 * their scene and draft still are (a reading, source or speaker gone since is cleared; a knower
 * gone takes its line along, and so does a knows thought whose thinker is gone, so it never counts
 * for the knower), the author's marks and the Dismissed rows that went with it (a
 * scene gone since is cleared on them); its other `notRight` rows leave the list. Null when the
 * row was no topic's. The anchors job then checks what came back against the text as it is now.
 */
export function restoreTopicNotRight(
  db: TreeDb,
  dismissedId: string
): (TopicChange & { undone: string[] }) | null {
  const snapshots = getTopicSnapshots(db)
  const mine = snapshots.filter((each) => each.rows.includes(dismissedId))
  if (mine.length === 0) return null
  const result: TopicChange & { undone: string[] } = {
    topicIds: [],
    nodeIds: [],
    recordIds: [],
    undone: []
  }
  db.transaction((tx) => {
    setTopicSnapshots(
      tx,
      snapshots.filter((each) => !mine.includes(each))
    )
    const live = dismissedIds(tx, 'notRight')
    const undone = unique(
      mine.flatMap((snapshot) => snapshot.rows.filter((id) => id !== dismissedId && live.has(id)))
    )
    for (const id of undone) undoDismissed(tx, id)
    result.undone = undone
    for (const snapshot of mine) {
      const change = restoreSnapshot(tx, snapshot)
      result.topicIds = unique([...result.topicIds, ...change.topicIds])
      result.nodeIds = unique([...result.nodeIds, ...change.nodeIds])
      result.recordIds = unique([...result.recordIds, ...change.recordIds])
    }
  })
  return result
}

/** One topic's snapshot put back (`restoreTopicNotRight`); nothing when its record cannot be. */
function restoreSnapshot(tx: TreeDb, snapshot: TopicSnapshot): TopicChange {
  const recordId = snapshot.record.id
  if (!restoreTopicRecord(tx, { record: snapshot.record, aliases: snapshot.aliases })) {
    return { topicIds: [], nodeIds: [], recordIds: [] }
  }
  const placed = (row: { nodeId: string; draftId: string }): boolean =>
    exists(tx, node, row.nodeId) && exists(tx, draft, row.draftId)
  const optional = (id: string | null): string | null =>
    id !== null && exists(tx, record, id) ? id : null
  insertTopicQuoteRows(
    tx,
    snapshot.quotes.filter(placed).map((row) => ({
      ...row,
      readingId: row.readingId !== null && exists(tx, reading, row.readingId) ? row.readingId : null
    }))
  )
  // A knows thought whose thinker is gone would read as the knower's own (`knowsLine`): it stays
  // gone rather than counting for the wrong person (`deleteThoughtsBy`).
  const voiced = (row: ClaimRow): boolean => {
    const thinker = knowsThinker(row)
    return thinker === null || exists(tx, record, thinker)
  }
  const claims = snapshot.claims
    .filter(
      (row) =>
        placed(row) && voiced(row) && (row.recordId === null || exists(tx, record, row.recordId))
    )
    .map((row) => ({
      ...row,
      readingId:
        row.readingId !== null && exists(tx, reading, row.readingId) ? row.readingId : null,
      objectId: optional(row.objectId),
      speakerId: optional(row.speakerId),
      fromId: optional(row.fromId),
      // The reveal a merged line came with is put back above when its scene still is.
      topicQuoteId:
        row.topicQuoteId !== null &&
        snapshot.quotes.some((quote) => quote.id === row.topicQuoteId && placed(quote))
          ? row.topicQuoteId
          : null
    }))
  insertClaimRows(tx, claims)
  insertKnewBeforeRows(tx, snapshot.knewBefore)
  // A scene gone since is cleared, as its foreign key would have done.
  insertDismissedRows(
    tx,
    snapshot.dismissed.map((row) => ({
      ...row,
      recordId: optional(row.recordId),
      nodeId: row.nodeId !== null && exists(tx, node, row.nodeId) ? row.nodeId : null
    }))
  )
  repointTodos(tx, snapshot.todos, recordId)
  const touches = claimTouches(claims, recordId)
  return {
    topicIds: [recordId],
    nodeIds: unique([
      ...snapshot.quotes.filter(placed).map((row) => row.nodeId),
      ...touches.nodeIds
    ]),
    recordIds: touches.recordIds
  }
}
