import { create } from 'zustand'
import type { BackupSettingsPatch, BackupState } from '@shared/backups'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'

/**
 * The renderer's view of automatic backups (F-8.4). Main owns the settings, the schedule, and
 * the files; this store holds the state main last answered or pushed through `backups:changed`.
 * A failed action lands in `error`, shown in the Backups tab beside the button that failed. A
 * failed automatic backup (scheduled or on close) arrives pushed with `lastError`, and is toasted
 * once per new cause: the author is usually writing, not looking at the tab.
 */
interface BackupStoreState {
  /** null until the first `load` resolves. */
  state: BackupState | null
  /** True while a backups channel is in flight; the tab disables its controls on it. */
  busy: boolean
  /** The message from the last failed action, cleared by the next one. */
  error: string | null
  load: () => Promise<void>
  setSettings: (patch: BackupSettingsPatch) => Promise<void>
  /** Picks the backup folder with main's dialog; a cancel changes nothing. */
  chooseFolder: () => Promise<void>
  /** Writes pending saves, then backs the open project up. */
  backUpNow: () => Promise<void>
  /** Opens the backup folder in the OS file manager. */
  reveal: () => Promise<void>
  /** Loads the state once and listens for what main pushes; returns the unsubscribe. */
  subscribe: () => () => void
}

/** Bumped by every reset so a response from a superseded request is dropped. */
let generation = 0

export const useBackupStore = create<BackupStoreState>((set, get) => {
  const run = async (call: () => Promise<BackupState | null>): Promise<void> => {
    const mine = generation
    set({ busy: true, error: null })
    try {
      const state = await call()
      if (mine !== generation) return
      if (state !== null) set({ state })
    } catch (err: unknown) {
      if (mine !== generation) return
      set({ error: describeError(err) })
    } finally {
      if (mine === generation) set({ busy: false })
    }
  }

  return {
    state: null,
    busy: false,
    error: null,

    load: () => run(() => ipc().invoke('backups:get', undefined)),

    setSettings: (patch) => run(() => ipc().invoke('backups:setSettings', { patch })),

    chooseFolder: () => run(() => ipc().invoke('backups:chooseFolder', undefined)),

    backUpNow: () =>
      run(async () => {
        await flushPendingSaves()
        return ipc().invoke('backups:now', undefined)
      }),

    reveal: () =>
      run(async () => {
        await ipc().invoke('backups:reveal', undefined)
        return null
      }),

    subscribe: () => {
      const off = ipc().on('backups:changed', (state) => {
        const before = get().state?.lastError ?? null
        if (state.lastError !== null && state.lastError !== before) {
          toast.error(`Automatic backup failed: ${state.lastError}`)
        }
        set({ state })
      })
      void get().load()
      return off
    }
  }
})

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetBackupStore(): void {
  generation++
  useBackupStore.setState({ state: null, busy: false, error: null })
}
