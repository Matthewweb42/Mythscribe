import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm'
import {
  NOTEBOOK_ROLES,
  NOTEBOOK_SECTION_TITLE,
  NOTEBOOK_VERSIONS_KEPT,
  notebookPlain,
  type NotebookAuthor,
  type NotebookItem,
  type NotebookKind,
  type NotebookPage,
  type NotebookRole,
  type NotebookVersion
} from '@shared/notebook'
import { TiptapNode, type TiptapNodeT } from '@shared/tiptap'
import { notebookItem, notebookVersion, type NotebookItemRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/**
 * The notebook's store (notes redesign phase 1): the one writer of `notebook_item` and
 * `notebook_version`. A delete only marks the item and everything under it (`deleted`), so Undo
 * restores it; a write by Ms Scribe or an import first keeps the page as it was, so Undo restores
 * that version. At most `NOTEBOOK_VERSIONS_KEPT` versions per page. The notes binder (2026-10-16):
 * three fixed section roots (Outline, Timeline, Documents; `ensureNotebookSections`) are the only
 * top-level items; they cannot be renamed, moved or deleted, and anything made, moved or restored
 * to the top level goes into Documents.
 */

const now = (): string => new Date().toISOString()

function parseContent(raw: string | null): TiptapNodeT | null {
  if (raw === null) return null
  try {
    const parsed = TiptapNode.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function toItem(row: NotebookItemRow): NotebookItem {
  return {
    id: row.id,
    parentId: row.parentId,
    kind: row.kind,
    title: row.title,
    position: row.position,
    modified: row.modified,
    role: row.role
  }
}

function toPage(row: NotebookItemRow): NotebookPage {
  return { ...toItem(row), content: parseContent(row.content), plain: row.plain, created: row.created }
}

function liveRow(db: TreeDb, id: string): NotebookItemRow {
  const row = db.select().from(notebookItem).where(eq(notebookItem.id, id)).get()
  if (row?.deleted !== null) throw new AppError('NOT_FOUND', 'That note is gone.')
  return row
}

/** The live root of a section, or undefined. */
function sectionRow(db: TreeDb, role: NotebookRole): NotebookItemRow | undefined {
  return db
    .select()
    .from(notebookItem)
    .where(and(eq(notebookItem.role, role), isNull(notebookItem.deleted)))
    .orderBy(asc(notebookItem.position))
    .get()
}

/**
 * The notes binder (2026-10-16): makes any missing section root (Outline, Timeline, Documents, in
 * that order, at the top) and moves every other live top-level item into Documents after what it
 * holds, keeping their order. Run when a project opens, and before anything is made at the top.
 * Idempotent: a second run writes nothing. Answers the ids it wrote (made or moved).
 */
export function ensureNotebookSections(db: TreeDb): string[] {
  return db.transaction((tx) => {
    const written: string[] = []
    const roots = new Map<NotebookRole, NotebookItemRow>()
    for (const [at, role] of NOTEBOOK_ROLES.entries()) {
      let row = sectionRow(tx, role)
      if (row === undefined) {
        const stamp = now()
        const id = randomUUID()
        tx.insert(notebookItem)
          .values({
            id,
            parentId: null,
            kind: 'folder',
            title: NOTEBOOK_SECTION_TITLE[role],
            content: null,
            plain: '',
            position: at,
            deleted: null,
            created: stamp,
            modified: stamp,
            role
          })
          .run()
        written.push(id)
        row = liveRow(tx, id)
      }
      if (row.parentId !== null || row.position !== at) {
        tx.update(notebookItem)
          .set({ parentId: null, position: at })
          .where(eq(notebookItem.id, row.id))
          .run()
        written.push(row.id)
      }
      roots.set(role, row)
    }
    const documents = roots.get('documents')
    if (documents === undefined) return written
    const strays = tx
      .select()
      .from(notebookItem)
      .where(
        and(
          isNull(notebookItem.parentId),
          isNull(notebookItem.deleted),
          isNull(notebookItem.role)
        )
      )
      .orderBy(asc(notebookItem.position), asc(notebookItem.created))
      .all()
    let position = nextPosition(tx, documents.id)
    for (const stray of strays) {
      tx.update(notebookItem)
        .set({ parentId: documents.id, position })
        .where(eq(notebookItem.id, stray.id))
        .run()
      position += 1
      written.push(stray.id)
    }
    return written
  })
}

/** The id of a section's root, made (with the others) when missing. */
export function notebookSectionId(db: TreeDb, role: NotebookRole): string {
  const row = sectionRow(db, role)
  if (row !== undefined) return row.id
  ensureNotebookSections(db)
  const made = sectionRow(db, role)
  if (made === undefined) throw new AppError('INTERNAL', 'The Notes sections could not be made.')
  return made.id
}

/** Refuses a change to a section root: it is never renamed, moved or deleted. */
function guardSection(row: NotebookItemRow, change: 'renamed' | 'moved' | 'deleted'): void {
  if (row.role === null) return
  throw new AppError(
    'VALIDATION',
    `${NOTEBOOK_SECTION_TITLE[row.role]} is one of the Notes sections; it cannot be ${change}.`
  )
}

/**
 * Rows in the tree's order: depth first from the top, each folder's children by position (the
 * notes binder: Outline, Timeline, Documents and what each holds, so listings and Ms Scribe's
 * page refs read as the tree does). A row whose folder is not live comes last.
 */
function inTreeOrder(rows: readonly NotebookItemRow[]): NotebookItemRow[] {
  const ids = new Set(rows.map((row) => row.id))
  const children = new Map<string | null, NotebookItemRow[]>()
  for (const row of rows) {
    const parent = row.parentId !== null && ids.has(row.parentId) ? row.parentId : null
    const list = children.get(parent) ?? []
    list.push(row)
    children.set(parent, list)
  }
  const out: NotebookItemRow[] = []
  const seen = new Set<string>()
  const walk = (parent: string | null): void => {
    for (const row of children.get(parent) ?? []) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      out.push(row)
      walk(row.id)
    }
  }
  walk(null)
  for (const row of rows) if (!seen.has(row.id)) out.push(row)
  return out
}

/** Every live item, folders and pages, in the tree's order. */
export function listNotebook(db: TreeDb): NotebookItem[] {
  const rows = db
    .select()
    .from(notebookItem)
    .where(isNull(notebookItem.deleted))
    .orderBy(asc(notebookItem.position), asc(notebookItem.created))
    .all()
  return inTreeOrder(rows).map(toItem)
}

/** Every live page with its content (prompts and search), in the tree's order. */
export function listNotebookPages(db: TreeDb): NotebookPage[] {
  const rows = db
    .select()
    .from(notebookItem)
    .where(isNull(notebookItem.deleted))
    .orderBy(asc(notebookItem.position), asc(notebookItem.created))
    .all()
  return inTreeOrder(rows)
    .filter((row) => row.kind === 'page')
    .map(toPage)
}

export function getNotebookPage(db: TreeDb, id: string): NotebookPage {
  return toPage(liveRow(db, id))
}

function checkParent(db: TreeDb, parentId: string | null): void {
  if (parentId === null) return
  if (liveRow(db, parentId).kind !== 'folder') {
    throw new AppError('VALIDATION', 'Notes can only go inside a folder.')
  }
}

function nextPosition(db: TreeDb, parentId: string | null): number {
  const last = db
    .select({ position: notebookItem.position })
    .from(notebookItem)
    .where(
      and(
        parentId === null ? isNull(notebookItem.parentId) : eq(notebookItem.parentId, parentId),
        isNull(notebookItem.deleted)
      )
    )
    .orderBy(desc(notebookItem.position))
    .get()
  return (last?.position ?? -1) + 1
}

export interface CreateNotebookInput {
  parentId: string | null
  kind: NotebookKind
  title: string
  content?: TiptapNodeT | null
  position?: number
}

/**
 * A new page or folder. With `parentId` null it goes into Documents (the notes binder: nothing new
 * lands at the top level).
 */
export function createNotebookItem(db: TreeDb, input: CreateNotebookInput): NotebookPage {
  const parentId = input.parentId ?? notebookSectionId(db, 'documents')
  checkParent(db, parentId)
  const content = input.kind === 'page' ? (input.content ?? null) : null
  const stamp = now()
  const row = {
    id: randomUUID(),
    parentId,
    kind: input.kind,
    title: input.title,
    content: content === null ? null : JSON.stringify(content),
    plain: notebookPlain(content),
    position: input.position ?? nextPosition(db, parentId),
    deleted: null,
    created: stamp,
    modified: stamp,
    role: null
  }
  db.insert(notebookItem).values(row).run()
  return getNotebookPage(db, row.id)
}

function keepVersion(db: TreeDb, row: NotebookItemRow, author: NotebookAuthor): void {
  db.insert(notebookVersion)
    .values({
      id: randomUUID(),
      pageId: row.id,
      author,
      title: row.title,
      content: row.content,
      created: now()
    })
    .run()
  const kept = db
    .select({ id: notebookVersion.id })
    .from(notebookVersion)
    .where(eq(notebookVersion.pageId, row.id))
    .orderBy(desc(notebookVersion.created), desc(sql`rowid`))
    .limit(NOTEBOOK_VERSIONS_KEPT)
    .all()
    .map((v) => v.id)
  db.delete(notebookVersion)
    .where(and(eq(notebookVersion.pageId, row.id), notInArray(notebookVersion.id, kept)))
    .run()
}

export interface UpdateNotebookInput {
  id: string
  title?: string
  content?: TiptapNodeT | null
}

/**
 * A page or folder renamed or rewritten. The author's own typing keeps no version (autosave);
 * Ms Scribe's or an import's write keeps the page as it was first, which its Undo restores.
 * Answers the version kept, or null.
 */
export function updateNotebookItem(
  db: TreeDb,
  input: UpdateNotebookInput,
  by: NotebookAuthor = 'me'
): { page: NotebookPage; versionId: string | null } {
  const row = liveRow(db, input.id)
  if (input.title !== undefined && input.title !== row.title) guardSection(row, 'renamed')
  if (input.content !== undefined && row.kind !== 'page') {
    throw new AppError('VALIDATION', 'A folder has no text.')
  }
  let versionId: string | null = null
  if (by !== 'me' && row.kind === 'page') {
    keepVersion(db, row, by)
    versionId =
      db
        .select({ id: notebookVersion.id })
        .from(notebookVersion)
        .where(eq(notebookVersion.pageId, row.id))
        .orderBy(desc(notebookVersion.created), desc(sql`rowid`))
        .get()?.id ?? null
  }
  const patch: Partial<NotebookItemRow> = { modified: now() }
  if (input.title !== undefined) patch.title = input.title
  if (input.content !== undefined) {
    patch.content = input.content === null ? null : JSON.stringify(input.content)
    patch.plain = notebookPlain(input.content)
  }
  db.update(notebookItem).set(patch).where(eq(notebookItem.id, row.id)).run()
  return { page: getNotebookPage(db, row.id), versionId }
}

function isUnder(db: TreeDb, id: string, ancestorId: string): boolean {
  let current: string | null = id
  const seen = new Set<string>()
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true
    seen.add(current)
    const parent: { parentId: string | null } | undefined = db
      .select({ parentId: notebookItem.parentId })
      .from(notebookItem)
      .where(eq(notebookItem.id, current))
      .get()
    current = parent?.parentId ?? null
  }
  return false
}

/** Moves an item; to the top level (`parentId` null) means into Documents. */
export function moveNotebookItem(
  db: TreeDb,
  input: { id: string; parentId: string | null; position: number }
): void {
  guardSection(liveRow(db, input.id), 'moved')
  const parentId = input.parentId ?? notebookSectionId(db, 'documents')
  checkParent(db, parentId)
  if (isUnder(db, parentId, input.id)) {
    throw new AppError('VALIDATION', 'A folder cannot go inside itself.')
  }
  db.update(notebookItem)
    .set({ parentId, position: input.position, modified: now() })
    .where(eq(notebookItem.id, input.id))
    .run()
}

function subtreeIds(db: TreeDb, id: string, deleted: string | null): string[] {
  const ids = [id]
  // An array iterator sees what is pushed during the loop: a breadth-first walk.
  for (const parent of ids) {
    const children = db
      .select({ id: notebookItem.id, deleted: notebookItem.deleted })
      .from(notebookItem)
      .where(eq(notebookItem.parentId, parent))
      .all()
      .filter((child) => child.deleted === deleted)
    ids.push(...children.map((child) => child.id))
  }
  return ids
}

/** Marks an item and everything under it deleted; answers the mark, which `restore` takes. */
export function deleteNotebookItem(db: TreeDb, id: string): string {
  guardSection(liveRow(db, id), 'deleted')
  // Unique per delete, so an Undo restores only what this delete took (two deletes can share a millisecond).
  const mark = `${now()} ${randomUUID()}`
  const ids = subtreeIds(db, id, null)
  db.update(notebookItem).set({ deleted: mark }).where(inArray(notebookItem.id, ids)).run()
  return mark
}

/** Undo of a delete: the item and what was deleted with it come back. */
export function restoreNotebookItem(db: TreeDb, id: string): NotebookItem {
  const row = db.select().from(notebookItem).where(eq(notebookItem.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'That note is gone.')
  if (row.deleted === null) return toItem(row)
  const ids = subtreeIds(db, id, row.deleted)
  db.update(notebookItem).set({ deleted: null }).where(inArray(notebookItem.id, ids)).run()
  // Its folder gone (or never one, an item from before the sections): it comes back in Documents.
  const parent =
    row.parentId === null
      ? undefined
      : db.select().from(notebookItem).where(eq(notebookItem.id, row.parentId)).get()
  if (row.role === null && parent?.deleted !== null) {
    const documents = notebookSectionId(db, 'documents')
    db.update(notebookItem)
      .set({ parentId: documents, position: nextPosition(db, documents) })
      .where(eq(notebookItem.id, id))
      .run()
  }
  return toItem(liveRow(db, id))
}

export function listNotebookVersions(db: TreeDb, pageId: string): NotebookVersion[] {
  return db
    .select()
    .from(notebookVersion)
    .where(eq(notebookVersion.pageId, pageId))
    .orderBy(desc(notebookVersion.created), desc(sql`rowid`))
    .all()
    .map((row) => ({
      id: row.id,
      pageId: row.pageId,
      author: row.author,
      title: row.title,
      content: parseContent(row.content),
      created: row.created
    }))
}

/** Puts a page back as a kept version had it (Undo of Ms Scribe's edit); the current text is kept first. */
export function restoreNotebookVersion(db: TreeDb, versionId: string): NotebookPage {
  const version = db.select().from(notebookVersion).where(eq(notebookVersion.id, versionId)).get()
  if (version === undefined) throw new AppError('NOT_FOUND', 'That version is gone.')
  const row = liveRow(db, version.pageId)
  keepVersion(db, row, 'me')
  db.update(notebookItem)
    .set({
      title: version.title,
      content: version.content,
      plain: notebookPlain(parseContent(version.content)),
      modified: now()
    })
    .where(eq(notebookItem.id, row.id))
    .run()
  return getNotebookPage(db, row.id)
}
