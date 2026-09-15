import { create } from 'zustand'
import { AuthorRules } from '@shared/authorRules'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useVoiceStore } from './voiceStore'

/**
 * The one owner of the project's author rules and banned phrases (F-14.2), the AI-settings
 * pattern retargeted: `update` applies a change at once and persists it after the shared
 * debounce; a failed write reverts to the last persisted value and toasts. The debounce timer
 * and the revert baseline live at module level so a closing dialog can never orphan a write;
 * the pending-save registry flushes it before the project closes. Loaded with the tree on
 * project open and cleared on close (`App.tsx`), so the AI tab only reads it. The rules are
 * part of the voice profile, so a successful write refreshes the profile when one is held.
 */
interface AuthorRulesState {
  /** The loaded rules; null until `load` resolves (the section renders nothing until then). */
  settings: AuthorRules | null
  load: () => Promise<void>
  /** Merges `patch` into the rules at once and schedules the write. Ignored when nothing is loaded or the result does not parse. */
  update: (patch: Partial<AuthorRules>) => void
  /** Cancels any pending write, unregisters from the registry, and empties the store. */
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: AuthorRules | null = null
/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0
let unregister: (() => void) | null = null

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

/** Writes the current rules now. The revert baseline survives a failure of a later write. */
async function write(): Promise<void> {
  cancelTimer()
  const value = useAuthorRulesStore.getState().settings
  const revertTo = persisted
  persisted = null
  if (value === null || revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('authorRules:set', value)
    if (mine !== generation) return // the project closed meanwhile
    // The rules are the third source of the voice profile (PLAN.md §2.1), so a held profile is stale now.
    if (useVoiceStore.getState().profile !== null)
      useVoiceStore.getState().loadProfile().catch(reportFailure)
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to revert
    if (persisted !== null)
      persisted = revertTo // a newer change is pending; it inherits the baseline
    else useAuthorRulesStore.setState({ settings: revertTo })
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

export const useAuthorRulesStore = create<AuthorRulesState>((set, get) => ({
  settings: null,

  async load() {
    unregister ??= registerPendingSave(flush)
    const mine = ++generation
    const value = await ipc().invoke('authorRules:get', undefined)
    if (mine !== generation) return
    set({ settings: value })
  },

  update(patch) {
    const base = get().settings
    if (base === null) return
    const next = AuthorRules.safeParse({ ...base, ...patch })
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
export function resetAuthorRulesStore(): void {
  useAuthorRulesStore.getState().clear()
}
