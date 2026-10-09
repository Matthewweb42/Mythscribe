import { randomUUID } from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import { categoryFieldLabel, categoryOf, type StoryCategory } from '@shared/categories'
import type { ContinuityFinding } from '@shared/continuity'
import type { Entity } from '@shared/ipc/contract'
import { SCENE_BRIEF_FIELDS } from '@shared/sceneMeta'
import {
  TODO_KINDS,
  continuityFindingIdOf,
  continuityTodoId,
  parseTodoSuggestions,
  parseTodoTarget,
  todoCounts,
  type TodoItem,
  type TodoStatus,
  type TodoTarget,
  type TodoView
} from '@shared/todo'
import { toTagName } from '@shared/tags'
import { node, todoItem, type TodoItemRow } from '../db/schema'
import { settleContinuityFinding } from '../ai/continuity'
import { listOpenFindings } from '../ai/continuityFindingStore'
import { listCategories } from '../entity/categoryStore'
import { listEntities } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { getDismissedNames, setDismissedNames } from '../project/settingsStore'
import { dismissName } from '../tag/proposedTags'
import type { TreeDb } from '../tree/treeStore'
import { manuscriptDocuments } from '../voice/profile'
import { localTodoCandidates, type TodoCandidate } from './todoLocal'

/**
 * The To do list's store (F-9.16): the one writer of `todo_item`. A sync upserts the open items
 * the local rules find and deletes the open local items whose condition is gone; it never touches
 * a `done` or `dismissed` row (the tombstones) and never anything outside this table. The list
 * adds the open contradictions of the consistency checker, read live from `continuity_finding`
 * and never copied (one owner per tombstone).
 */

/** What a sync did. */
export interface TodoSyncResult {
  changed: boolean
}

const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/** Whether a stored row still says what the candidate says (so an unchanged sync writes nothing). */
function matches(row: TodoItemRow, found: TodoCandidate): boolean {
  return (
    row.kind === found.kind &&
    row.subject === found.subject &&
    row.entityId === found.entityId &&
    row.nodeId === found.nodeId &&
    row.quote === found.quote &&
    row.why === found.why &&
    sameJson(parseTodoTarget(row.target), found.target)
  )
}

/** Whether an AI item's target is gone or already answered (the field or page has text now). */
function targetSettled(target: TodoTarget, entities: ReadonlyMap<string, Entity>): boolean {
  if (target.kind === 'field') {
    const entity = entities.get(target.entityId)
    return entity === undefined || (entity.fields[target.field] ?? '').trim() !== ''
  }
  if (target.kind === 'page') {
    const entity = entities.get(target.entityId)
    return entity === undefined || (entity.body ?? '').trim() !== ''
  }
  return false
}

/**
 * Brings the open local items up to date with what the rules find now, in one transaction:
 * new keys are inserted open, open rows whose words moved are updated (their suggestions kept),
 * open local rows no rule finds any more are deleted, and so are open items whose scene or record
 * was deleted or whose target field the author has since filled. Settled rows stay as they are.
 */
export function syncLocalTodo(db: TreeDb, now: Date = new Date()): TodoSyncResult {
  const candidates = localTodoCandidates(db)
  const entities = new Map(listEntities(db).map((entity) => [entity.id, entity]))
  const at = now.toISOString()
  return db.transaction((tx) => {
    const rows = tx.select().from(todoItem).all()
    const byKey = new Map(rows.map((row) => [row.key, row]))
    const found = new Set(candidates.map((each) => each.key))
    let changed = false
    const gone: string[] = []
    for (const row of rows) {
      if (row.status !== 'open') continue
      if (row.source === 'local' && !found.has(row.key)) {
        gone.push(row.id)
        continue
      }
      if (row.source !== 'ai') continue
      const target = parseTodoTarget(row.target)
      if (row.nodeId === null || targetSettled(target, entities)) gone.push(row.id)
    }
    if (gone.length > 0) {
      tx.delete(todoItem).where(inArray(todoItem.id, gone)).run()
      changed = true
    }
    for (const each of candidates) {
      const row = byKey.get(each.key)
      if (row === undefined) {
        tx.insert(todoItem)
          .values({
            id: randomUUID(),
            key: each.key,
            kind: each.kind,
            rule: each.rule,
            source: 'local',
            subject: each.subject,
            entityId: each.entityId,
            nodeId: each.nodeId,
            quote: each.quote,
            why: each.why,
            target: JSON.stringify(each.target),
            suggestions: JSON.stringify(each.suggestions),
            suggestedAt: each.suggestions.length > 0 ? at : null,
            status: 'open',
            createdAt: at,
            updatedAt: at
          })
          .run()
        changed = true
        continue
      }
      if (row.status !== 'open' || row.source !== 'local' || matches(row, each)) continue
      tx.update(todoItem)
        .set({
          kind: each.kind,
          subject: each.subject,
          entityId: each.entityId,
          nodeId: each.nodeId,
          quote: each.quote,
          why: each.why,
          target: JSON.stringify(each.target),
          updatedAt: at
        })
        .where(eq(todoItem.id, row.id))
        .run()
      changed = true
    }
    return { changed }
  })
}

/** Labels for the targets: record names, scene titles, field labels. */
interface Names {
  entities: ReadonlyMap<string, Entity>
  titles: ReadonlyMap<string, string>
  categories: readonly StoryCategory[]
}

function readNames(db: TreeDb): Names {
  return {
    entities: new Map(listEntities(db).map((entity) => [entity.id, entity])),
    titles: new Map(
      db
        .select({ id: node.id, title: node.title })
        .from(node)
        .all()
        .map((row) => [row.id, row.title])
    ),
    categories: listCategories(db)
  }
}

/** Where Add writes, in words: "Mara › Goals / motivations", "Scene 12's notes". */
export function todoTargetLabel(target: TodoTarget, names: Names): string {
  switch (target.kind) {
    case 'field': {
      const entity = names.entities.get(target.entityId)
      if (entity === undefined) return ''
      const label = categoryFieldLabel(categoryOf(entity.kind, names.categories), target.field)
      return `${entity.name} › ${label}`
    }
    case 'page': {
      const entity = names.entities.get(target.entityId)
      return entity === undefined ? '' : `${entity.name}'s page`
    }
    case 'notes':
      return `${names.titles.get(target.nodeId) ?? 'The scene'}'s notes`
    case 'brief': {
      const field = SCENE_BRIEF_FIELDS.find((each) => each.key === target.field)
      return `${names.titles.get(target.nodeId) ?? 'The scene'}'s brief › ${field?.label ?? target.field}`
    }
    case 'newRecord':
      return `New ${categoryOf(target.category, names.categories).noun}: ${target.name}`
    case 'none':
      return ''
  }
}

function rowToItem(row: TodoItemRow, names: Names): TodoItem {
  const target = parseTodoTarget(row.target)
  return {
    id: row.id,
    kind: row.kind,
    rule: row.rule,
    source: row.source,
    subject: row.subject,
    entityId: row.entityId,
    nodeId: row.nodeId,
    quote: row.quote,
    why: row.why,
    target,
    targetLabel: todoTargetLabel(target, names),
    suggestions: parseTodoSuggestions(row.suggestions),
    suggested: row.suggestedAt !== null,
    status: row.status,
    createdAt: row.createdAt
  }
}

/** A contradiction of the consistency checker as a To do item (`c:<findingId>`); never stored here. */
function findingToItem(finding: ContinuityFinding, names: Names): TodoItem {
  const { ref } = finding
  const entity = ref.entityId === null ? undefined : names.entities.get(ref.entityId)
  const field =
    entity !== undefined &&
    ref.kind !== 'timeline' &&
    ref.attribute !== null &&
    categoryOf(entity.kind, names.categories).fields.some((each) => each.id === ref.attribute)
      ? ref.attribute
      : null
  const target: TodoTarget =
    entity === undefined || field === null
      ? { kind: 'none' }
      : { kind: 'field', entityId: entity.id, field }
  return {
    id: continuityTodoId(finding.id),
    kind: 'contradiction',
    rule: 'continuity',
    source: 'local',
    subject: ref.entityName ?? ref.label,
    entityId: ref.entityId,
    nodeId: finding.nodeId,
    quote: finding.quote,
    why: finding.why,
    target,
    targetLabel: todoTargetLabel(target, names),
    suggestions: [],
    suggested: true,
    status: 'open',
    createdAt: finding.createdAt
  }
}

/**
 * What `todo:list` answers: the open items of the table and the open findings of the consistency
 * checker, grouped by kind (`TODO_KINDS` order), in reading order of their scenes within a kind
 * (an item with no scene last), then by subject.
 */
export function listTodo(db: TreeDb): TodoView {
  const names = readNames(db)
  const position = new Map(manuscriptDocuments(db).map((row, at) => [row.id, at]))
  const at = (nodeId: string | null): number =>
    nodeId === null ? Number.MAX_SAFE_INTEGER : (position.get(nodeId) ?? position.size)
  const kindAt = (item: TodoItem): number => TODO_KINDS.indexOf(item.kind)
  const items = [
    ...db
      .select()
      .from(todoItem)
      .where(eq(todoItem.status, 'open'))
      .all()
      .map((row) => rowToItem(row, names)),
    ...listOpenFindings(db).map((finding) => findingToItem(finding, names))
  ].sort(
    (a, b) =>
      kindAt(a) - kindAt(b) ||
      at(a.nodeId) - at(b.nodeId) ||
      a.subject.localeCompare(b.subject) ||
      a.id.localeCompare(b.id)
  )
  return { items, counts: todoCounts(items) }
}

/** One stored item by id, any status; NOT_FOUND for an unknown id. */
export function getTodoRow(db: TreeDb, id: string): TodoItemRow {
  const row = db.select().from(todoItem).where(eq(todoItem.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'That To do item is gone', { id })
  return row
}

/** What settling an item touched, so the handler tells the right windows. */
export interface TodoSettleResult {
  /** The scene of a settled contradiction (its finding was dismissed); null otherwise. */
  continuityNodeId: string | null
  /** Whether the dismissed names of the proposed tags (F-4.12b) moved. */
  namesChanged: boolean
}

/**
 * Done ("handled") or Dismiss ("not a problem"): both are tombstones, so the item never returns.
 * A contradiction of the consistency checker is settled there, as `dismissed` (its own
 * tombstone). Dismissing an untagged name also dismisses it in the Tags panel's proposals
 * (`dismissName`), so the two share one tombstone. NOT_FOUND for an unknown or settled item.
 */
export function settleTodo(
  db: TreeDb,
  id: string,
  status: Exclude<TodoStatus, 'open'>
): TodoSettleResult {
  const findingId = continuityFindingIdOf(id)
  if (findingId !== null) {
    const { finding } = settleContinuityFinding(db, findingId, 'dismissed')
    return { continuityNodeId: finding.nodeId, namesChanged: false }
  }
  return db.transaction((tx) => {
    const updated = tx
      .update(todoItem)
      .set({ status, updatedAt: new Date().toISOString() })
      .where(and(eq(todoItem.id, id), eq(todoItem.status, 'open')))
      .returning()
      .get()
    if (updated === undefined) throw new AppError('NOT_FOUND', 'That To do item is gone', { id })
    if (updated.rule === 'unknownName' && status === 'dismissed') {
      dismissName(tx, nameOfKey(updated.key))
      return { continuityNodeId: null, namesChanged: true }
    }
    return { continuityNodeId: null, namesChanged: false }
  })
}

/** The kebab-cased name an `unknownName` key holds. */
function nameOfKey(key: string): string {
  return key.slice(key.indexOf(':') + 1)
}

/**
 * Undo of a Done or a Dismiss: the item is open again. A dismissed untagged name leaves the Tags
 * panel's dismissals too. VALIDATION for a contradiction of the consistency checker (its
 * dismissal is final there); NOT_FOUND for an unknown id. Answers whether the names moved.
 */
export function reopenTodo(db: TreeDb, id: string): TodoSettleResult {
  if (continuityFindingIdOf(id) !== null) {
    throw new AppError('VALIDATION', 'A dismissed contradiction cannot be reopened', { id })
  }
  return db.transaction((tx) => {
    const row = getTodoRow(tx, id)
    if (row.status === 'open') return { continuityNodeId: null, namesChanged: false }
    tx.update(todoItem)
      .set({ status: 'open', updatedAt: new Date().toISOString() })
      .where(eq(todoItem.id, id))
      .run()
    if (row.rule !== 'unknownName' || row.status !== 'dismissed') {
      return { continuityNodeId: null, namesChanged: false }
    }
    const name = toTagName(nameOfKey(row.key))
    const stored = getDismissedNames(tx)
    if (!stored.names.includes(name)) return { continuityNodeId: null, namesChanged: false }
    setDismissedNames(tx, { names: stored.names.filter((each) => each !== name) })
    return { continuityNodeId: null, namesChanged: true }
  })
}
