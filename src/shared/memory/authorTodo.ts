import { z } from 'zod'

/**
 * My to-dos (F-16.10): the author's own list, shown at the top of Needs a look (P1 slice 4). A
 * new table (`author_todo`), apart from v1's computed To do items (`todo_item`, which retires at
 * the switch-over). A to-do may point at a scene or a record; it outlives either (the link is
 * cleared when that goes).
 */

/** The longest to-do. */
export const AUTHOR_TODO_TEXT_MAX = 500
/** Most to-dos one project keeps. */
export const AUTHOR_TODOS_MAX = 500

export const AuthorTodoText = z.string().trim().min(1).max(AUTHOR_TODO_TEXT_MAX)

export const AuthorTodo = z.object({
  id: z.string(),
  text: z.string(),
  nodeId: z.string().nullable(),
  recordId: z.string().nullable(),
  done: z.boolean(),
  /** 0-based, contiguous: the order the author keeps them in. */
  position: z.number().int(),
  created: z.string(),
  doneAt: z.string().nullable()
})
export type AuthorTodo = z.infer<typeof AuthorTodo>

export const AuthorTodoCreate = z.object({
  text: AuthorTodoText,
  nodeId: z.string().nullable().default(null),
  recordId: z.string().nullable().default(null)
})
export type AuthorTodoCreate = z.input<typeof AuthorTodoCreate>

export const AuthorTodoPatch = z.object({
  text: AuthorTodoText.optional(),
  done: z.boolean().optional(),
  nodeId: z.string().nullable().optional(),
  recordId: z.string().nullable().optional()
})
export type AuthorTodoPatch = z.infer<typeof AuthorTodoPatch>
