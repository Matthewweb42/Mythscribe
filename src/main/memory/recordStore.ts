import { randomUUID } from 'node:crypto'
import { and, asc, eq, inArray, like, ne, or, sql } from 'drizzle-orm'
import { docToText } from '@shared/docText'
import { dismissedKey } from '@shared/memory/dismissed'
import type { InvariantAlias } from '@shared/memory/invariants'
import { gateWords, normName } from '@shared/memory/names'
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

/**
 * Records and their names (F-16.4, story memory v2): the one writer of `record` and `alias`. A
 * record's names live only in `alias` (decision P1-D2): exactly one `is_main` (its name), the
 * rest nicknames; a norm belongs to one record unless every owner marks it shared (identity rule
 * 4), which `setAliases` and `addAlias` enforce and `aliasClash` checks. A new record runs the
 * twin gate first; the author's own is warned about (`force` to create it anyway), never
 * silently blocked (decision P1-D4).
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

/** The roster as the twin gate takes it: every record's names, its own name first. */
export function rosterOf(
  db: TreeDb,
  options: { withoutShared?: boolean } = {}
): TwinRosterRecord[] {
  const byRecord = aliasesOf(db)
  return db
    .select({ id: record.id })
    .from(record)
    .orderBy(asc(record.created), sql`rowid`)
    .all()
    .map((row) => ({
      id: row.id,
      names: (byRecord.get(row.id) ?? [])
        .filter((entry) => !(options.withoutShared === true && entry.shared && !entry.isMain))
        .map((entry) => entry.text)
    }))
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
 * The hash of everything the name scan reads from the roster (records, their kinds, every name
 * with its case rule and shared flag): a change makes every scene's scan stale.
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
      rows.map((row) => [
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

/** The display name of the record holding `norm` other than `recordId`, when that would clash. */
function clashOwner(
  db: TreeDb,
  recordId: string | null,
  norm: string,
  shared: boolean
): string | null {
  const others = db
    .select({ recordId: alias.recordId, shared: alias.shared })
    .from(alias)
    .where(
      recordId === null
        ? eq(alias.norm, norm)
        : and(eq(alias.norm, norm), ne(alias.recordId, recordId))
    )
    .all()
  const clash = others.find((other) => !(shared && other.shared))
  if (clash === undefined) return null
  return getRecord(db, clash.recordId)?.name ?? 'another record'
}

function refuseClash(db: TreeDb, recordId: string | null, text: string, shared: boolean): void {
  const owner = clashOwner(db, recordId, normName(text), shared)
  if (owner !== null) {
    throw new AppError(
      'VALIDATION',
      `"${text}" is already a name of ${owner}. Mark it shared on both to let both records use it.`,
      { text, owner }
    )
  }
}

function requireCategoryId(db: TreeDb, categoryId: string): void {
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
    refuseClash(tx, null, input.name, false)
    for (const entry of extra) refuseClash(tx, null, entry.text, entry.shared ?? false)
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

/** Moves a record to another category (its kind follows) or changes its image file. */
export function updateRecord(
  db: TreeDb,
  id: string,
  patch: { categoryId?: string; image?: string | null },
  now: Date
): StoryRecord {
  requireRecord(db, id)
  if (patch.categoryId !== undefined) requireCategoryId(db, patch.categoryId)
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
    for (const entry of wanted) refuseClash(tx, id, entry.text, entry.shared ?? false)
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
  requireAliasRoom(current.name, otherNames(current.aliases) + 1)
  db.transaction((tx) => {
    refuseClash(tx, id, entry.text, entry.shared ?? false)
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
  const siblings = requireRecord(db, recordId).aliases.filter((entry) => entry.id !== aliasId)
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
  refuseClash(db, recordId, text, current.shared)
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
  db.update(alias).set({ text, norm, caseRule }).where(eq(alias.id, aliasId)).run()
  db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, recordId)).run()
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
  if (clashOwner(db, row.recordId, before.norm, row.shared) !== null) return false
  const sibling = db
    .select({ id: alias.id })
    .from(alias)
    .where(
      and(eq(alias.recordId, row.recordId), eq(alias.norm, before.norm), ne(alias.id, aliasId))
    )
    .get()
  if (sibling !== undefined) return false
  db.update(alias)
    .set({ text: before.text, norm: before.norm, caseRule: before.caseRule })
    .where(eq(alias.id, aliasId))
    .run()
  db.update(record).set({ modified: now.toISOString() }).where(eq(record.id, row.recordId)).run()
  return true
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

/** Deletes a record; its names, mentions and dismissals go with it. Answers what it was. */
export function deleteRecord(db: TreeDb, id: string): StoryRecord {
  const gone = requireRecord(db, id)
  db.transaction((tx) => {
    removeFromAlsoHere(tx, id, null)
    tx.delete(record).where(eq(record.id, id)).run()
  })
  return gone
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

/** Rewrites the record id inside a dismissal key (`recordId|…`, or a sorted pair). */
function rekey(kind: string, key: string, from: string, to: string): string | null {
  if (kind === 'split' || kind === 'notSame') {
    const [a, b] = key.split('|')
    const pair = [a === from ? to : a, b === from ? to : b]
    if (pair[0] === pair[1]) return null
    return dismissedKey({ kind: 'notSame', a: pair[0] ?? '', b: pair[1] ?? '' })
  }
  if ((kind === 'alias' || kind === 'notMention') && key.startsWith(`${from}|`)) {
    return `${to}${key.slice(from.length)}`
  }
  return key
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
 * details ("+ also here" too), to-dos and dismissals (their keys rewritten; a split or not-same
 * between the two goes). The merged record is then deleted. Refused when the kept record would
 * end with more than `RECORD_ALIASES_MAX` other names.
 */
export function sameAs(db: TreeDb, keepId: string, mergeId: string, now: Date): SameAsResult {
  if (keepId === mergeId) throw new AppError('VALIDATION', 'A record cannot be merged into itself')
  const keep = requireRecord(db, keepId)
  const merge = requireRecord(db, mergeId)
  const have = new Set(keep.aliases.map((entry) => entry.norm))
  requireAliasRoom(
    keep.name,
    otherNames(keep.aliases) + merge.aliases.filter((entry) => !have.has(entry.norm)).length
  )
  let droppedImage: string | null = null
  db.transaction((tx) => {
    for (const entry of merge.aliases) {
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
 * already has is dropped. The author's explicit act: no twin gate.
 */
export function splitRecord(
  db: TreeDb,
  id: string,
  aliasIds: readonly string[],
  intoId: string | null,
  now: Date
): SplitResult {
  const from = requireRecord(db, id)
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
