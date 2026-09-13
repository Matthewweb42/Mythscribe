import { create } from 'zustand'
import { AiSettings } from '@shared/aiSettings'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's AI dial and per-feature toggles (F-14.4), the editor-settings
 * pattern retargeted: `update` applies a change at once and persists it after the shared
 * debounce; a failed write reverts to the last persisted value and toasts. The debounce timer
 * and the revert baseline live at module level so a closing dialog can never orphan a write;
 * the pending-save registry flushes it before the project closes. Loaded with the tree on
 * project open and cleared on close (`App.tsx`), so the AI tab only reads it.
 */
interface AiSettingsState {
  /** The loaded settings; null until `load` resolves (the panel renders nothing until then). */
  settings: AiSettings | null
  load: () => Promise<void>
  /** Merges `patch` into the settings at once and schedules the write. Ignored when nothing is loaded or the result does not parse. */
  update: (patch: Partial<AiSettings>) => void
  /** Cancels any pending write, unregisters from the registry, and empties the store. */
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: AiSettings | null = null
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
  const value = useAiSettingsStore.getState().settings
  const revertTo = persisted
  persisted = null
  if (value === null || revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('aiSettings:set', value)
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to revert
    if (persisted !== null)
      persisted = revertTo // a newer change is pending; it inherits the baseline
    else useAiSettingsStore.setState({ settings: revertTo })
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

export const useAiSettingsStore = create<AiSettingsState>((set, get) => ({
  settings: null,

  async load() {
    unregister ??= registerPendingSave(flush)
    const mine = ++generation
    const value = await ipc().invoke('aiSettings:get', undefined)
    if (mine !== generation) return
    set({ settings: value })
  },

  update(patch) {
    const base = get().settings
    if (base === null) return
    const next = AiSettings.safeParse({ ...base, ...patch })
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
    set({ settings: null })
  }
}))

/** Drops the timer, the revert baseline, and the registration, then empties the store. For tests only. */
export function resetAiSettingsStore(): void {
  useAiSettingsStore.getState().clear()
}
