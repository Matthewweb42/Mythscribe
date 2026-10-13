import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, like, ne, or, sql } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import { dismissedKey, rekeyFinding } from '@shared/memory/dismissed'
import type { InvariantAlias } from '@shared/memory/invariants'
import { gateWords, normName } from '@shared/memory/names'
import { rewriteWords } from '@shared/memory/renameEvidence'
import {
  isNamedKind,
  isTopicCategory,
  isTopicKind,
  SECRET_CATEGORY_ID,
  TOPIC_CATEGORY,
  uniqueTopicLabel,
  type TopicKind
} from '@shared/memory/topics'
import {
  defaultCaseRule,
  RECORD_ALIASES_MAX,
  recordKindOf,
  type AliasOrigin,
  type CaseRule,
  type RecordAlias,
  type RecordOrigin,
  type RecordPage,
  type StoryRecord,
  type StoryRecordSummary
} from '@shared/memory/records'
import { twinGate, type TwinGateResult, type TwinRosterRecord } from '@shared/memory/twinGate'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { sha256 } from '../ai/request'
import {
  alias,
  authorTodo,
  dismissed,
  nameMention,
  record,
  sceneDetail,
  type AliasRow,
  type RecordRow
} from '../db/schema'
import { hasCategory } from '../entity/categoryStore'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'
import { dismiss, dismissedKeys, forgetDismissed } from './dismissedStore'
import {
  deleteKnowsAbout,
  deleteThoughtsBy,
  emptyTopics,
  isTopicRecord,
  mergeEvidence,
  splitEvidence
} from './reading/recordEvidence'
import { markRosterForRebuild } from './reading/roster'

/**
 * Records and their names (F-16.4, story memory v2): the one writer of `record` and `alias`. A
 * record's names live only in `alias` (decision P1-D2): exactly one `is_main` (its name), the
 * rest nicknames; a norm belongs to one record unless every owner marks it shared (identity rule
 * 4), which `setAliases` and `addAlias` enforce and `aliasClash` checks. A new record runs the
 * twin gate first; the author's own is warned about (`force` to create it anyway), never
 * silently blocked (decision P1-D4).
 *
 * P2b: secrets and threads are records too (categories `secret` and `thread`, fixed: no record
 * moves into or out of them, P2b-D1), but their labels are not names (P2b-D2): the twin gate,
 * the name scan's roster and its hash read `NAMED_KINDS` only, and a label another record holds
 * gets " (secret)" / " (thread)" added rather than being refused; a name given later that takes a
 * label's norm makes the label yield the same way (`yieldTopicLabels`), so a label never blocks a
 * name and no norm is held twice (the `alias_norm_unshared_uq` index).
 */

export type BlockedGate = Extract<TwinGateResult, { outcome: 'blocked' }>

const toAlias = (row: AliasRow): RecordAlias => ({
  id: row.id,
  recordId: row.recordId,
  text: row.text,
  norm: row.norm,
  isMain: row.isMain,
  caseRule: row.caseRule,
  origin: row.origin,
  shared: row.shared,
  created: row.created
})

/** A stored page as Tiptap JSON; null for an empty or unreadable cell, never a throw. */
function parsePage(raw: string | null): TiptapNodeT | null {
  if (raw === null) return null
  try {
    const parsed = TiptapNode.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/** Every alias of these records, main first, then in the order they were added. */
function aliasesOf(db: TreeDb, recordIds?: readonly string[]): Map<string, RecordAlias[]> {
  const rows = db
    .select()
    .from(alias)
    .where(recordIds === undefined ? undefined : inArray(alias.recordId, [...recordIds]))
    .orderBy(asc(alias.recordId), sql`${alias.isMain} DESC`, asc(alias.created), sql`rowid`)
    .all()
  const byRecord = new Map<string, RecordAlias[]>()
  for (const row of rows) {
    byRecord.set(row.recordId, [...(byRecord.get(row.recordId) ?? []), toAlias(row)])
  }
  return byRecord
}

function toSummary(row: RecordRow, aliases: readonly RecordAlias[]): StoryRecordSummary {
  const main = aliases.find((entry) => entry.isMain)
  return {
    id: row.id,
    categoryId: row.categoryId,
    kind: recordKindOf(row.categoryId),
    name: main?.text ?? '',
    image: row.image,
    origin: row.origin,
    aliases: [...aliases],
    created: row.created,
    modified: row.modified
  }
}

/** Every record with its names, by name. */
export function listRecords(db: TreeDb): StoryRecordSummary[] {
  const byRecord = aliasesOf(db)
  return db
    .select()
    .from(record)
    .all()
    .map((row) => toSummary(row, byRecord.get(row.id) ?? []))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** One record with its pages, or null. */
export function getRecord(db: TreeDb, id: string): StoryRecord | null {
  const row = db.select().from(record).where(eq(record.id, id)).get()
  if (row === undefined) return null
  return {
    ...toSummary(row, aliasesOf(db, [id]).get(id) ?? []),
    pinned: parsePage(row.pinned),
    ideas: parsePage(row.ideas)
  }
}

export function requireRecord(db: TreeDb, id: string): StoryRecord {
  const found = getRecord(db, id)
  if (found === null) throw new AppError('NOT_FOUND', 'That record no longer exists', { id })
  return found
}

/**
 * The roster as the twin gate takes it: every named record's names, its own name first. Secrets
 * and threads are not names (P2b-D2): their labels never block a name, nor a name question.
 */
export function rosterOf(
  db: TreeDb,
  options: { withoutShared?: boolean } = {}
): TwinRosterRecord[] {
  const byRecord = aliasesOf(db)
  return db
    .select({ id: record.id, categoryId: record.categoryId })
    .from(record)
    .orderBy(asc(record.created), sql`rowid`)
    .all()
    .filter((row) => isNamedKind(recordKindOf(row.categoryId)))
    .map((row) => ({
      id: row.id,
      names: (byRecord.get(row.id) ?? [])
        .filter((entry) => !(options.withoutShared === true && entry.shared && !entry.isMain))
        .map((entry) => entry.text)
    }))
}

/**
 * Every secret's and thread's label (and any name a P1 thread kept): not names (P2b-D2), so the
 * name questions never ask about a span that is one, though the name scan never finds it.
 */
export function topicLabels(db: TreeDb): string[] {
  return db
    .select({ text: alias.text, categoryId: record.categoryId })
    .from(alias)
    .innerJoin(record, eq(record.id, alias.recordId))
    .all()
    .filter((row) => isTopicCategory(row.categoryId))
    .map((row) => row.text)
}

/** The names the gate blocks silently: every `name` dismissal's key. */
export function dismissedNames(db: TreeDb): string[] {
  return [...dismissedKeys(db, 'name')]
}

/** Runs the gate for a name being typed or proposed (`record:gate`). */
export function gateName(db: TreeDb, name: string, exceptId?: string): TwinGateResult {
  const roster = rosterOf(db).filter((entry) => entry.id !== exceptId)
  return twinGate(name, roster, dismissedNames(db))
}

/**
 * The hash of everything the name scan reads from the roster (named records, their kinds, every
 * name with its case rule and shared flag): a change makes every scene's scan stale. A secret's or
 * thread's label is not read (P2b-D2), so renaming one rescans nothing.
 */
export function rosterHash(db: TreeDb): string {
  const rows = db
    .select({
      recordId: alias.recordId,
      norm: alias.norm,
      text: alias.text,
      caseRule: alias.caseRule,
      shared: alias.shared,
      categoryId: record.categoryId
    })
    .from(alias)
    .innerJoin(record, eq(record.id, alias.recordId))
    .orderBy(asc(alias.recordId), asc(alias.norm))
    .all()
  return sha256(
    JSON.stringify(
      rows
        .filter((row) => isNamedKind(recordKindOf(row.categoryId)))
        .map((row) => [
          row.recordId,
          recordKindOf(row.categoryId),
          row.norm,
          row.text,
          row.caseRule,
          row.shared
        ])
    )
  )
}

/** Every alias as the memory invariants read them (`aliasClash`). */
export function invariantAliases(db: TreeDb): InvariantAlias[] {
  return db
    .select({ recordId: alias.recordId, norm: alias.norm, shared: alias.shared })
    .from(alias)
    .all()
}

/**
 * The display name of the record holding `norm` other than `recordId`, when that would clash. A
 * name given to a named record (`named`) never clashes with a secret's or thread's label: the label
 * yields instead (`yieldTopicLabels`; P2b-D2, a label never blocks a name), unless the switch-over
 * marked it shared. A topic's label clashes with every other name and label.
 */
function clashOwner(
  db: TreeDb,
  recordId: string | null,
  norm: string,
  shared: boolean,
  named: boolean
): string | null {
  const others = db
    .select({ recordId: alias.recordId, shared: alias.shared, categoryId: record.categoryId })
    .from(alias)
    .innerJoin(record, eq(record.id, alias.recordId))
    .where(
      recordId === null
        ? eq(alias.norm, norm)
        : and(eq(alias.norm, norm), ne(alias.recordId, recordId))
    )
    .all()
  const clash = others.find(
    (other) =>
      !(named && isTopicCategory(other.categoryId) && !other.shared) && !(shared && other.shared)
  )
  if (clash === undefined) return null
  return getRecord(db, clash.recordId)?.name ?? 'another record'
}

function refuseClash(
  db: TreeDb,
  recordId: string | null,
  text: string,
  shared: boolean,
  named: boolean
): void {
  const owner = clashOwner(db, recordId, normName(text), shared, named)
  if (owner !== null) {
    throw new AppError(
      'VALIDATION',
      `"${text}" is already a name of ${owner}. Mark it shared on both to let both records use it.`,
      { text, owner }
    )
  }
}

/**
 * P2b-D1, D2: a name given to a named record takes its norm from any secret or thread whose label
 * holds it. That label gets " (secret)" / " (thread)" added (`uniqueTopicLabel`), as a topic made
 * after the name would, so a label never blocks a name and no norm is held twice. `norms` are the
 * norms the write gives (taken for the new labels too). The caller holds the transaction and runs
 * this before writing the names. Answers the topics relabelled.
 */
function yieldTopicLabels(db: TreeDb, norms: readonly string[], now: Date): string[] {
  const giving = new Set(norms.filter((norm) => norm !== ''))
  if (giving.size === 0) return []
  // A label the switch-over marked shared with a name of the same words stays as it is.
  const labels = db
    .select({
      id: alias.id,
      recordId: alias.recordId,
      text: alias.text,
      shared: alias.shared,
      categoryId: record.categoryId
    })
    .from(alias)
    .innerJoin(record, eq(record.id, alias.recordId))
    .where(inArray(alias.norm, [...giving]))
    .all()
    .filter((row) => isTopicCategory(row.categoryId) && !row.shared)
  if (labels.length === 0) return []
  const held = takenNorms(db)
  const given = new Set(giving)
  const taken = (norm: string): boolean => held(norm) || given.has(norm)
  const relabeled: string[] = []
  for (const row of labels) {
    const kind = recordKindOf(row.categoryId)
    if (!isTopicKind(kind)) continue
    const text = uniqueTopicLabel(row.text, kind, null, taken)
    const norm = normName(text)
    given.add(norm)
    db.update(alias)
      .set({ text, norm, caseRule: defaultCaseRule(text) })
      .where(eq(alias.id, row.id))
      .run()
    db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, row.recordId)).run()
    if (!relabeled.includes(row.recordId)) relabeled.push(row.recordId)
  }
  return relabeled
}

/** Every secret's and thread's label by alias row (what `withTopicRelabels` compares). */
function topicLabelTexts(db: TreeDb): Map<string, { recordId: string; text: string }> {
  return new Map(
    db
      .select({
        id: alias.id,
        recordId: alias.recordId,
        text: alias.text,
        categoryId: record.categoryId
      })
      .from(alias)
      .innerJoin(record, eq(record.id, alias.recordId))
      .all()
      .filter((row) => isTopicCategory(row.categoryId))
      .map((row) => [row.id, { recordId: row.recordId, text: row.text }])
  )
}

/**
 * Runs a write that may give names (create, nicknames, a rename and its undo) and answers what it
 * answered with the secrets and threads whose label yielded to a name (`yieldTopicLabels`), so the
 * caller tells the windows about them too.
 */
export function withTopicRelabels<T>(
  db: TreeDb,
  write: () => T
): { result: T; relabeled: string[] } {
  const before = topicLabelTexts(db)
  const result = write()
  const relabeled = new Set<string>()
  for (const [id, after] of topicLabelTexts(db)) {
    if (before.get(id)?.text !== after.text) relabeled.add(after.recordId)
  }
  return { result, relabeled: [...relabeled] }
}

function requireCategoryId(db: TreeDb, categoryId: string): void {
  // P2b-D1: the v2-only Secrets category is built in for records, not a library category.
  if (categoryId === SECRET_CATEGORY_ID) return
  if (!hasCategory(db, categoryId)) {
    throw new AppError('VALIDATION', `There is no category "${categoryId}"`, { categoryId })
  }
}

export interface NewAlias {
  text: string
  caseRule?: CaseRule
  shared?: boolean
  origin?: AliasOrigin
}

/**
 * A name that becomes a record's leaves the `name` list of Dismissed ("Hesk: not a name" is
 * false once Hesk is a record), compared as the twin gate compares dismissed names.
 */
function forgetNotAName(db: TreeDb, text: string): void {
  const words = gateWords(text).join(' ')
  for (const key of dismissedKeys(db, 'name')) {
    if (gateWords(key).join(' ') === words) forgetDismissed(db, 'name', key)
  }
}

/**
 * Refuses a change that would leave `name` with more other names than a record keeps
 * (`RECORD_ALIASES_MAX`), so the full-list editor (`record:setAliases`) can always send them back.
 */
function requireAliasRoom(name: string, others: number): void {
  if (others <= RECORD_ALIASES_MAX) return
  throw new AppError(
    'VALIDATION',
    `${name} would have ${others} other names; a record keeps at most ${RECORD_ALIASES_MAX}. Remove some first.`,
    { others }
  )
}

const otherNames = (entries: readonly RecordAlias[]): number =>
  entries.filter((entry) => !entry.isMain).length

function insertAlias(
  db: TreeDb,
  recordId: string,
  entry: NewAlias & { isMain: boolean },
  now: Date
): void {
  const text = entry.text.normalize('NFC').trim().replace(/\s+/g, ' ')
  forgetNotAName(db, text)
  db.insert(alias)
    .values({
      id: randomUUID(),
      recordId,
      text,
      norm: normName(text),
      isMain: entry.isMain,
      caseRule: entry.caseRule ?? defaultCaseRule(text),
      origin: entry.origin ?? 'author',
      shared: entry.shared ?? false,
      created: now.toISOString()
    })
    .run()
}

export interface CreateRecordInput {
  name: string
  categoryId: string
  aliases?: readonly NewAlias[]
  origin?: RecordOrigin
  /** The author's own record: create it even when the gate warns (decision P1-D4). */
  force?: boolean
}

export type CreateRecordResult = { record: StoryRecord } | { gate: BlockedGate }

/**
 * Creates a record with its name (and any other names), after the twin gate. A blocked name
 * answers `{ gate }` and writes nothing, unless `force`; a name that is already another record's
 * unshared name is refused whatever `force` says (identity rule 4). A name made a record leaves
 * Dismissed's `name` list.
 */
export function createRecord(db: TreeDb, input: CreateRecordInput, now: Date): CreateRecordResult {
  requireCategoryId(db, input.categoryId)
  if (isTopicCategory(input.categoryId)) return createTopicRecord(db, input, now)
  const gate = gateName(db, input.name)
  if (gate.outcome === 'blocked' && input.force !== true) return { gate }
  const extra = input.aliases ?? []
  const norms = [input.name, ...extra.map((entry) => entry.text)].map(normName)
  if (norms.some((norm) => norm.length === 0)) {
    throw new AppError('VALIDATION', 'A name needs at least one letter or digit')
  }
  if (new Set(norms).size !== norms.length) {
    throw new AppError('VALIDATION', 'The same name is listed twice')
  }
  const id = randomUUID()
  db.transaction((tx) => {
    refuseClash(tx, null, input.name, false, true)
    for (const entry of extra) refuseClash(tx, null, entry.text, entry.shared ?? false, true)
    yieldTopicLabels(tx, norms, now)
    const at = now.toISOString()
    tx.insert(record)
      .values({
        id,
        categoryId: input.categoryId,
        image: null,
        origin: input.origin ?? 'author',
        pinned: null,
        ideas: null,
        legacyEntityId: null,
        legacyTagId: null,
        created: at,
        modified: at
      })
      .run()
    insertAlias(tx, id, { text: input.name, isMain: true }, now)
    for (const entry of extra) insertAlias(tx, id, { ...entry, isMain: false }, now)
  })
  return { record: requireRecord(db, id) }
}

/** The norm of every name and label any record holds (what a topic's label must not take). */
function takenNorms(db: TreeDb): (norm: string) => boolean {
  const held = new Set(
    db
      .select({ norm: alias.norm })
      .from(alias)
      .all()
      .map((row) => row.norm)
  )
  return (norm) => held.has(norm)
}

/**
 * Inserts a secret or thread with its label as its one name (P2b-D1): no twin gate (a label is not
 * a name, P2b-D2), and a label whose norm another record holds gets " (secret)" / " (thread)",
 * then the scene reference (`ref`, asked only when needed), added. Answers the new id and the
 * label it got. The caller holds the transaction.
 */
export function insertTopicRecord(
  db: TreeDb,
  input: { kind: TopicKind; label: string; origin: RecordOrigin; ref?: () => string | null },
  now: Date
): { id: string; label: string } {
  const label = input.label.normalize('NFC').trim().replace(/\s+/g, ' ')
  if (normName(label) === '') {
    throw new AppError('VALIDATION', 'A label needs at least one letter or digit')
  }
  const taken = takenNorms(db)
  const unique = taken(normName(label))
    ? uniqueTopicLabel(label, input.kind, input.ref?.() ?? null, taken)
    : label
  const id = randomUUID()
  const at = now.toISOString()
  db.insert(record)
    .values({
      id,
      categoryId: TOPIC_CATEGORY[input.kind],
      image: null,
      origin: input.origin,
      pinned: null,
      ideas: null,
      legacyEntityId: null,
      legacyTagId: null,
      created: at,
      modified: at
    })
    .run()
  db.insert(alias)
    .values({
      id: randomUUID(),
      recordId: id,
      text: unique,
      norm: normName(unique),
      isMain: true,
      caseRule: defaultCaseRule(unique),
      origin: input.origin === 'ai' ? 'ai' : 'author',
      shared: false,
      created: at
    })
    .run()
  return { id, label: unique }
}

/**
 * The author's *New secret* / *New thread* (P2b-D19): no twin gate. A label that is exactly
 * another secret's or thread's of the same kind is warned about (`force` to make it anyway, with
 * " (secret)" / " (thread)" added); one another kind of record holds gets that added silently.
 * Topics keep one name: other names are refused.
 */
function createTopicRecord(db: TreeDb, input: CreateRecordInput, now: Date): CreateRecordResult {
  const kind = recordKindOf(input.categoryId)
  if (!isTopicKind(kind)) throw new AppError('VALIDATION', 'Not a secret or thread category')
  if ((input.aliases ?? []).length > 0) {
    throw new AppError('VALIDATION', 'A secret or thread has one label and no other names')
  }
  const norm = normName(input.name)
  const twin = listRecords(db).find(
    (each) => each.kind === kind && each.aliases.some((entry) => entry.norm === norm)
  )
  if (twin !== undefined && input.force !== true) {
    return { gate: { outcome: 'blocked', rule: 'alias', recordId: twin.id, matched: twin.name } }
  }
  let id = ''
  db.transaction((tx) => {
    id = insertTopicRecord(
      tx,
      { kind, label: input.name, origin: input.origin ?? 'author' },
      now
    ).id
  })
  return { record: requireRecord(db, id) }
}

/**
 * Deletes the AI-made secrets and threads nothing backs any more (P2b-D12; `emptyTopics`): no
 * reveal and no claim in any draft, and nothing from the author. Answers their ids. Runs after a
 * reading, the anchors job and a record deleted.
 */
export function pruneTopics(db: TreeDb): string[] {
  const ids = emptyTopics(db)
  if (ids.length > 0) db.delete(record).where(inArray(record.id, ids)).run()
  return ids
}

/** A secret's or thread's stored rows (its record and its names): what *Not a secret* keeps. */
export function topicRecordRows(
  db: TreeDb,
  id: string
): { record: RecordRow; aliases: AliasRow[] } | null {
  const row = db.select().from(record).where(eq(record.id, id)).get()
  if (row === undefined || !isTopicCategory(row.categoryId)) return null
  return {
    record: row,
    aliases: db.select().from(alias).where(eq(alias.recordId, id)).orderBy(asc(alias.created)).all()
  }
}

/**
 * Puts back a secret or thread *Not a secret* / *Not a thread* took away, as it was stored
 * (P2b-D13, its *Undo*): its record and its label. A label another record took since gets
 * " (secret)" / " (thread)" added, as a topic made now would; another name whose norm is taken is
 * left out. Answers whether it was put back (false when the record is there already, or the rows
 * are no secret's or thread's). The caller holds the transaction.
 */
export function restoreTopicRecord(
  db: TreeDb,
  rows: { record: RecordRow; aliases: readonly AliasRow[] }
): boolean {
  const kind = recordKindOf(rows.record.categoryId)
  if (!isTopicKind(kind) || getRecord(db, rows.record.id) !== null) return false
  db.insert(record).values(rows.record).run()
  const taken = takenNorms(db)
  for (const row of rows.aliases) {
    if (!taken(row.norm)) {
      db.insert(alias).values(row).run()
      continue
    }
    if (!row.isMain) continue
    const text = uniqueTopicLabel(row.text, kind, null, taken)
    db.insert(alias)
      .values({ ...row, text, norm: normName(text), caseRule: defaultCaseRule(text) })
      .run()
  }
  return true
}

/** A record made from v1 or v0 data (F-16.15: the switch-over, and the v0 import in v2). */
export interface ConvertedRecordInput {
  name: string
  categoryId: string
  image: string | null
  /** Other names; `shared` where another converted record answers to the same norm. */
  aliases: readonly { text: string; shared: boolean }[]
  /** Whether the record's own name is shared with another record. */
  mainShared: boolean
  pinned: TiptapNodeT | null
  ideas: TiptapNodeT | null
  legacyEntityId: string | null
  legacyTagId: string | null
}

/**
 * Inserts a converted record with its names (origin `conversion`) and pages, without the twin
 * gate: the author's own sheets and tags become records as they are, and near twins go to the
 * switch-over's merge list instead. A name another record holds unshared is still refused
 * (identity rule 4), and a name that becomes a record leaves Dismissed's `name` list. Answers the
 * new id. The caller runs it inside its own transaction.
 */
export function insertConvertedRecord(db: TreeDb, input: ConvertedRecordInput, now: Date): string {
  requireCategoryId(db, input.categoryId)
  const id = randomUUID()
  const at = now.toISOString()
  const named = !isTopicCategory(input.categoryId)
  refuseClash(db, null, input.name, input.mainShared, named)
  for (const entry of input.aliases) refuseClash(db, null, entry.text, entry.shared, named)
  if (named) {
    yieldTopicLabels(
      db,
      [input.name, ...input.aliases.map((entry) => entry.text)].map(normName),
      now
    )
  }
  db.insert(record)
    .values({
      id,
      categoryId: input.categoryId,
      image: input.image,
      origin: 'conversion',
      pinned: isBlank(input.pinned) ? null : JSON.stringify(input.pinned),
      ideas: isBlank(input.ideas) ? null : JSON.stringify(input.ideas),
      legacyEntityId: input.legacyEntityId,
      legacyTagId: input.legacyTagId,
      created: at,
      modified: at
    })
    .run()
  insertAlias(
    db,
    id,
    { text: input.name, isMain: true, shared: input.mainShared, origin: 'conversion' },
    now
  )
  for (const entry of input.aliases) {
    insertAlias(
      db,
      id,
      { text: entry.text, isMain: false, shared: entry.shared, origin: 'conversion' },
      now
    )
  }
  return id
}

/**
 * Clears `shared` on converted names only one record holds any more (a merge took the other
 * holder away), so a name is shared only while two records answer to it.
 */
export function unshareLoneConvertedNames(db: TreeDb): number {
  const rows = db
    .select({ id: alias.id, norm: alias.norm })
    .from(alias)
    .where(and(eq(alias.shared, true), eq(alias.origin, 'conversion')))
    .all()
  let cleared = 0
  for (const row of rows) {
    const holders = db
      .select({ id: alias.id })
      .from(alias)
      .where(eq(alias.norm, row.norm))
      .all().length
    if (holders > 1) continue
    db.update(alias).set({ shared: false }).where(eq(alias.id, row.id)).run()
    cleared += 1
  }
  return cleared
}

/** Moves a record to another category (its kind follows) or changes its image file. */
export function updateRecord(
  db: TreeDb,
  id: string,
  patch: { categoryId?: string; image?: string | null },
  now: Date
): StoryRecord {
  const current = requireRecord(db, id)
  if (patch.categoryId !== undefined) {
    requireCategoryId(db, patch.categoryId)
    // P2b-D1: a secret's or thread's category is fixed, and nothing else moves into one.
    if (
      patch.categoryId !== current.categoryId &&
      (isTopicCategory(current.categoryId) || isTopicCategory(patch.categoryId))
    ) {
      throw new AppError('VALIDATION', 'Secrets and threads keep their own category')
    }
  }
  db.update(record)
    .set({
      ...(patch.categoryId === undefined ? {} : { categoryId: patch.categoryId }),
      ...(patch.image === undefined ? {} : { image: patch.image }),
      modified: now.toISOString()
    })
    .where(eq(record.id, id))
    .run()
  return requireRecord(db, id)
}

export interface AliasesInput {
  name: NewAlias
  aliases: readonly NewAlias[]
}

/**
 * Replaces a record's names: its name (`name`) and its other names, each with its case rule and
 * shared flag. Unchanged names keep their rows (and so their origin and date). A name another
 * record holds is refused with that record's name unless both mark it shared. A nickname the
 * author removes goes to Dismissed (`alias`), so it is never asked about again for this record;
 * one she adds back leaves Dismissed. A changed name is a rename, not a removal: the old name
 * leaves no Dismissed row.
 */
export function setAliases(db: TreeDb, id: string, input: AliasesInput, now: Date): StoryRecord {
  const current = requireRecord(db, id)
  // P2b (QUESTIONS 2026-10-12 #6): a secret or thread has one label; a P1 thread keeps the other
  // names it already had, and gains none.
  if (isTopicKind(current.kind)) {
    const had = new Set(current.aliases.map((entry) => entry.norm))
    if (input.aliases.some((entry) => !had.has(normName(entry.text)))) {
      throw new AppError('VALIDATION', 'A secret or thread has one label and no other names')
    }
  }
  const wanted = [
    { ...input.name, isMain: true },
    ...input.aliases.map((entry) => ({ ...entry, isMain: false }))
  ]
  const norms = wanted.map((entry) => normName(entry.text))
  if (norms.some((norm) => norm.length === 0)) {
    throw new AppError('VALIDATION', 'A name needs at least one letter or digit')
  }
  if (new Set(norms).size !== norms.length) {
    throw new AppError('VALIDATION', 'The same name is listed twice')
  }
  db.transaction((tx) => {
    const named = !isTopicKind(current.kind)
    for (const entry of wanted) refuseClash(tx, id, entry.text, entry.shared ?? false, named)
    if (named) yieldTopicLabels(tx, norms, now)
    const byNorm = new Map(current.aliases.map((entry) => [entry.norm, entry]))
    // The main flag moves first, so the one-main index never sees two.
    tx.update(alias).set({ isMain: false }).where(eq(alias.recordId, id)).run()
    wanted.forEach((entry, i) => {
      const norm = norms[i] ?? ''
      const text = entry.text.normalize('NFC').trim().replace(/\s+/g, ' ')
      const kept = byNorm.get(norm)
      if (kept === undefined) {
        insertAlias(tx, id, entry, now)
        forgetDismissed(tx, 'alias', dismissedKey({ kind: 'alias', recordId: id, alias: text }))
        return
      }
      tx.update(alias)
        .set({
          text,
          isMain: entry.isMain,
          caseRule: entry.caseRule ?? (kept.text === text ? kept.caseRule : defaultCaseRule(text)),
          shared: entry.shared ?? false
        })
        .where(eq(alias.id, kept.id))
        .run()
    })
    const removed = current.aliases.filter((entry) => !norms.includes(entry.norm))
    if (removed.length > 0) {
      tx.delete(alias)
        .where(
          inArray(
            alias.id,
            removed.map((entry) => entry.id)
          )
        )
        .run()
    }
    for (const entry of removed.filter((gone) => !gone.isMain)) {
      dismiss(
        tx,
        {
          kind: 'alias',
          key: dismissedKey({ kind: 'alias', recordId: id, alias: entry.text }),
          recordId: id,
          label: `"${entry.text}" is not ${input.name.text}`,
          quote: entry.text
        },
        now
      )
    }
    tx.update(record).set({ modified: now.toISOString() }).where(eq(record.id, id)).run()
  })
  return requireRecord(db, id)
}

/**
 * Adds one nickname (a Yes to a nickname question: origin `confirmed`). Refused when another
 * record holds it unshared, or when the record already keeps `RECORD_ALIASES_MAX` other names; a
 * name the record already has changes nothing.
 */
export function addAlias(db: TreeDb, id: string, entry: NewAlias, now: Date): StoryRecord {
  const current = requireRecord(db, id)
  const norm = normName(entry.text)
  if (norm.length === 0)
    throw new AppError('VALIDATION', 'A name needs at least one letter or digit')
  if (current.aliases.some((existing) => existing.norm === norm)) return current
  if (isTopicKind(current.kind)) {
    throw new AppError('VALIDATION', 'A secret or thread has one label and no other names')
  }
  requireAliasRoom(current.name, otherNames(current.aliases) + 1)
  db.transaction((tx) => {
    refuseClash(tx, id, entry.text, entry.shared ?? false, true)
    yieldTopicLabels(tx, [norm], now)
    insertAlias(tx, id, { ...entry, isMain: false }, now)
    forgetDismissed(tx, 'alias', dismissedKey({ kind: 'alias', recordId: id, alias: entry.text }))
    tx.update(record).set({ modified: now.toISOString() }).where(eq(record.id, id)).run()
  })
  return requireRecord(db, id)
}

/**
 * *Undo filing* (F-16.9): takes back a nickname filing added (origin `filed`, never a record's own
 * name), when the record still has it. Answers whether it was there.
 */
export function removeFiledAlias(db: TreeDb, recordId: string, norm: string, now: Date): boolean {
  const removed = db
    .delete(alias)
    .where(
      and(
        eq(alias.recordId, recordId),
        eq(alias.norm, norm),
        eq(alias.origin, 'filed'),
        eq(alias.isMain, false)
      )
    )
    .run()
  if (removed.changes === 0) return false
  db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, recordId)).run()
  return true
}

/** One name as Rename in book (F-16.13) changes it and its undo puts it back. */
export interface AliasText {
  text: string
  norm: string
  caseRule: CaseRule
}

/** One of a record's names, or NOT_FOUND when the record or that name is gone. */
export function requireAlias(db: TreeDb, recordId: string, aliasId: string): RecordAlias {
  const row = db
    .select()
    .from(alias)
    .where(and(eq(alias.id, aliasId), eq(alias.recordId, recordId)))
    .get()
  if (row === undefined) {
    requireRecord(db, recordId)
    throw new AppError('NOT_FOUND', "That name is no longer one of the record's", { aliasId })
  }
  return toAlias(row)
}

/**
 * The checks a rename of one of a record's names must pass, read only (Rename in book, F-16.13:
 * the preview runs them too, so the form says why before the click). Refused: a name with no
 * letter or digit, the name it already has, another of the record's names, another record's
 * unshared name, and a shared name another record also holds (the name scan cannot tell whose
 * each place is, so the prose cannot be rewritten for one of them). Answers the name and the new
 * text as stored.
 */
export function checkAliasRename(
  db: TreeDb,
  recordId: string,
  aliasId: string,
  to: string
): { current: RecordAlias; text: string; norm: string } {
  const current = requireAlias(db, recordId, aliasId)
  const text = to.normalize('NFC').trim().replace(/\s+/g, ' ')
  const norm = normName(text)
  if (norm.length === 0)
    throw new AppError('VALIDATION', 'A name needs at least one letter or digit')
  if (text === current.text) throw new AppError('VALIDATION', `"${text}" is already its name`)
  const owner = requireRecord(db, recordId)
  // P2b-D2: a secret's or thread's label is not a name in the book; it is renamed on its sheet.
  if (isTopicKind(owner.kind)) {
    throw new AppError(
      'VALIDATION',
      'A secret or thread is not named in the book: rename its label on its sheet'
    )
  }
  const siblings = owner.aliases.filter((entry) => entry.id !== aliasId)
  if (siblings.some((entry) => entry.norm === norm)) {
    throw new AppError('VALIDATION', `"${text}" is already another name of this record`, { text })
  }
  if (current.shared) {
    const other = db
      .select({ recordId: alias.recordId })
      .from(alias)
      .where(and(eq(alias.norm, current.norm), ne(alias.recordId, recordId)))
      .get()
    if (other !== undefined) {
      const owner = getRecord(db, other.recordId)?.name ?? 'another record'
      throw new AppError(
        'VALIDATION',
        `"${current.text}" is shared with ${owner}, so the book cannot tell whose it is everywhere. Rename a name only this record has.`,
        { text: current.text, owner }
      )
    }
  }
  refuseClash(db, recordId, text, current.shared, true)
  return { current, text, norm }
}

/**
 * Renames one of a record's names in place (Rename in book, F-16.13; the caller's transaction):
 * the row keeps its id, origin, shared flag and case rule (the case rule follows the new text
 * when it was the default for the old one). Refused as `checkAliasRename` says; a name made a
 * record's leaves Dismissed's `name` list and the record's own `alias` dismissal of it. Answers
 * the text before and after.
 */
export function renameAlias(
  db: TreeDb,
  recordId: string,
  aliasId: string,
  to: string,
  now: Date
): { before: AliasText; after: AliasText } {
  const { current, text, norm } = checkAliasRename(db, recordId, aliasId, to)
  const caseRule =
    current.caseRule === defaultCaseRule(current.text) ? defaultCaseRule(text) : current.caseRule
  forgetNotAName(db, text)
  forgetDismissed(db, 'alias', dismissedKey({ kind: 'alias', recordId, alias: text }))
  yieldTopicLabels(db, [norm], now)
  db.update(alias).set({ text, norm, caseRule }).where(eq(alias.id, aliasId)).run()
  db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, recordId)).run()
  // F-16.17: a renamed name rebuilds the reader's roster.
  markRosterForRebuild(db)
  return {
    before: { text: current.text, norm: current.norm, caseRule: current.caseRule },
    after: { text, norm, caseRule }
  }
}

/**
 * Puts a renamed name back (the rename's undo): only while the name still reads `expected` and
 * no other record has taken the old name unshared since. Answers whether it was put back.
 */
export function restoreAliasText(
  db: TreeDb,
  aliasId: string,
  expected: string,
  before: AliasText,
  now: Date
): boolean {
  const row = db.select().from(alias).where(eq(alias.id, aliasId)).get()
  if (row?.text !== expected) return false
  const named = !isTopicRecord(db, row.recordId)
  if (clashOwner(db, row.recordId, before.norm, row.shared, named) !== null) return false
  const sibling = db
    .select({ id: alias.id })
    .from(alias)
    .where(
      and(eq(alias.recordId, row.recordId), eq(alias.norm, before.norm), ne(alias.id, aliasId))
    )
    .get()
  if (sibling !== undefined) return false
  if (named) yieldTopicLabels(db, [before.norm], now)
  db.update(alias)
    .set({ text: before.text, norm: before.norm, caseRule: before.caseRule })
    .where(eq(alias.id, aliasId))
    .run()
  db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, row.recordId)).run()
  markRosterForRebuild(db)
  return true
}

/** An AI-made topic's label as Rename in book changed it, for its undo. */
export interface TopicLabelRename {
  aliasId: string
  before: AliasText
  after: AliasText
}

/**
 * Rename in book's rewrite of AI-made secrets' and threads' labels (P2b): a label the reader gave
 * that names the renamed person ("Ashby's return") follows the rename like the reveal's label
 * (`pairs`: each old spelling and its replacement, on word boundaries). The author's own labels
 * are hers and change only on their sheets; a label that would take another topic's is left as it
 * is. The caller holds the rename's transaction. Answers what the undo needs.
 */
export function renameInTopicLabels(
  db: TreeDb,
  pairs: readonly { text: string; replacement: string }[],
  now: Date
): TopicLabelRename[] {
  const edits = pairs.map((pair) => ({ start: 0, end: 0, ...pair }))
  const done: TopicLabelRename[] = []
  for (const topic of listRecords(db)) {
    if (!isTopicKind(topic.kind) || topic.origin !== 'ai') continue
    const main = topic.aliases.find((entry) => entry.isMain)
    if (main === undefined) continue
    const text = rewriteWords(main.text, edits)
    const norm = normName(text)
    if (text === main.text || norm === '') continue
    if (clashOwner(db, topic.id, norm, false, false) !== null) continue
    const after: AliasText = { text, norm, caseRule: defaultCaseRule(text) }
    db.update(alias).set(after).where(eq(alias.id, main.id)).run()
    db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, topic.id)).run()
    done.push({
      aliasId: main.id,
      before: { text: main.text, norm: main.norm, caseRule: main.caseRule },
      after
    })
  }
  return done
}

/** Puts renamed topic labels back (the rename's undo), each only while it still reads as left. */
export function restoreTopicLabels(
  db: TreeDb,
  renamed: readonly TopicLabelRename[],
  now: Date
): void {
  for (const each of renamed) restoreAliasText(db, each.aliasId, each.after.text, each.before, now)
}

/** Whether a page holds any text; an empty one is stored as null. */
function isBlank(doc: TiptapNodeT | null): boolean {
  return doc === null || docToText(doc).trim() === ''
}

/** Saves the record's Pinned or Ideas page (null or a page with no text clears it). */
export function savePage(
  db: TreeDb,
  id: string,
  page: RecordPage,
  doc: TiptapNodeT | null,
  now: Date
): StoryRecord {
  requireRecord(db, id)
  const value = isBlank(doc) ? null : JSON.stringify(doc)
  db.update(record)
    .set({
      ...(page === 'pinned' ? { pinned: value } : { ideas: value }),
      modified: now.toISOString()
    })
    .where(eq(record.id, id))
    .run()
  return requireRecord(db, id)
}

/**
 * Deletes a record; its names, mentions, dismissals and claims (F-16.17) go with it, and the
 * reader's roster is rebuilt. P2b: a secret takes the knows claims about it (their object would be
 * cleared, leaving orphans) and its reveals and knew-before rows (cascaded); any record takes the
 * knows thoughts it thought about someone else (`deleteThoughtsBy`); an AI-made topic left
 * with nothing behind it goes too (`pruneTopics`). Answers what it was and the topics pruned with
 * it (the caller tells the windows about both).
 */
export function deleteRecord(db: TreeDb, id: string): { record: StoryRecord; pruned: string[] } {
  const gone = requireRecord(db, id)
  let pruned: string[] = []
  db.transaction((tx) => {
    removeFromAlsoHere(tx, id, null)
    if (gone.kind === 'secret') deleteKnowsAbout(tx, id)
    deleteThoughtsBy(tx, id)
    tx.delete(record).where(eq(record.id, id)).run()
    pruned = pruneTopics(tx)
    // A topic is not in the roster's record lines: its own part follows by comparing (P2b-D10).
    if (!isTopicKind(gone.kind)) markRosterForRebuild(tx)
  })
  return { record: gone, pruned }
}

/** Replaces `from` with `to` (or drops it, when `to` is null) in every scene's "+ also here". */
function removeFromAlsoHere(db: TreeDb, from: string, to: string | null): void {
  const rows = db
    .select({ nodeId: sceneDetail.nodeId, alsoHere: sceneDetail.alsoHere })
    .from(sceneDetail)
    .where(like(sceneDetail.alsoHere, `%${from}%`))
    .all()
  for (const row of rows) {
    let ids: unknown
    try {
      ids = JSON.parse(row.alsoHere)
    } catch {
      continue
    }
    if (!Array.isArray(ids)) continue
    const next: string[] = []
    for (const value of ids) {
      if (typeof value !== 'string') continue
      const id = value === from ? to : value
      if (id !== null && !next.includes(id)) next.push(id)
    }
    db.update(sceneDetail)
      .set({ alsoHere: JSON.stringify(next) })
      .where(eq(sceneDetail.nodeId, row.nodeId))
      .run()
  }
}

/** Two pages as one: `a`'s blocks, then `b`'s. */
function appendPages(a: TiptapNodeT | null, b: TiptapNodeT | null): TiptapNodeT | null {
  if (isBlank(b)) return a
  if (isBlank(a) || a === null) return b
  return { ...a, content: [...(a.content ?? []), ...(b?.content ?? [])] }
}

/**
 * Rewrites the record id inside a dismissal key (`recordId|…`, or a sorted pair). A Not right key
 * (F-16.18) starts with its record too.
 */
function rekey(kind: string, key: string, from: string, to: string): string | null {
  if (kind === 'split' || kind === 'notSame') {
    const [a, b] = key.split('|')
    const pair = [a === from ? to : a, b === from ? to : b]
    if (pair[0] === pair[1]) return null
    return dismissedKey({ kind: 'notSame', a: pair[0] ?? '', b: pair[1] ?? '' })
  }
  let next = key
  if (
    (kind === 'alias' || kind === 'notMention' || kind === 'notRight') &&
    next.startsWith(`${from}|`)
  ) {
    next = `${to}${next.slice(from.length)}`
  }
  // P2b-D6: a knows line's key names its secret in the slot (`knows:<secretId>`), a thread step's
  // its thread (`thread:<threadId>`).
  if (kind === 'notRight') {
    next = next
      .replace(`|knows:${from}|`, `|knows:${to}|`)
      .replace(`|thread:${from}|`, `|thread:${to}|`)
  }
  // P4-D14: a finding's Not a problem key names its record, a kinship or knows slot's record and a
  // note owner; a loose end's names its thread or character.
  if (kind === 'notProblem') {
    const finding = rekeyFinding(next, from, to)
    if (finding !== null) return finding
    const loose = /^loose\|(thread|character)\|([^|]*)\|/u.exec(next)
    if (loose?.[2] === from) next = `loose|${loose[1] ?? ''}|${to}|${next.slice(loose[0].length)}`
  }
  return next
}

export interface SameAsResult {
  record: StoryRecord
  /** The merged record's image file, when the kept record had one of its own: the caller removes it. */
  droppedImage: string | null
}

/**
 * *Same as…*: merges `mergeId` into `keepId` in one transaction. The merged record's names
 * become nicknames of the kept one (a name it already has is dropped), its Pinned and Ideas are
 * appended, and every row that pointed at it now points at the kept record: mentions, scene
 * details ("+ also here" too), to-dos, dismissals (their keys rewritten; a split or not-same
 * between the two goes) and, F-16.17, the reading's claims, cards and back-fill rows
 * (`mergeEvidence`), with the reader's roster marked for a rebuild. The merged record is then
 * deleted. Refused when the kept record would end with more than `RECORD_ALIASES_MAX` other names.
 * P2b: the knows claims' sources, the knew-before marks and the topics' reveals follow too, and a
 * knows line's Not right key names the kept secret; a topic merges only with its own kind, keeps
 * its one label, and takes the merged topic's defining reveal as a `merged` one (*Split* undoes it).
 */
export function sameAs(db: TreeDb, keepId: string, mergeId: string, now: Date): SameAsResult {
  if (keepId === mergeId) throw new AppError('VALIDATION', 'A record cannot be merged into itself')
  const keep = requireRecord(db, keepId)
  const merge = requireRecord(db, mergeId)
  // P2b: two secrets or two threads merge (the author's merge, no reveal tagged); a topic never
  // merges with a name or with the other kind of topic.
  if ((isTopicKind(keep.kind) || isTopicKind(merge.kind)) && keep.kind !== merge.kind) {
    throw new AppError('VALIDATION', 'Only two secrets, or two threads, can be the same')
  }
  // A topic keeps its one label (QUESTIONS 2026-10-12 #6): the merged label lives on as the label
  // of its reveal, now a `merged` one, and goes with the merged record.
  const topics = isTopicKind(keep.kind)
  const have = new Set(keep.aliases.map((entry) => entry.norm))
  if (!topics) {
    requireAliasRoom(
      keep.name,
      otherNames(keep.aliases) + merge.aliases.filter((entry) => !have.has(entry.norm)).length
    )
  }
  let droppedImage: string | null = null
  db.transaction((tx) => {
    for (const entry of topics ? [] : merge.aliases) {
      if (have.has(entry.norm)) continue
      tx.update(alias).set({ recordId: keepId, isMain: false }).where(eq(alias.id, entry.id)).run()
    }
    const image = keep.image ?? merge.image
    droppedImage = keep.image !== null && merge.image !== null ? merge.image : null
    const pinned = appendPages(keep.pinned, merge.pinned)
    const ideas = appendPages(keep.ideas, merge.ideas)
    tx.update(record)
      .set({
        image,
        pinned: pinned === null ? null : JSON.stringify(pinned),
        ideas: ideas === null ? null : JSON.stringify(ideas),
        modified: now.toISOString()
      })
      .where(eq(record.id, keepId))
      .run()
    // Mentions: a span both records were candidates for keeps the kept record's row.
    tx.run(
      sql`DELETE FROM name_mention WHERE record_id = ${mergeId} AND EXISTS (
            SELECT 1 FROM name_mention AS kept
            WHERE kept.record_id = ${keepId} AND kept.node_id = name_mention.node_id
              AND kept.span_key = name_mention.span_key)`
    )
    tx.update(nameMention).set({ recordId: keepId }).where(eq(nameMention.recordId, mergeId)).run()
    tx.update(sceneDetail)
      .set({ povRecordId: keepId })
      .where(eq(sceneDetail.povRecordId, mergeId))
      .run()
    tx.update(sceneDetail)
      .set({ placeRecordId: keepId })
      .where(eq(sceneDetail.placeRecordId, mergeId))
      .run()
    removeFromAlsoHere(tx, mergeId, keepId)
    tx.update(authorTodo).set({ recordId: keepId }).where(eq(authorTodo.recordId, mergeId)).run()
    mergeEvidence(tx, keepId, mergeId, { topics })
    if (!topics) markRosterForRebuild(tx)
    const tombstones = tx
      .select()
      .from(dismissed)
      .where(or(eq(dismissed.recordId, mergeId), like(dismissed.key, `%${mergeId}%`)))
      .all()
    for (const row of tombstones) {
      const key = rekey(row.kind, row.key, mergeId, keepId)
      const taken =
        key !== null &&
        key !== row.key &&
        tx
          .select({ id: dismissed.id })
          .from(dismissed)
          .where(and(eq(dismissed.kind, row.kind), eq(dismissed.key, key)))
          .get() !== undefined
      if (key === null || taken) {
        tx.delete(dismissed).where(eq(dismissed.id, row.id)).run()
        continue
      }
      tx.update(dismissed)
        .set({ key, recordId: row.recordId === mergeId ? keepId : row.recordId })
        .where(eq(dismissed.id, row.id))
        .run()
    }
    tx.delete(record).where(eq(record.id, mergeId)).run()
  })
  return { record: requireRecord(db, keepId), droppedImage }
}

export interface SplitResult {
  from: StoryRecord
  into: StoryRecord
}

/**
 * *Split*: moves some of a record's nicknames to a new record (in the same category, named by the
 * first moved name) or to an existing one, and writes a `split` dismissal so the two are never
 * proposed as the same again. The record keeps its own name, Pinned and Ideas; a name `into`
 * already has is dropped. The author's explicit act: no twin gate. F-16.17: the claims whose
 * subject a moved name pinned move with it (`splitEvidence`; pronoun claims stay), and the
 * reader's roster is marked for a rebuild.
 */
export function splitRecord(
  db: TreeDb,
  id: string,
  aliasIds: readonly string[],
  intoId: string | null,
  now: Date
): SplitResult {
  const from = requireRecord(db, id)
  // P2b: a secret or thread splits by reveal (`splitTopic`), never by names.
  if (isTopicKind(from.kind)) {
    throw new AppError('VALIDATION', 'A secret or thread splits by its reveals, not by names')
  }
  if (aliasIds.length === 0) throw new AppError('VALIDATION', 'Pick at least one name to move')
  const moving = from.aliases.filter((entry) => aliasIds.includes(entry.id))
  if (moving.length !== aliasIds.length) {
    throw new AppError('VALIDATION', 'Those names are not all names of this record', { aliasIds })
  }
  if (moving.some((entry) => entry.isMain)) {
    throw new AppError('VALIDATION', 'A record keeps its own name; rename it instead')
  }
  if (intoId === id) throw new AppError('VALIDATION', 'Pick another record to move the names to')
  const into = intoId === null ? null : requireRecord(db, intoId)
  if (into !== null) {
    const have = new Set(into.aliases.map((entry) => entry.norm))
    requireAliasRoom(
      into.name,
      otherNames(into.aliases) + moving.filter((entry) => !have.has(entry.norm)).length
    )
  }
  let target = intoId ?? ''
  db.transaction((tx) => {
    if (into === null) {
      const [first] = moving
      if (first === undefined) return
      target = randomUUID()
      const at = now.toISOString()
      tx.insert(record)
        .values({
          id: target,
          categoryId: from.categoryId,
          image: null,
          origin: 'author',
          pinned: null,
          ideas: null,
          legacyEntityId: null,
          legacyTagId: null,
          created: at,
          modified: at
        })
        .run()
      tx.update(alias).set({ recordId: target, isMain: true }).where(eq(alias.id, first.id)).run()
      for (const entry of moving.slice(1)) {
        tx.update(alias).set({ recordId: target }).where(eq(alias.id, entry.id)).run()
      }
    } else {
      const have = new Set(into.aliases.map((entry) => entry.norm))
      for (const entry of moving) {
        if (have.has(entry.norm)) tx.delete(alias).where(eq(alias.id, entry.id)).run()
        else tx.update(alias).set({ recordId: target }).where(eq(alias.id, entry.id)).run()
      }
      tx.update(record).set({ modified: now.toISOString() }).where(eq(record.id, target)).run()
    }
    tx.update(record).set({ modified: now.toISOString() }).where(eq(record.id, id)).run()
    splitEvidence(
      tx,
      id,
      target,
      moving.map((entry) => entry.norm),
      from.aliases.filter((entry) => !aliasIds.includes(entry.id)).map((entry) => entry.norm)
    )
    markRosterForRebuild(tx)
    const intoName = into?.name ?? moving[0]?.text ?? ''
    dismiss(
      tx,
      {
        kind: 'split',
        key: dismissedKey({ kind: 'split', a: id, b: target }),
        recordId: id,
        label: `${from.name} and ${intoName} are different`,
        quote: moving.map((entry) => entry.text).join(', ')
      },
      now
    )
  })
  return { from: requireRecord(db, id), into: requireRecord(db, target) }
}
