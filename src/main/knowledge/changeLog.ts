import { randomUUID } from 'node:crypto'
import { and, desc, eq, lt, or, sql } from 'drizzle-orm'
import {
  CHANGES_MAX,
  ChangeUndo,
  type ChangeEntry,
  type ChangeKind,
  type ChangePage,
  type ChangeUndoResult
} from '@shared/changes'
import {
  documentTag,
  entity,
  fact,
  knowledgeChange,
  tag,
  type KnowledgeChangeRow
} from '../db/schema'
import { deleteEntity, type EntityDb } from '../entity/entityStore'
import { setFactHidden } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { getDismissedNames, setDismissedNames } from '../project/settingsStore'
import { removeDocumentTag } from '../tag/documentTagStore'
import { deleteTag } from '../tag/tagStore'

/**
 * The Changes log (F-9.13, D12): what the background reading applied on its own, one row per
 * change and one run per reading of a scene, each with the inverse it is undone by. Undo always
 * goes through an existing tombstone, so the next reading does not redo it: the fact is hidden,
 * the sheet deleted (its name remembered), the tag deleted (its name remembered), the scene's tag
 * removed (the pair remembered). Nothing here reads or writes scene text.
 */

/** One change as the reading hands it to the log. */
export interface ChangeInput {
  kind: ChangeKind
  nodeId: string | null
  quote: string | null
  entityId: string | null
  targetId: string
  label: string
  undo: ChangeUndo
}

function rowToEntry(row: KnowledgeChangeRow): ChangeEntry {
  return {
    id: row.id,
    runId: row.runId,
    createdAt: row.createdAt,
    nodeId: row.nodeId,
    quote: row.quote,
    kind: row.kind,
    entityId: row.entityId,
    label: row.label,
    status: row.status
  }
}

/**
 * Writes one run's changes (in the caller's transaction) and prunes the log to `CHANGES_MAX`
 * rows, oldest first. Answers how many were logged; an empty list writes nothing.
 */
export function logChanges(
  db: EntityDb,
  runId: string,
  changes: readonly ChangeInput[],
  now: string
): number {
  if (changes.length === 0) return 0
  db.insert(knowledgeChange)
    .values(
      changes.map((change) => ({
        id: randomUUID(),
        runId,
        createdAt: now,
        nodeId: change.nodeId,
        quote: change.quote,
        kind: change.kind,
        entityId: change.entityId,
        targetId: change.targetId,
        label: change.label,
        undo: JSON.stringify(change.undo),
        status: 'applied' as const
      }))
    )
    .run()
  pruneChanges(db, CHANGES_MAX)
  return changes.length
}

/** Drops the oldest rows past `max`. */
export function pruneChanges(db: EntityDb, max: number): void {
  db.run(
    sql`DELETE FROM knowledge_change WHERE rowid IN (
      SELECT rowid FROM knowledge_change ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${max}
    )`
  )
}

/**
 * One page of the log, newest first (a run's rows together, in the order they were logged).
 * `before` is the id of the last row the caller holds; an unknown id answers the first page.
 */
export function listChanges(
  db: EntityDb,
  input: { before?: string | undefined; limit: number }
): ChangePage {
  const rowid = sql<number>`rowid`
  const cursor =
    input.before === undefined
      ? undefined
      : db
          .select({ createdAt: knowledgeChange.createdAt, rowid })
          .from(knowledgeChange)
          .where(eq(knowledgeChange.id, input.before))
          .get()
  const rows = db
    .select()
    .from(knowledgeChange)
    .where(
      cursor === undefined
        ? undefined
        : or(
            lt(knowledgeChange.createdAt, cursor.createdAt),
            and(eq(knowledgeChange.createdAt, cursor.createdAt), sql`rowid < ${cursor.rowid}`)
          )
    )
    .orderBy(desc(knowledgeChange.createdAt), desc(rowid))
    .limit(input.limit + 1)
    .all()
  return {
    entries: rows.slice(0, input.limit).map(rowToEntry),
    more: rows.length > input.limit
  }
}

/** What undoing accumulates, turned into `ChangeUndoResult` at the end. */
interface UndoTally {
  entries: ChangeEntry[]
  removedEntityIds: Set<string>
  removedTagIds: Set<string>
  entityIds: Set<string>
  nodeIds: Set<string>
}

/** Undoes one applied row inside the caller's transaction; a row already undone is left alone. */
function undoRow(db: EntityDb, row: KnowledgeChangeRow, tally: UndoTally): void {
  if (row.status === 'undone') return
  const parsed = ChangeUndo.safeParse(JSON.parse(row.undo))
  if (!parsed.success)
    throw new AppError('VALIDATION', 'This change cannot be undone', { id: row.id })
  const undo = parsed.data
  switch (undo.type) {
    case 'hideFact': {
      const held = db
        .select({
          id: fact.id,
          hidden: fact.hidden,
          entityId: fact.entityId,
          objectEntityId: fact.objectEntityId
        })
        .from(fact)
        .where(eq(fact.id, undo.factId))
        .get()
      // Gone with its quote, or hidden already: nothing left to take back.
      if (held !== undefined && !held.hidden) {
        setFactHidden(db, undo.factId, true)
        tally.entityIds.add(held.entityId)
        // F-9.14: a relationship's other sheet moves too.
        if (held.objectEntityId !== null) tally.entityIds.add(held.objectEntityId)
      }
      break
    }
    case 'deleteRecord': {
      const held = db
        .select({ origin: entity.origin })
        .from(entity)
        .where(eq(entity.id, undo.entityId))
        .get()
      if (held === undefined) break
      if (held.origin !== 'ai') {
        throw new AppError(
          'VALIDATION',
          'You have edited this sheet since the AI made it, so it is yours now. Delete it from its page if you no longer want it.',
          { id: row.id, entityId: undo.entityId }
        )
      }
      deleteEntity(db, undo.entityId)
      tally.removedEntityIds.add(undo.entityId)
      break
    }
    case 'deleteTag': {
      const held = db
        .select({ name: tag.name, origin: tag.origin })
        .from(tag)
        .where(eq(tag.id, undo.tagId))
        .get()
      if (held === undefined) break
      const authorLink = db
        .select({ id: documentTag.id })
        .from(documentTag)
        .where(and(eq(documentTag.tagId, undo.tagId), eq(documentTag.source, 'author')))
        .get()
      // Edited by the author or put on a scene by hand: the tag is theirs, and so are its links.
      if (held.origin !== 'ai' || authorLink !== undefined) {
        throw new AppError(
          'VALIDATION',
          'You have edited or used this tag since the AI made it, so it is yours now. Delete it from the tag bank if you no longer want it.',
          { id: row.id, tagId: undo.tagId }
        )
      }
      deleteTag(db, undo.tagId)
      // The name is remembered whoever made the tag, so the next reading does not make it again.
      const dismissed = getDismissedNames(db)
      if (!dismissed.names.includes(held.name)) {
        setDismissedNames(db, { names: [...dismissed.names, held.name] })
      }
      tally.removedTagIds.add(undo.tagId)
      break
    }
    case 'unlinkTag': {
      const exists = db.select({ id: tag.id }).from(tag).where(eq(tag.id, undo.tagId)).get()
      if (exists === undefined) break
      try {
        removeDocumentTag(db, undo.nodeId, undo.tagId)
        tally.nodeIds.add(undo.nodeId)
      } catch (err) {
        // The scene is gone: the link went with it.
        if (!(err instanceof AppError) || err.code !== 'NOT_FOUND') throw err
      }
      break
    }
  }
  const updated = db
    .update(knowledgeChange)
    .set({ status: 'undone' })
    .where(eq(knowledgeChange.id, row.id))
    .returning()
    .get()
  if (updated !== undefined) tally.entries.push(rowToEntry(updated))
}

/** The order a run is taken back in: what depends on a sheet or a tag first, the sheet and tag last. */
const UNDO_ORDER: Readonly<Record<ChangeKind, number>> = { tagLink: 0, fact: 1, record: 2, tag: 3 }

function undoRows(db: EntityDb, rows: readonly KnowledgeChangeRow[]): ChangeUndoResult {
  const tally: UndoTally = {
    entries: [],
    removedEntityIds: new Set(),
    removedTagIds: new Set(),
    entityIds: new Set(),
    nodeIds: new Set()
  }
  db.transaction((tx) => {
    for (const row of [...rows].sort((a, b) => UNDO_ORDER[a.kind] - UNDO_ORDER[b.kind])) {
      undoRow(tx, row, tally)
    }
  })
  return {
    entries: tally.entries,
    removedEntityIds: [...tally.removedEntityIds],
    removedTagIds: [...tally.removedTagIds],
    entityIds: [...tally.entityIds].filter((id) => !tally.removedEntityIds.has(id)),
    nodeIds: [...tally.nodeIds]
  }
}

/** Undoes one change (`changes:undo`); NOT_FOUND for an unknown id (pruned). */
export function undoChange(db: EntityDb, id: string): ChangeUndoResult {
  const row = db.select().from(knowledgeChange).where(eq(knowledgeChange.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'Change not found', { id })
  return undoRows(db, [row])
}

/**
 * Undoes every applied change of one run (`changes:undoRun`), in one transaction: a change that
 * cannot be undone (a sheet or a tag the author has made theirs) refuses the whole run, so nothing is
 * half taken back. NOT_FOUND for a run with no rows.
 */
export function undoRun(db: EntityDb, runId: string): ChangeUndoResult {
  const rows = db.select().from(knowledgeChange).where(eq(knowledgeChange.runId, runId)).all()
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Run not found', { runId })
  return undoRows(db, rows)
}
