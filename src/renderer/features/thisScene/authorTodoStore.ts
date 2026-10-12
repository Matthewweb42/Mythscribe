import { create } from 'zustand'
import type { AuthorTodo, AuthorTodoPatch } from '@shared/memory/authorTodo'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * My to-dos (F-16.10; story memory v2): the one owner of the author's own to-dos in the renderer,
 * in her order. Only she writes them (the chat agent reads them and never ticks one), so the
 * store merges what each action answers and needs no push. Loaded on a v2 open.
 */
interface AuthorTodoState {
  todos: AuthorTodo[]
  loaded: boolean
  load: () => Promise<void>
  /** Adds a to-do at the end, pointing at a scene or a record when given. Answers whether it went. */
  create: (input: {
    text: string
    nodeId?: string | null
    recordId?: string | null
  }) => Promise<boolean>
  /** Edits a to-do, or ticks and unticks it. */
  update: (id: string, patch: AuthorTodoPatch) => Promise<void>
  remove: (id: string) => Promise<void>
  /** Moves a to-do one place up (-1) or down (1). */
  move: (id: string, step: -1 | 1) => Promise<void>
  clear: () => void
}

let generation = 0

export const useAuthorTodoStore = create<AuthorTodoState>((set, get) => {
  /** Runs one write; a failure is toasted and the list read again, so it shows what main holds. */
  const write = async (run: () => Promise<AuthorTodo[] | null>): Promise<boolean> => {
    const mine = generation
    try {
      const todos = await run()
      if (todos !== null && mine === generation) set({ todos })
      return true
    } catch (err) {
      toast.error(describeError(err))
      if (mine === generation)
        await get()
          .load()
          .catch(() => undefined)
      return false
    }
  }

  return {
    todos: [],
    loaded: false,

    async load() {
      const mine = generation
      const todos = await ipc().invoke('authorTodo:list', undefined)
      if (mine === generation) set({ todos, loaded: true })
    },

    create({ text, nodeId = null, recordId = null }) {
      return write(async () => {
        const made = await ipc().invoke('authorTodo:create', { text, nodeId, recordId })
        return [...get().todos.filter((each) => each.id !== made.id), made]
      })
    },

    async update(id, patch) {
      await write(async () => {
        const updated = await ipc().invoke('authorTodo:update', { id, patch })
        return get().todos.map((each) => (each.id === id ? updated : each))
      })
    },

    async remove(id) {
      await write(() => ipc().invoke('authorTodo:delete', { id }))
    },

    async move(id, step) {
      const ids = get().todos.map((each) => each.id)
      const at = ids.indexOf(id)
      const to = at + step
      if (at < 0 || to < 0 || to >= ids.length) return
      ids.splice(at, 1)
      ids.splice(to, 0, id)
      await write(() => ipc().invoke('authorTodo:reorder', { ids }))
    },

    clear() {
      generation++
      set({ todos: [], loaded: false })
    }
  }
})

/** Empties the store. For tests and project close. */
export function resetAuthorTodoStore(): void {
  useAuthorTodoStore.getState().clear()
}
