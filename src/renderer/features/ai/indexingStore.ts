import { create } from 'zustand'
import { IDLE_INDEX_QUEUE, type IndexQueueStatus } from '@shared/jobs'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** The subscription to main's queue; one for the renderer, opened by the first load. */
let unsubscribe: (() => void) | null = null

/**
 * The renderer's view of the background index queue (F-5.13). Main owns the queue: it decides
 * what is queued, what runs, what failed, and whether it is paused, and pushes the whole status
 * on every change (`jobs:changed`), so this store holds the last status and asks for the three
 * things the author can do — Cancel, Retry, and "Summarize all scenes". It never computes a
 * status of its own: the indicator shows what main last said.
 */
interface IndexingState {
  status: IndexQueueStatus
  /** Fetches the queue (and opens the change subscription on the first call). */
  load: () => Promise<void>
  /** Stops indexing: what is running is aborted and everything waiting is dropped. */
  cancel: () => Promise<void>
  /** Clears a pause and puts the failed jobs back in the queue. */
  resume: () => Promise<void>
  /** Queues every scene whose summary is missing or out of date, and says how many. */
  indexAll: () => Promise<void>
  /** Forgets the queue (project close). */
  clear: () => void
}

export const useIndexingStore = create<IndexingState>((set) => ({
  status: IDLE_INDEX_QUEUE,

  async load() {
    unsubscribe ??= ipc().on('jobs:changed', (status) => set({ status }))
    try {
      set({ status: await ipc().invoke('jobs:status', undefined) })
    } catch (err: unknown) {
      toast.error(describeError(err))
    }
  },

  async cancel() {
    try {
      set({ status: await ipc().invoke('jobs:cancel', undefined) })
    } catch (err: unknown) {
      toast.error(describeError(err))
    }
  },

  async resume() {
    try {
      set({ status: await ipc().invoke('jobs:resume', undefined) })
    } catch (err: unknown) {
      toast.error(describeError(err))
    }
  },

  async indexAll() {
    try {
      const result = await ipc().invoke('jobs:indexAll', undefined)
      if (!result.ok) {
        // The dial or the toggle refused: the message says which, the next step says what to do.
        toast.error(`${result.message} ${result.nextStep}`.trim())
        return
      }
      set({ status: result.status })
      toast.success(
        result.queued === 0
          ? 'Every scene is up to date.'
          : `Queued ${result.queued} ${result.queued === 1 ? 'scene' : 'scenes'} for a summary.`
      )
    } catch (err: unknown) {
      toast.error(describeError(err))
    }
  },

  clear() {
    set({ status: IDLE_INDEX_QUEUE })
  }
}))

/** Forgets the queue and drops the change subscription. For tests only. */
export function resetIndexingStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useIndexingStore.setState({ status: IDLE_INDEX_QUEUE })
}
