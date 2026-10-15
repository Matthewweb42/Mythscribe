import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, inArray, isNull, notInArray } from 'drizzle-orm'
import {
  NOTEBOOK_VERSIONS_KEPT,
  notebookPlain,
  type NotebookAuthor,
  type NotebookItem,
  type NotebookKind,
  type NotebookPage,
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
 * that version. At most `NOTEBOOK_VERSIONS_KEPT` versions per page.
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
    modified: row.modified
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

/** Every live item, folders and pages, ordered by parent then position. */
export function listNotebook(db: TreeDb): NotebookItem[] {
  return db
    .select()
    .from(notebookItem)
    .where(isNull(notebookItem.deleted))
    .orderBy(asc(notebookItem.parentId), asc(notebookItem.position))
    .all()
    .map(toItem)
}

/** Every live page with its content (prompts and search). */
export function listNotebookPages(db: TreeDb): NotebookPage[] {
  return db
    .select()
    .from(notebookItem)
    .where(and(isNull(notebookItem.deleted), eq(notebookItem.kind, 'page')))
    .orderBy(asc(notebookItem.parentId), asc(notebookItem.position))
    .all()
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

export function createNotebookItem(db: TreeDb, input: CreateNotebookInput): NotebookPage {
  checkParent(db, input.parentId)
  const content = input.kind === 'page' ? (input.content ?? null) : null
  const stamp = now()
  const row = {
    id: randomUUID(),
    parentId: input.parentId,
    kind: input.kind,
    title: input.title,
    content: content === null ? null : JSON.stringify(content),
    plain: notebookPlain(content),
    position: input.position ?? nextPosition(db, input.parentId),
    deleted: null,
    created: stamp,
    modified: stamp
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
    .orderBy(desc(notebookVersion.created), desc(notebookVersion.id))
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
        .orderBy(desc(notebookVersion.created), desc(notebookVersion.id))
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

export function moveNotebookItem(
  db: TreeDb,
  input: { id: string; parentId: string | null; position: number }
): void {
  liveRow(db, input.id)
  checkParent(db, input.parentId)
  if (input.parentId !== null && isUnder(db, input.parentId, input.id)) {
    throw new AppError('VALIDATION', 'A folder cannot go inside itself.')
  }
  db.update(notebookItem)
    .set({ parentId: input.parentId, position: input.position, modified: now() })
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
  liveRow(db, id)
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
  if (row.parentId !== null) {
    const parent = db.select().from(notebookItem).where(eq(notebookItem.id, row.parentId)).get()
    if (parent?.deleted !== null) {
      db.update(notebookItem).set({ parentId: null }).where(eq(notebookItem.id, id)).run()
    }
  }
  return toItem(liveRow(db, id))
}

export function listNotebookVersions(db: TreeDb, pageId: string): NotebookVersion[] {
  return db
    .select()
    .from(notebookVersion)
    .where(eq(notebookVersion.pageId, pageId))
    .orderBy(desc(notebookVersion.created), desc(notebookVersion.id))
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
