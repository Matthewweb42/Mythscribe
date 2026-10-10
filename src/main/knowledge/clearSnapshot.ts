import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import { ClearRow, type ClearSnapshot, type ClearTable, type ClearValue } from '@shared/bibleClear'
import { toEntityNameKey } from '@shared/entities'
import { entity, knowledgeChange, node, tag, todoItem } from '../db/schema'
import type { EntityDb } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { getTagAliases, setTagAliases } from '../project/settingsStore'
import { notesText } from '../ai/context/scenePanel'

/**
 * The rows a clear of the story bible removes, read before it removes them, and put back by its
 * Undo (F-5.25). The capture is generic SQL over the tables a clear deletes from or cascades
 * into (`CLEAR_TABLES`), so a row goes back exactly as it was, every column included; the
 * restore inserts them in one transaction with the foreign keys checked at commit. Nothing here
 * reads or writes scene text.
 *
 * A sheet comes back with its own fact rows, the baseline mirror of its fields included, so the
 * one-writer rule of `entity.fields` (`factStore.writeAuthorFields`) still holds after an Undo:
 * the column and its facts are the pair that was there before the clear.
 */

/** How many ids one `IN (…)` list carries, well under SQLite's bound-parameter cap. */
const IN_CHUNK = 500

/** A reference a restored row holds: what it points at, and what happens when that is gone now. */
interface RefRule {
  column: string
  table: 'node' | 'tag' | 'entity' | 'ai_proposal'
  /** `skip`: the row is not put back (it cascaded with its target); `null`: the reference is cleared. */
  missing: 'skip' | 'null'
}

const REFS: Readonly<Record<ClearTable, readonly RefRule[]>> = {
  tag: [{ column: 'parent_id', table: 'tag', missing: 'null' }],
  entity: [{ column: 'tag_id', table: 'tag', missing: 'null' }],
  fact: [
    { column: 'entity_id', table: 'entity', missing: 'skip' },
    { column: 'object_entity_id', table: 'entity', missing: 'skip' },
    { column: 'node_id', table: 'node', missing: 'null' }
  ],
  observed_fact: [
    { column: 'entity_id', table: 'entity', missing: 'skip' },
    { column: 'node_id', table: 'node', missing: 'skip' }
  ],
  continuity_finding: [
    { column: 'node_id', table: 'node', missing: 'skip' },
    { column: 'entity_id', table: 'entity', missing: 'skip' },
    { column: 'ref_node_id', table: 'node', missing: 'null' },
    { column: 'proposal_id', table: 'ai_proposal', missing: 'null' }
  ],
  document_tag: [
    { column: 'node_id', table: 'node', missing: 'skip' },
    { column: 'tag_id', table: 'tag', missing: 'skip' }
  ],
  document_tag_dismissal: [
    { column: 'node_id', table: 'node', missing: 'skip' },
    { column: 'tag_id', table: 'tag', missing: 'skip' }
  ],
  tag_mention: [
    { column: 'tag_id', table: 'tag', missing: 'skip' },
    { column: 'node_id', table: 'node', missing: 'skip' }
  ],
  context_file: []
}

const inList = (ids: readonly string[]): SQL =>
  sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )

/**
 * Every row of `table` whose `columns` (any of them) hold one of `ids`, each row once, as SQLite
 * stores it. A value outside text, number, and null (a blob) refuses the capture, so nothing is
 * deleted that could not be put back.
 */
export function captureRows(
  db: EntityDb,
  table: ClearTable,
  columns: readonly string[],
  ids: readonly string[]
): ClearRow[] {
  const seen = new Set<string>()
  const out: ClearRow[] = []
  for (let at = 0; at < ids.length; at += IN_CHUNK) {
    const chunk = ids.slice(at, at + IN_CHUNK)
    const where = sql.join(
      columns.map((column) => sql`${sql.identifier(column)} IN (${inList(chunk)})`),
      sql` OR `
    )
    const rows = db.all<Record<string, unknown>>(
      sql`SELECT * FROM ${sql.identifier(table)} WHERE ${where}`
    )
    for (const raw of rows) {
      const parsed = ClearRow.safeParse(raw)
      if (!parsed.success) {
        throw new AppError('VALIDATION', `A row of ${table} cannot be kept for the Undo`, { table })
      }
      const key = JSON.stringify(parsed.data)
      if (seen.has(key)) continue
      seen.add(key)
      out.push(parsed.data)
    }
  }
  return out
}

/** What an Undo put back, for the windows. */
export interface ClearRestored {
  entityIds: string[]
  tagIds: string[]
  /** Scenes whose tag links came back. */
  linkNodeIds: string[]
  notesNodeIds: string[]
  libraryIds: string[]
}

const str = (value: ClearValue | undefined): string | null =>
  typeof value === 'string' ? value : null

function exists(db: EntityDb, table: RefRule['table'], id: string): boolean {
  const row = db.get<{ one: number }>(
    sql`SELECT 1 AS one FROM ${sql.identifier(table)} WHERE id = ${id}`
  )
  return row !== undefined
}

function columnsOf(db: EntityDb, table: ClearTable): Set<string> {
  const rows = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info(${table})`)
  return new Set(rows.map((row) => row.name))
}

const plural = (names: readonly string[]): string => {
  const shown = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${shown} and ${names.length - 3} more` : shown
}

/** Refuses an Undo that would double what was made again since (a re-upload) or overwrite new notes. */
function assertRestorable(db: EntityDb, snapshot: ClearSnapshot): void {
  const rowsOf = (table: ClearTable): ClearRow[] =>
    snapshot.rows.filter((group) => group.table === table).flatMap((group) => group.rows)
  const taken: string[] = []
  const liveTags = new Set(
    db
      .select({ name: tag.name })
      .from(tag)
      .all()
      .map((row) => row.name)
  )
  for (const row of rowsOf('tag')) {
    const name = str(row.name)
    if (name !== null && liveTags.has(name)) taken.push(`#${name}`)
  }
  const liveSheets = new Set(
    db
      .select({ kind: entity.kind, name: entity.name })
      .from(entity)
      .all()
      .map((row) => `${row.kind}\u0000${toEntityNameKey(row.name)}`)
  )
  for (const row of rowsOf('entity')) {
    const kind = str(row.kind)
    const name = str(row.name)
    if (kind !== null && name !== null && liveSheets.has(`${kind}\u0000${toEntityNameKey(name)}`))
      taken.push(name)
  }
  const liveFiles = new Set(
    db.all<{ name: string }>(sql`SELECT name FROM context_file`).map((r) => r.name.toLowerCase())
  )
  for (const row of rowsOf('context_file')) {
    const name = str(row.name)
    if (name !== null && liveFiles.has(name.toLowerCase())) taken.push(name)
  }
  if (taken.length > 0) {
    throw new AppError(
      'VALIDATION',
      `${plural(taken)} ${taken.length === 1 ? 'was' : 'were'} made again since the clear, so putting it back would double ${taken.length === 1 ? 'it' : 'them'}. The backup taken just before the clear has everything (Settings › Backups).`,
      { taken: taken.length }
    )
  }
  const written: string[] = []
  for (const held of snapshot.notes) {
    const row = db.select({ notes: node.notes }).from(node).where(eq(node.id, held.nodeId)).get()
    if (row !== undefined && notesText(row.notes, held.nodeId) !== '') written.push(held.title)
  }
  if (written.length > 0) {
    throw new AppError(
      'VALIDATION',
      `You have written notes in ${plural(written)} since the clear, so they cannot be put back. The backup taken just before the clear has them (Settings › Backups).`,
      { written: written.length }
    )
  }
}

/**
 * Puts back everything a clear removed, inside the caller's transaction (F-5.25). Refused whole
 * (VALIDATION) when a tag, a sheet of the same category, or an upload of the same name has been
 * made since, or a cleared document has notes again. A row whose scene has gone since is not put
 * back (it would have cascaded with the scene); a reference to something gone is cleared.
 */
export function restoreCleared(db: EntityDb, snapshot: ClearSnapshot): ClearRestored {
  assertRestorable(db, snapshot)
  db.run(sql`PRAGMA defer_foreign_keys = ON`)
  const restoring: Record<'tag' | 'entity', Set<string>> = {
    tag: new Set(),
    entity: new Set()
  }
  for (const group of snapshot.rows) {
    if (group.table !== 'tag' && group.table !== 'entity') continue
    for (const row of group.rows) {
      const id = str(row.id)
      if (id !== null) restoring[group.table].add(id)
    }
  }
  const present = (table: RefRule['table'], id: string): boolean =>
    ((table === 'tag' || table === 'entity') && restoring[table].has(id)) || exists(db, table, id)

  const restored: ClearRestored = {
    entityIds: [...restoring.entity],
    tagIds: [...restoring.tag],
    linkNodeIds: [],
    notesNodeIds: [],
    libraryIds: []
  }
  const links = new Set<string>()
  for (const group of snapshot.rows) {
    const columns = columnsOf(db, group.table)
    for (const original of group.rows) {
      const row: ClearRow = {}
      for (const [column, value] of Object.entries(original)) {
        // A column a later migration dropped is left out; one it added takes its default.
        if (columns.has(column)) row[column] = value
      }
      let keep = true
      for (const rule of REFS[group.table]) {
        const target = str(row[rule.column])
        if (target === null || present(rule.table, target)) continue
        if (rule.missing === 'skip') keep = false
        else row[rule.column] = null
      }
      if (!keep) continue
      const names = Object.keys(row)
      db.run(
        sql`INSERT INTO ${sql.identifier(group.table)} (${sql.join(
          names.map((name) => sql.identifier(name)),
          sql`, `
        )}) VALUES (${sql.join(
          names.map((name) => sql`${row[name] ?? null}`),
          sql`, `
        )})`
      )
      if (group.table === 'document_tag') {
        const nodeId = str(row.node_id)
        if (nodeId !== null) links.add(nodeId)
      }
      if (group.table === 'context_file') {
        const id = str(row.id)
        if (id !== null) restored.libraryIds.push(id)
      }
    }
  }
  restored.linkNodeIds = [...links]

  for (const held of snapshot.sheetTags) {
    if (!present('tag', held.tagId)) continue
    db.update(entity)
      .set({ tagId: held.tagId, aliases: held.aliases })
      .where(and(eq(entity.id, held.id), isNull(entity.tagId)))
      .run()
    restored.entityIds.push(held.id)
  }
  for (const held of snapshot.tagParents) {
    if (!present('tag', held.parentId)) continue
    db.update(tag)
      .set({ parentId: held.parentId })
      .where(and(eq(tag.id, held.id), isNull(tag.parentId)))
      .run()
    restored.tagIds.push(held.id)
  }
  for (const held of snapshot.entityRefs) {
    if (!present('entity', held.entityId)) continue
    if (held.table === 'knowledge_change') {
      db.update(knowledgeChange)
        .set({ entityId: held.entityId })
        .where(and(eq(knowledgeChange.id, held.id), isNull(knowledgeChange.entityId)))
        .run()
    } else {
      db.update(todoItem)
        .set({ entityId: held.entityId })
        .where(and(eq(todoItem.id, held.id), isNull(todoItem.entityId)))
        .run()
    }
  }
  const modified = new Date().toISOString()
  for (const held of snapshot.notes) {
    const written = db
      .update(node)
      .set({ notes: held.notes, modified })
      .where(eq(node.id, held.nodeId))
      .returning({ id: node.id })
      .get()
    if (written !== undefined) restored.notesNodeIds.push(held.nodeId)
  }
  const aliases = getTagAliases(db)
  let aliasesMoved = false
  for (const [from, to] of Object.entries(snapshot.tagAliases)) {
    if (aliases[from] !== undefined || !present('tag', to)) continue
    aliases[from] = to
    aliasesMoved = true
  }
  if (aliasesMoved) setTagAliases(db, aliases)
  restored.entityIds = [...new Set(restored.entityIds)]
  restored.tagIds = [...new Set(restored.tagIds)]
  return restored
}
