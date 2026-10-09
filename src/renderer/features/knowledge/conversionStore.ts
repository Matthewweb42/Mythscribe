import { create } from 'zustand'
import type { KnowledgeConversion } from '@shared/knowledge'
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
  /** Update now: backup, go-ahead, queue. Rejects with main's refusal (a failed backup). */
  convert: () => Promise<void>
  /** Later: closed until the project opens again. */
  later: () => Promise<void>
  clear: () => void
  /** Opens the one subscription (idempotent); call it where the project opens. */
  subscribe: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null

export const useConversionStore = create<ConversionState>((set) => ({
  conversion: null,
  converting: false,

  async convert() {
    const mine = generation
    set({ converting: true })
    try {
      const conversion = await ipc().invoke('knowledge:convert', undefined)
      if (mine === generation) set({ conversion })
    } finally {
      if (mine === generation) set({ converting: false })
    }
  },

  async later() {
    const mine = generation
    const conversion = await ipc().invoke('knowledge:later', undefined)
    if (mine === generation) set({ conversion })
  },

  clear() {
    generation++
    set({ conversion: null, converting: false })
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
