import { create } from 'zustand'
import type { AiFeatureId } from '@shared/ai'
import { ipc } from '@renderer/lib/ipc'

export interface AiActivity {
  feature: AiFeatureId
  /** `Date.now()` when the request left; the header indicator shows it only after a short delay. */
  startedAt: number
}

/**
 * The renderer's one record of AI requests in flight (F-5.10): every caller wraps its IPC call
 * in `track`, so the header indicator knows what is running and Stop/Cancel buttons can find
 * the id. Cancelling only asks main to abort by the id the caller minted; the request's own
 * reply then comes back as the `CANCELLED` failure, and the caller handles it in silence.
 * App-wide, not per project (a request outlives nothing here: `track` removes it when the
 * promise settles either way).
 */
interface AiActivityState {
  inflight: Record<string, AiActivity>
  /** `Date.now()` when `inflight` last went from empty to busy; null while idle. The indicator's delay counts from here. */
  busySince: number | null
  /** Records `requestId` while `promise` is pending and hands the promise back, its result untouched. */
  track: <T>(feature: AiFeatureId, requestId: string, promise: Promise<T>) => Promise<T>
  /** Asks main to abort the request; true when it was still running. Never toasts: the caller's reply says what happened. */
  cancel: (requestId: string) => Promise<boolean>
}

export const useAiActivityStore = create<AiActivityState>((set) => ({
  inflight: {},
  busySince: null,

  track(feature, requestId, promise) {
    set((s) => {
      const now = Date.now()
      return {
        inflight: { ...s.inflight, [requestId]: { feature, startedAt: now } },
        busySince: s.busySince ?? now
      }
    })
    return promise.finally(() => {
      set((s) => {
        if (!(requestId in s.inflight)) return s
        const inflight = { ...s.inflight }
        delete inflight[requestId]
        return { inflight, busySince: Object.keys(inflight).length === 0 ? null : s.busySince }
      })
    })
  },

  async cancel(requestId) {
    try {
      const { cancelled } = await ipc().invoke('ai:cancel', { requestId })
      return cancelled
    } catch {
      // Best effort: the request settles on its own, and its reply carries the outcome.
      return false
    }
  }
}))

/** Forgets every request in flight. For tests only. */
export function resetAiActivityStore(): void {
  useAiActivityStore.setState({ inflight: {}, busySince: null })
}
