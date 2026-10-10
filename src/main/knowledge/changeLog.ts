import { randomUUID } from 'node:crypto'
import { and, desc, eq, getTableColumns, lt, ne, or, sql } from 'drizzle-orm'
import { aliasKey } from '@shared/aliases'
import {
  CHANGES_MAX,
  ChangeKind,
  ChangeUndo,
  RECORDED_UNDO_OF,
  changeRunId,
  changeSourceOf,
  type ChangeEntry,
  type ChangePage,
  type ChangeUndoResult,
  type RecordChangesInput
} from '@shared/changes'
import { toEntityNameKey } from '@shared/entities'
import type { FactStatus } from '@shared/facts'
import type { Entity, Tag } from '@shared/ipc/contract'
import type { SheetPatch, TagPatch } from '@shared/organise'
import { toTagName } from '@shared/tags'
import {
  documentTag,
  documentTagDismissal,
  entity,
  fact,
  knowledgeChange,
  node,
  tag,
  type KnowledgeChangeRow
} from '../db/schema'
import { deleteEntity, getEntity, updateEntity, type EntityDb } from '../entity/entityStore'
import { setFactHidden, setFactStatus } from '../entity/factStore'
import { AppError } from '../ipc/errors'
import { restoreCleared } from './clearSnapshot'
import { getDismissedNames, setDismissedNames } from '../project/settingsStore'
import { addDocumentTag, removeDocumentTag } from '../tag/documentTagStore'
import { deleteTag, getTagWithUsage, updateTag } from '../tag/tagStore'

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

/**
 * A stored row as this build reads it, or null when it cannot (F-9.15): `CHANGE_KINDS` grows with
 * no migration, so a database a newer build wrote can hold a kind or an inverse this build does
 * not know, or (damaged) an inverse that is not JSON. Such a row is passed over, never thrown on.
 */
interface ReadRow {
  row: KnowledgeChangeRow
  kind: ChangeKind
  undo: ChangeUndo
}

function readRow(row: KnowledgeChangeRow): ReadRow | null {
  const kind = ChangeKind.safeParse(row.kind)
  if (!kind.success) return null
  let json: unknown
  try {
    json = JSON.parse(row.undo)
  } catch {
    return null
  }
  const undo = ChangeUndo.safeParse(json)
  return undo.success ? { row, kind: kind.data, undo: undo.data } : null
}

function toEntry({ row, kind, undo }: ReadRow): ChangeEntry {
  return {
    id: row.id,
    runId: row.runId,
    createdAt: row.createdAt,
    nodeId: row.nodeId,
    quote: row.quote,
    kind,
    entityId: row.entityId,
    label: row.label,
    status: row.status,
    source: changeSourceOf(row.runId),
    // F-9.15: a merge's or a deletion's inverse takes nothing back.
    undoable: undo.type !== 'none'
  }
}

/** A row this build wrote itself (just inserted or updated), as the log lists it. */
function rowToEntry(row: KnowledgeChangeRow): ChangeEntry {
  const read = readRow(row)
  if (read === null) throw new AppError('VALIDATION', 'This change cannot be read', { id: row.id })
  return toEntry(read)
}

/**
 * The sheets (and the tags they made) `entity:create` made this session, per project database
 * (F-9.15): a recorded `deleteSheet` may only name one of them, so a logged Undo never deletes a
 * sheet the run did not make.
 */
const createdHere = new WeakMap<EntityDb, { sheets: Set<string>; tags: Set<string> }>()

/** Remembers a sheet `entity:create` made, and the tag it made with it (null when it made none). */
export function noteCreatedSheet(db: EntityDb, entityId: string, madeTagId: string | null): void {
  let made = createdHere.get(db)
  if (made === undefined) {
    made = { sheets: new Set(), tags: new Set() }
    createdHere.set(db, made)
  }
  made.sheets.add(entityId)
  if (madeTagId !== null) made.tags.add(madeTagId)
}

/** F-5.25: remembers a tag `tag:create` made this session, so a chat run may log it as made. */
export function noteCreatedTag(db: EntityDb, tagId: string): void {
  let made = createdHere.get(db)
  if (made === undefined) {
    made = { sheets: new Set(), tags: new Set() }
    createdHere.set(db, made)
  }
  made.tags.add(tagId)
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
  return insertChanges(db, runId, changes, now).length
}

/** `logChanges`, answering the rows as written. */
function insertChanges(
  db: EntityDb,
  runId: string,
  changes: readonly ChangeInput[],
  now: string
): KnowledgeChangeRow[] {
  if (changes.length === 0) return []
  const rows = db
    .insert(knowledgeChange)
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
    .returning()
    .all()
  pruneChanges(db, CHANGES_MAX)
  return rows
}

/** `logChanges`, answering the rows as the log lists them (F-5.25: the clear's one row). */
export function logChangeEntries(
  db: EntityDb,
  runId: string,
  changes: readonly ChangeInput[],
  now: string
): ChangeEntry[] {
  return insertChanges(db, runId, changes, now).map(rowToEntry)
}

/** The parts of a sheet a patch names, compared as the store keeps them (trimmed; names by key). */
export function sheetMatches(sheet: Entity, patch: SheetPatch): boolean {
  if (patch.name !== undefined && toEntityNameKey(patch.name) !== toEntityNameKey(sheet.name)) {
    return false
  }
  if (patch.kind !== undefined && patch.kind !== sheet.kind) return false
  if (patch.fields !== undefined) {
    const held = new Map(Object.entries(sheet.fields))
    for (const [field, value] of Object.entries(patch.fields)) {
      if ((held.get(field) ?? '').trim() !== value.trim()) return false
    }
  }
  if (patch.body !== undefined && (sheet.body ?? '').trim() !== (patch.body ?? '').trim()) {
    return false
  }
  return patch.aliases === undefined || sameAliases(sheet.aliases, patch.aliases)
}

/** The parts of a tag a patch names, compared as the bank keeps them. */
export function tagMatches(held: Tag, patch: TagPatch): boolean {
  if (patch.name !== undefined && toTagName(patch.name) !== held.name) return false
  if (patch.category !== undefined && patch.category !== held.category) return false
  if (patch.parentId !== undefined && patch.parentId !== held.parentId) return false
  return patch.aliases === undefined || sameAliases(held.aliases, patch.aliases)
}

function sameAliases(a: readonly string[], b: readonly string[]): boolean {
  const keys = (names: readonly string[]): string =>
    [...new Set(names.map(aliasKey).filter((key) => key !== ''))].sort().join('\n')
  return keys(a) === keys(b)
}

function requireSheet(db: EntityDb, id: string): Entity {
  const sheet = getEntity(db, id)
  if (sheet === undefined) throw new AppError('NOT_FOUND', 'Sheet not found', { id })
  return sheet
}

function requireTag(db: EntityDb, id: string): Tag {
  const held = getTagWithUsage(db, id)
  if (held === undefined) throw new AppError('NOT_FOUND', 'Tag not found', { id })
  return held
}

function requireNode(db: EntityDb, id: string): void {
  const row = db.select({ id: node.id }).from(node).where(eq(node.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'Scene not found', { id })
}

/** Whether the pair was taken off the scene (`removeDocumentTag` remembers it until relinked). */
function wasUnlinked(db: EntityDb, nodeId: string, tagId: string): boolean {
  return (
    db
      .select({ nodeId: documentTagDismissal.nodeId })
      .from(documentTagDismissal)
      .where(and(eq(documentTagDismissal.nodeId, nodeId), eq(documentTagDismissal.tagId, tagId)))
      .get() !== undefined
  )
}

/**
 * Whether an inverse only puts back what its change touched: every part `before` names is a part
 * `after` names, and so is every field, unless the change moved the sheet to another category
 * (its undo carries the old template's values back).
 */
function samePartsSheet(before: SheetPatch, after: SheetPatch): boolean {
  const parts = (['name', 'kind', 'body', 'aliases'] as const).every(
    (part) => before[part] === undefined || after[part] !== undefined
  )
  if (!parts || before.fields === undefined || after.kind !== undefined) return parts
  const changed = after.fields ?? {}
  return Object.keys(before.fields).every((field) => Object.hasOwn(changed, field))
}

function samePartsTag(before: TagPatch, after: TagPatch): boolean {
  return (['name', 'category', 'parentId', 'aliases'] as const).every(
    (part) => before[part] === undefined || after[part] !== undefined
  )
}

function hasLink(db: EntityDb, nodeId: string, tagId: string): boolean {
  return (
    db
      .select({ id: documentTag.id })
      .from(documentTag)
      .where(and(eq(documentTag.nodeId, nodeId), eq(documentTag.tagId, tagId)))
      .get() !== undefined
  )
}

/**
 * Checks one change the renderer applied (F-9.15) and turns it into a log row: its kind may carry
 * its inverse, everything the inverse names exists, and the change really landed (a restore's
 * `after` is what the record holds now; a scene's tag is on or off it as the change left it).
 */
function recordedInput(
  db: EntityDb,
  change: RecordChangesInput['changes'][number],
  made: { sheets: ReadonlySet<string>; tags: ReadonlySet<string> } | undefined
): ChangeInput {
  const { kind, label, undo } = change
  if (!RECORDED_UNDO_OF[kind].includes(undo.type)) {
    throw new AppError('VALIDATION', 'This change cannot be logged with that undo', {
      kind,
      undo: undo.type
    })
  }
  const base = { kind, label, quote: null, nodeId: null, undo }
  const landed = (ok: boolean): void => {
    if (!ok) throw new AppError('VALIDATION', 'The change is not in the story bible', { kind })
  }
  switch (undo.type) {
    case 'restoreSheet':
      landed(sheetMatches(requireSheet(db, undo.entityId), undo.after))
      landed(samePartsSheet(undo.before, undo.after))
      return { ...base, entityId: undo.entityId, targetId: undo.entityId }
    case 'deleteSheet': {
      const sheet = requireSheet(db, undo.entityId)
      // Only a sheet made this session, untouched since its stamp, with the tag it made itself.
      landed(made?.sheets.has(undo.entityId) === true)
      landed(undo.modified !== undefined && sheet.modified === undo.modified)
      landed(
        undo.tagId === null || (sheet.tagId === undo.tagId && made?.tags.has(undo.tagId) === true)
      )
      return { ...base, entityId: undo.entityId, targetId: undo.entityId }
    }
    case 'restoreTag':
      landed(tagMatches(requireTag(db, undo.tagId), undo.after))
      landed(samePartsTag(undo.before, undo.after))
      return { ...base, entityId: null, targetId: undo.tagId }
    case 'unlinkTag':
    case 'linkTag':
      requireNode(db, undo.nodeId)
      requireTag(db, undo.tagId)
      landed(hasLink(db, undo.nodeId, undo.tagId) === (undo.type === 'unlinkTag'))
      // A tag put back on a scene must have been taken off it.
      landed(undo.type === 'unlinkTag' || wasUnlinked(db, undo.nodeId, undo.tagId))
      return { ...base, nodeId: undo.nodeId, entityId: null, targetId: undo.tagId }
    case 'none':
      return { ...base, entityId: null, targetId: change.targetId ?? kind }
    case 'removeMadeTag': {
      // Only a tag made this session and untouched since its stamp.
      landed(made?.tags.has(undo.tagId) === true)
      landed(requireTag(db, undo.tagId).modified === undo.modified)
      return { ...base, entityId: null, targetId: undo.tagId }
    }
    case 'restoreStatus': {
      // F-5.25 (agent.v8): the sheet's own status for a record row, each fact's (of this sheet) for a fact row.
      const sheet = requireSheet(db, undo.entityId)
      landed((kind === 'record') === (undo.facts.length === 0))
      if (undo.facts.length === 0) landed(sheet.status === undo.after)
      for (const each of undo.facts) {
        const held = statusOfFact(db, each.id)
        landed(held?.entityId === undo.entityId && held.status === undo.after)
      }
      return { ...base, entityId: undo.entityId, targetId: undo.entityId }
    }
    default:
      throw new AppError('VALIDATION', 'This change cannot be logged with that undo', {
        kind,
        undo: undo.type
      })
  }
}

/** A fact's owner and status, or undefined for one that is gone. */
function statusOfFact(
  db: EntityDb,
  id: string
): { entityId: string; status: FactStatus; objectEntityId: string | null } | undefined {
  return db
    .select({ entityId: fact.entityId, status: fact.status, objectEntityId: fact.objectEntityId })
    .from(fact)
    .where(eq(fact.id, id))
    .get()
}

/**
 * Logs what the renderer applied through the stores (`changes:record`, F-9.15): Organise and the
 * chat agent's sheet and tag edits, one run per Organise plan or chat turn (`source:key`). Every
 * change is checked first (`recordedInput`), and one that fails refuses the whole call.
 */
export function recordChanges(db: EntityDb, input: RecordChangesInput, now: string): ChangeEntry[] {
  const made = createdHere.get(db)
  return db.transaction((tx) => {
    const inputs = input.changes.map((change) => recordedInput(tx, change, made))
    return insertChanges(tx, changeRunId(input.source, input.run), inputs, now).map(rowToEntry)
  })
}

/** Drops the oldest rows past `max`. */
export function pruneChanges(db: EntityDb, max: number): void {
  // F-5.25: an applied clear holds the only in-app copy of what it removed; it stays until undone.
  db.run(
    sql`DELETE FROM knowledge_change WHERE rowid IN (
      SELECT rowid FROM knowledge_change ORDER BY created_at DESC, rowid DESC LIMIT -1 OFFSET ${max}
    ) AND NOT (kind = 'clear' AND status = 'applied')`
  )
}

/**
 * The log's columns as a page reads them: a clear's inverse without its snapshot (F-5.25), cut
 * in SQL so a page never carries or parses the rows a clear keeps for its Undo.
 */
const LISTED_COLUMNS = {
  ...getTableColumns(knowledgeChange),
  undo: sql<string>`CASE WHEN ${knowledgeChange.kind} = 'clear' AND json_valid(${knowledgeChange.undo})
    THEN json_remove(${knowledgeChange.undo}, '$.snapshot') ELSE ${knowledgeChange.undo} END`
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
  // Rows this build cannot read are passed over (`readRow`), so a page reads on past them.
  const entries: ChangeEntry[] = []
  let after = cursor
  for (;;) {
    const from = after
    const rows = db
      .select({ row: LISTED_COLUMNS, rowid })
      .from(knowledgeChange)
      .where(
        from === undefined
          ? undefined
          : or(
              lt(knowledgeChange.createdAt, from.createdAt),
              and(eq(knowledgeChange.createdAt, from.createdAt), sql`rowid < ${from.rowid}`)
            )
      )
      .orderBy(desc(knowledgeChange.createdAt), desc(rowid))
      .limit(input.limit + 1)
      .all()
    for (const { row } of rows) {
      const read = readRow(row)
      if (read === null) continue
      if (entries.length === input.limit) return { entries, more: true }
      entries.push(toEntry(read))
    }
    const last = rows.at(-1)
    if (rows.length <= input.limit || last === undefined) return { entries, more: false }
    after = { createdAt: last.row.createdAt, rowid: last.rowid }
  }
}

/** What undoing accumulates, turned into `ChangeUndoResult` at the end. */
interface UndoTally {
  entries: ChangeEntry[]
  removedEntityIds: Set<string>
  removedTagIds: Set<string>
  entityIds: Set<string>
  nodeIds: Set<string>
  restoredEntityIds: Set<string>
  restoredTagIds: Set<string>
  removedImages: string[]
  restoredLibraryIds: Set<string>
  restoredNotesNodeIds: Set<string>
}

/**
 * What an undo did, for the handler: the result the windows get, plus (F-9.15) the sheets and
 * tags it put back and the pictures of the sheets it deleted, whose files the handler removes.
 */
export interface UndoOutcome extends ChangeUndoResult {
  restoredEntityIds: string[]
  restoredTagIds: string[]
  removedImages: string[]
  /** F-5.25: Library uploads and documents' notes a cleared run put back. */
  restoredLibraryIds: string[]
  restoredNotesNodeIds: string[]
}

/** Undoes one applied row inside the caller's transaction; a row already undone is left alone. */
function undoRow(db: EntityDb, { row, undo }: ReadRow, tally: UndoTally): void {
  if (row.status === 'undone') return
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
    case 'linkTag': {
      try {
        addDocumentTag(db, undo.nodeId, undo.tagId)
        tally.nodeIds.add(undo.nodeId)
      } catch (err) {
        // The scene or the tag is gone: there is nothing to put back.
        if (!(err instanceof AppError) || err.code !== 'NOT_FOUND') throw err
      }
      break
    }
    case 'restoreSheet': {
      const sheet = getEntity(db, undo.entityId)
      if (sheet === undefined) break
      if (!sheetMatches(sheet, undo.after)) {
        throw new AppError(
          'VALIDATION',
          `"${sheet.name}" has changed since, so this cannot be undone. Edit the sheet by hand.`,
          { id: row.id, entityId: undo.entityId }
        )
      }
      const written = updateEntity(db, undo.entityId, undo.before)
      tally.restoredEntityIds.add(undo.entityId)
      if (written.tagChange !== null) tally.restoredTagIds.add(written.tagChange.tag.id)
      break
    }
    case 'restoreStatus': {
      // F-5.25 (agent.v8): put back only while every target still reads as the chat left it.
      const sheet = getEntity(db, undo.entityId)
      if (sheet === undefined) break
      const facts = undo.facts.flatMap((each) => {
        const held = statusOfFact(db, each.id)
        return held === undefined ? [] : [{ ...each, held }]
      })
      const moved =
        undo.facts.length === 0
          ? sheet.status !== undo.after
          : facts.some((each) => each.held.status !== undo.after)
      if (moved) {
        throw new AppError(
          'VALIDATION',
          `The status on "${sheet.name}" has changed since, so this cannot be undone. Set it by hand.`,
          { id: row.id, entityId: undo.entityId }
        )
      }
      if (undo.facts.length === 0) {
        updateEntity(db, undo.entityId, { status: undo.before })
        tally.restoredEntityIds.add(undo.entityId)
        break
      }
      for (const each of facts) {
        setFactStatus(db, each.id, each.before)
        tally.entityIds.add(each.held.entityId)
        if (each.held.objectEntityId !== null) tally.entityIds.add(each.held.objectEntityId)
      }
      break
    }
    case 'restoreTag': {
      const held = getTagWithUsage(db, undo.tagId)
      if (held === undefined) break
      if (!tagMatches(held, undo.after)) {
        throw new AppError(
          'VALIDATION',
          `#${held.name} has changed since, so this cannot be undone. Edit the tag by hand.`,
          { id: row.id, tagId: undo.tagId }
        )
      }
      updateTag(db, undo.tagId, undo.before)
      tally.restoredTagIds.add(undo.tagId)
      break
    }
    case 'deleteSheet': {
      const sheet = getEntity(db, undo.entityId)
      if (sheet === undefined) break
      if (undo.modified !== undefined && sheet.modified !== undo.modified) {
        throw new AppError(
          'VALIDATION',
          `You have edited "${sheet.name}" since, so it is yours now. Delete it from its page if you no longer want it.`,
          { id: row.id, entityId: undo.entityId }
        )
      }
      deleteEntity(db, undo.entityId)
      if (sheet.image !== null) tally.removedImages.push(sheet.image)
      tally.removedEntityIds.add(undo.entityId)
      // The tag the sheet made goes with it, unless another sheet has taken it since.
      if (undo.tagId !== null && getTagWithUsage(db, undo.tagId) !== undefined) {
        const shared = db
          .select({ id: entity.id })
          .from(entity)
          .where(and(eq(entity.tagId, undo.tagId), ne(entity.id, undo.entityId)))
          .get()
        if (shared === undefined) {
          deleteTag(db, undo.tagId)
          tally.removedTagIds.add(undo.tagId)
        }
      }
      break
    }
    case 'none':
      throw new AppError('VALIDATION', undo.reason, { id: row.id })
    case 'removeMadeTag': {
      const held = getTagWithUsage(db, undo.tagId)
      if (held === undefined) break
      // The run's own links unwind first (rank 0); a link left is the author's use since.
      const used = db
        .select({ id: documentTag.id })
        .from(documentTag)
        .where(eq(documentTag.tagId, undo.tagId))
        .get()
      if (held.modified !== undo.modified || used !== undefined) {
        throw new AppError(
          'VALIDATION',
          `You have edited or used #${held.name} since, so it is yours now. Delete it from the tag bank if you no longer want it.`,
          { id: row.id, tagId: undo.tagId }
        )
      }
      deleteTag(db, undo.tagId)
      tally.removedTagIds.add(undo.tagId)
      break
    }
    case 'restoreCleared': {
      // F-5.25: everything a clear removed, back in this transaction (or refused whole).
      if (undo.snapshot === undefined) {
        throw new AppError('VALIDATION', 'This change cannot be undone', { id: row.id })
      }
      const restored = restoreCleared(db, undo.snapshot)
      for (const id of restored.entityIds) {
        tally.restoredEntityIds.add(id)
        tally.entityIds.add(id)
      }
      for (const id of restored.tagIds) tally.restoredTagIds.add(id)
      for (const id of restored.linkNodeIds) tally.nodeIds.add(id)
      for (const id of restored.libraryIds) tally.restoredLibraryIds.add(id)
      for (const id of restored.notesNodeIds) tally.restoredNotesNodeIds.add(id)
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

/**
 * The order a run is taken back in: what depends on a sheet or a tag first, the sheet and tag
 * last; F-9.15: edits of a sheet or a tag before the record that made it. Rows of one rank go
 * newest first (the caller's order), so two edits of one sheet unwind in turn.
 */
const UNDO_ORDER: Readonly<Record<ChangeKind, number>> = {
  tagLink: 0,
  fact: 1,
  sheetEdit: 1,
  tagEdit: 1,
  record: 2,
  tag: 3,
  merge: 4,
  delete: 4,
  category: 4,
  // F-5.25: a clear comes back last, once what the turn did after it (a tag made again with a
  // cleared name, scenes tagged with it) has unwound, so nothing it restores is taken already.
  clear: 5
}

function undoRows(db: EntityDb, rows: readonly ReadRow[]): UndoOutcome {
  const tally: UndoTally = {
    entries: [],
    removedEntityIds: new Set(),
    removedTagIds: new Set(),
    entityIds: new Set(),
    nodeIds: new Set(),
    restoredEntityIds: new Set(),
    restoredTagIds: new Set(),
    removedImages: [],
    restoredLibraryIds: new Set(),
    restoredNotesNodeIds: new Set()
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
    nodeIds: [...tally.nodeIds],
    restoredEntityIds: [...tally.restoredEntityIds].filter((id) => !tally.removedEntityIds.has(id)),
    restoredTagIds: [...tally.restoredTagIds].filter((id) => !tally.removedTagIds.has(id)),
    removedImages: tally.removedImages,
    restoredLibraryIds: [...tally.restoredLibraryIds],
    restoredNotesNodeIds: [...tally.restoredNotesNodeIds]
  }
}

/** Undoes one change (`changes:undo`); NOT_FOUND for an unknown id (pruned). */
export function undoChange(db: EntityDb, id: string): UndoOutcome {
  const row = db.select().from(knowledgeChange).where(eq(knowledgeChange.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'Change not found', { id })
  const read = readRow(row)
  if (read === null) throw new AppError('VALIDATION', 'This change cannot be undone', { id })
  return undoRows(db, [read])
}

/**
 * Undoes every applied change of one run (`changes:undoRun`), in one transaction: a change that
 * cannot be undone (a sheet or a tag the author has made theirs) refuses the whole run, so nothing is
 * half taken back. F-9.15: what the log lists but cannot take back (a merge, a deletion) is passed
 * over. NOT_FOUND for a run with no rows.
 */
export function undoRun(db: EntityDb, runId: string): UndoOutcome {
  const rows = db
    .select()
    .from(knowledgeChange)
    .where(eq(knowledgeChange.runId, runId))
    .orderBy(desc(knowledgeChange.createdAt), desc(sql`rowid`))
    .all()
  if (rows.length === 0) throw new AppError('NOT_FOUND', 'Run not found', { runId })
  // Passed over: what this build cannot read, and what the log cannot take back.
  return undoRows(
    db,
    rows.map(readRow).filter((read): read is ReadRow => read !== null && read.undo.type !== 'none')
  )
}
