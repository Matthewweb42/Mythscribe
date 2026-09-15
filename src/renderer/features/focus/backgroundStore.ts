import { create } from 'zustand'
import { FocusSettings, type Background } from '@shared/focus'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's focus-mode backgrounds (F-6.2): the uploaded images and the
 * settings that name the current one. The settings follow the presets pattern: `select`
 * applies at once and persists after the shared debounce, a failed write reverts to the last
 * persisted value and toasts, and the pending-save registry flushes it before the project
 * closes. `add` and `remove` await main and merge what it answers, never re-list. Loaded with
 * the tree on project open and cleared on close (`App.tsx`).
 */
interface BackgroundState {
  /** The uploaded backgrounds, by name as `background:list` orders them. */
  backgrounds: Background[]
  /** The loaded settings; null until `load` resolves. */
  settings: FocusSettings | null
  load: () => Promise<void>
  /** Opens the OS file dialog and adds what was chosen; toasts the skipped names. */
  add: () => Promise<void>
  /** Deletes a background; when it was the current one the selection becomes none (main clears it too). */
  remove: (id: string) => Promise<void>
  /** Makes `id` (or none) the current background at once and schedules the write. */
  select: (id: string | null) => void
  /** Cancels any pending write, unregisters from the registry, and empties the store. */
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: FocusSettings | null = null
/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
let unregister: (() => void) | null = null

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** Writes the current settings now. The revert baseline survives a failure of a later write. */
async function write(): Promise<void> {
  cancelTimer()
  const value = useBackgroundStore.getState().settings
  const revertTo = persisted
  persisted = null
  if (value === null || revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('focusSettings:set', value)
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to revert
    if (persisted !== null)
      persisted = revertTo // a newer change is pending; it inherits the baseline
    else useBackgroundStore.setState({ settings: revertTo })
    throw err
  }
}

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

/** Writes a pending change at once, or nothing when the store is in sync. Used by the pending-save registry. */
async function flush(): Promise<void> {
  if (persisted === null) return
  await write()
}

const byName = (a: Background, b: Background): number => a.name.localeCompare(b.name)

export const useBackgroundStore = create<BackgroundState>((set, get) => ({
  backgrounds: [],
  settings: null,

  async load() {
    unregister ??= registerPendingSave(flush)
    const mine = ++generation
    const [settings, backgrounds] = await Promise.all([
      ipc().invoke('focusSettings:get', undefined),
      ipc().invoke('background:list', undefined)
    ])
    if (mine !== generation) return
    set({ settings, backgrounds })
  },

  async add() {
    const mine = generation
    const result = await ipc().invoke('background:add', undefined)
    if (result === null || mine !== generation) return
    if (result.added.length > 0) {
      set((s) => ({ backgrounds: [...s.backgrounds, ...result.added].sort(byName) }))
    }
    if (result.skipped.length > 0) {
      toast.warning(`Skipped (not an image under 20 MB): ${result.skipped.join(', ')}`)
    }
  },

  async remove(id) {
    const mine = generation
    await ipc().invoke('background:remove', { id })
    if (mine !== generation) return
    set((s) => ({
      backgrounds: s.backgrounds.filter((b) => b.id !== id),
      // Main cleared the stored selection with the file; mirror it without another write.
      settings:
        s.settings !== null && s.settings.backgroundId === id
          ? { ...s.settings, backgroundId: null }
          : s.settings
    }))
  },

  select(id) {
    const base = get().settings
    if (base === null) return
    const next = FocusSettings.safeParse({ ...base, backgroundId: id })
    if (!next.success) return
    persisted ??= base
    set({ settings: next.data })
    cancelTimer()
    timer = setTimeout(() => {
      write().catch(reportFailure)
    }, SETTINGS_SAVE_DELAY_MS)
  },

  clear() {
    generation++
    cancelTimer()
    persisted = null
    unregister?.()
    unregister = null
    set({ backgrounds: [], settings: null })
  }
}))

/** The current background's record, or null when none is selected or its file is gone. */
export function currentBackground(
  state: Pick<BackgroundState, 'backgrounds' | 'settings'>
): Background | null {
  const id = state.settings?.backgroundId ?? null
  if (id === null) return null
  return state.backgrounds.find((b) => b.id === id) ?? null
}

/** The current background as a subscription, for the backdrop and the Settings summary. */
export function useCurrentBackground(): Background | null {
  return useBackgroundStore(currentBackground)
}

/** Drops the timer, the revert baseline, and the registration, then empties the store. For tests only. */
export function resetBackgroundStore(): void {
  useBackgroundStore.getState().clear()
}
