import { create } from 'zustand'
import type { IndexQueueStatus } from '@shared/jobs'
import type { KnowledgeConversion } from '@shared/knowledge'
import { useIndexingStore } from '@renderer/features/ai/indexingStore'
import { ipc } from '@renderer/lib/ipc'

/**
 * The conversion pass (F-9.14, D11), renderer side: what main last said about it. Main pushes
 * `knowledge:conversionChanged` a few seconds after a project opens (with the background pass),
 * when the AI settings change, and when "Summarize all scenes" meets held scenes; the dialog shows
 * while the state is `pending` and the author has not chosen Later. Nothing is fetched on open:
 * the push is the trigger, so a project with nothing to convert never asks.
 */
interface ConversionState {
  conversion: KnowledgeConversion | null
  /** Update now is on its way (the backup runs first). */
  converting: boolean
  /**
   * True from Update now until the index queue it filled has settled (empty, or paused, or only
   * failures left): the re-read the activity bar tracks (F-7.12). Session state.
   */
  rereading: boolean
  /** Update now: backup, go-ahead, queue. Rejects with main's refusal (a failed backup). */
  convert: () => Promise<void>
  /** Later: closed until the project opens again. */
  later: () => Promise<void>
  /** Puts the re-read's failed scenes back in the queue and tracks them again (F-7.12 Retry). */
  retryReread: () => Promise<void>
  clear: () => void
  /** Opens the one subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null
/** The watch on the index queue while the re-read runs. */
let stopWatch: (() => void) | null = null

/** Whether the queue has nothing more it will do on its own: empty, paused, or only failures left. */
export function queueSettled(status: IndexQueueStatus): boolean {
  return status.running === null && (status.queued === 0 || status.paused !== null)
}

/** Tracks the re-read until the queue settles; `rereading` goes false then. */
function watchReread(): void {
  stopWatch?.()
  useConversionStore.setState({ rereading: true })
  const done = (status: IndexQueueStatus): boolean => {
    if (!queueSettled(status)) return false
    stopWatch?.()
    stopWatch = null
    useConversionStore.setState({ rereading: false })
    return true
  }
  // Main pushes the filled queue before it answers, so a settled queue here had nothing to do.
  if (done(useIndexingStore.getState().status)) return
  stopWatch = useIndexingStore.subscribe((state) => {
    done(state.status)
  })
}

export const useConversionStore = create<ConversionState>((set) => ({
  conversion: null,
  converting: false,
  rereading: false,

  async convert() {
    const mine = generation
    set({ converting: true })
    try {
      const conversion = await ipc().invoke('knowledge:convert', undefined)
      if (mine !== generation) return
      set({ conversion })
      if (conversion.state === 'done') watchReread()
    } finally {
      if (mine === generation) set({ converting: false })
    }
  },

  async later() {
    const mine = generation
    const conversion = await ipc().invoke('knowledge:later', undefined)
    if (mine === generation) set({ conversion })
  },

  async retryReread() {
    const mine = generation
    await useIndexingStore.getState().resume()
    if (mine === generation) watchReread()
  },

  clear() {
    generation++
    stopWatch?.()
    stopWatch = null
    set({ conversion: null, converting: false, rereading: false })
  },

  subscribe() {
    unsubscribe ??= ipc().on('knowledge:conversionChanged', (conversion) => set({ conversion }))
  }
}))

/** Whether the dialog shows. */
export function conversionAsks(conversion: KnowledgeConversion | null): boolean {
  return conversion !== null && conversion.state === 'pending' && !conversion.deferred
}

/** Empties the store and drops the subscription. For tests only. */
export function resetConversionStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useConversionStore.getState().clear()
}
