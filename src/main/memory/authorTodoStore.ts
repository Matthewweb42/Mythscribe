import { randomUUID } from 'node:crypto'
import { asc, eq } from 'drizzle-orm'
import { AUTHOR_TODOS_MAX, type AuthorTodo, type AuthorTodoPatch } from '@shared/memory/authorTodo'
import { authorTodo, node, record, type AuthorTodoRow } from '../db/schema'
import { AppError } from '../ipc/errors'
import type { TreeDb } from '../tree/treeStore'

/**
 * My to-dos (F-16.10): the one writer of `author_todo`. Positions are 0-based and contiguous; a
 * to-do may point at a node or a record that exists (the link clears if it goes later).
 */

const toTodo = (row: AuthorTodoRow): AuthorTodo => ({
  id: row.id,
  text: row.text,
  nodeId: row.nodeId,
  recordId: row.recordId,
  done: row.done,
  position: row.position,
  created: row.created,
  doneAt: row.doneAt
})

export function listAuthorTodos(db: TreeDb): AuthorTodo[] {
  return db.select().from(authorTodo).orderBy(asc(authorTodo.position)).all().map(toTodo)
}

function requireTodo(db: TreeDb, id: string): AuthorTodo {
  const row = db.select().from(authorTodo).where(eq(authorTodo.id, id)).get()
  if (row === undefined) throw new AppError('NOT_FOUND', 'That to-do no longer exists', { id })
  return toTodo(row)
}

function requireLinks(
  db: TreeDb,
  nodeId: string | null | undefined,
  recordId: string | null | undefined
): void {
  if (
    typeof nodeId === 'string' &&
    db.select({ id: node.id }).from(node).where(eq(node.id, nodeId)).get() === undefined
  ) {
    throw new AppError('NOT_FOUND', 'That scene no longer exists', { nodeId })
  }
  if (
    typeof recordId === 'string' &&
    db.select({ id: record.id }).from(record).where(eq(record.id, recordId)).get() === undefined
  ) {
    throw new AppError('NOT_FOUND', 'That record no longer exists', { recordId })
  }
}

export function createAuthorTodo(
  db: TreeDb,
  input: { text: string; nodeId: string | null; recordId: string | null },
  now: Date
): AuthorTodo {
  const count = listAuthorTodos(db).length
  if (count >= AUTHOR_TODOS_MAX) {
    throw new AppError('VALIDATION', `A project keeps at most ${AUTHOR_TODOS_MAX} to-dos`)
  }
  requireLinks(db, input.nodeId, input.recordId)
  const row: AuthorTodoRow = {
    id: randomUUID(),
    text: input.text.trim(),
    nodeId: input.nodeId,
    recordId: input.recordId,
    done: false,
    position: count,
    created: now.toISOString(),
    doneAt: null
  }
  db.insert(authorTodo).values(row).run()
  return toTodo(row)
}

/** Edits a to-do's text or links, or ticks it (stamping when) and unticks it. */
export function updateAuthorTodo(
  db: TreeDb,
  id: string,
  patch: AuthorTodoPatch,
  now: Date
): AuthorTodo {
  const current = requireTodo(db, id)
  requireLinks(db, patch.nodeId, patch.recordId)
  const doneAt =
    patch.done === undefined || patch.done === current.done
      ? current.doneAt
      : patch.done
        ? now.toISOString()
        : null
  db.update(authorTodo)
    .set({
      ...(patch.text === undefined ? {} : { text: patch.text.trim() }),
      ...(patch.nodeId === undefined ? {} : { nodeId: patch.nodeId }),
      ...(patch.recordId === undefined ? {} : { recordId: patch.recordId }),
      ...(patch.done === undefined ? {} : { done: patch.done }),
      doneAt
    })
    .where(eq(authorTodo.id, id))
    .run()
  return requireTodo(db, id)
}

/** Deletes a to-do; the rest close up. Answers the list. */
export function deleteAuthorTodo(db: TreeDb, id: string): AuthorTodo[] {
  requireTodo(db, id)
  db.transaction((tx) => {
    tx.delete(authorTodo).where(eq(authorTodo.id, id)).run()
    listAuthorTodos(tx).forEach((row, position) => {
      if (row.position !== position) {
        tx.update(authorTodo).set({ position }).where(eq(authorTodo.id, row.id)).run()
      }
    })
  })
  return listAuthorTodos(db)
}

/** Puts the to-dos in this order; `ids` must be every to-do exactly once. Answers the list. */
export function reorderAuthorTodos(db: TreeDb, ids: readonly string[]): AuthorTodo[] {
  const current = listAuthorTodos(db).map((row) => row.id)
  if (
    ids.length !== current.length ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !current.includes(id))
  ) {
    throw new AppError('VALIDATION', 'The new order must list every to-do once')
  }
  db.transaction((tx) => {
    ids.forEach((id, position) => {
      tx.update(authorTodo).set({ position }).where(eq(authorTodo.id, id)).run()
    })
  })
  return listAuthorTodos(db)
}
