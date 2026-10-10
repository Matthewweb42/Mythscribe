import { create } from 'zustand'
import { canWrite, extrasUnlocked, type AppAccess } from '@shared/appAccess'
import { ipc } from '@renderer/lib/ipc'

/**
 * The app's access as main owns it (AI-BILLING-SPEC M1): the 30-day trial, the license, or
 * read-only after the trial. Loaded once by `App` and kept current by `app:accessChanged`, which
 * main pushes when the trial ends or a license is verified or dropped. The renderer only shows
 * it: main refuses the writes itself (`channelAccess.ts`).
 */
interface AppAccessState {
  /** Null until main has answered; read as writable until then (`canWrite`). */
  access: AppAccess | null
  load: () => Promise<void>
  /** Listens for `app:accessChanged`; returns the unsubscribe. */
  subscribe: () => () => void
}

export const useAppAccessStore = create<AppAccessState>((set) => ({
  access: null,
  load: async () => {
    const access = await ipc().invoke('app:getAccess', undefined)
    set({ access })
  },
  subscribe: () => ipc().on('app:accessChanged', (access) => set({ access }))
}))

/** Whether the open project may change; false only after the trial without the license. */
export function useCanWrite(): boolean {
  return useAppAccessStore((s) => canWrite(s.access))
}

/**
 * Whether Sepia, custom themes, and the accent colours are on: during the trial and with the
 * license, not after the trial ends unpaid (changed by the author 2026-10-10).
 */
export function useExtrasUnlocked(): boolean {
  return useAppAccessStore((s) => extrasUnlocked(s.access))
}

/** Empties the store. For tests only. */
export function resetAppAccessStore(): void {
  useAppAccessStore.setState({ access: null })
}
