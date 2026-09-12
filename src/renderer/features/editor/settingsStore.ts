import { create } from 'zustand'
import { EditorSettings, defaultEditorSettings } from '@shared/editorSettings'
import type { NovelFormat } from '@shared/ipc/contract'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/** How long after the last change the debounced `editorSettings:set` fires (F-3.6). */
export const SETTINGS_SAVE_DELAY_MS = 150

/**
 * The one owner of the project's editor formatting (F-3.6). `update` applies a change at once
 * (the editor previews it live) and persists it after a short debounce, so dragging a number
 * input writes once, not per step. A failed write reverts to the last persisted value and toasts.
 * The debounce timer and the "value before the pending write" live at module level so an
 * unmounting panel can never orphan a write; the pending-save registry flushes it before the
 * project closes.
 */
interface EditorSettingsState {
  /** The loaded settings; null until `load` resolves (the hook falls back to the format defaults). */
  settings: EditorSettings | null
  load: () => Promise<void>
  /** Merges `patch` into the settings at once and schedules the write. Ignored when nothing is loaded or the result is out of range. */
  update: (patch: Partial<EditorSettings>) => void
  /** Cancels any pending write, unregisters from the registry, and empties the store. */
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: EditorSettings | null = null
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
  const value = useEditorSettingsStore.getState().settings
  const revertTo = persisted
  persisted = null
  if (value === null || revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('editorSettings:set', value)
  } catch (err) {
    if (mine !== generation) return // the project closed meanwhile; nothing to revert
    if (persisted !== null)
      persisted = revertTo // a newer change is pending; it inherits the baseline
    else useEditorSettingsStore.setState({ settings: revertTo })
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

export const useEditorSettingsStore = create<EditorSettingsState>((set, get) => ({
  settings: null,

  async load() {
    unregister ??= registerPendingSave(flush)
    const mine = ++generation
    const value = await ipc().invoke('editorSettings:get', undefined)
    if (mine !== generation) return
    set({ settings: value })
  },

  update(patch) {
    const base = get().settings
    if (base === null) return
    const next = EditorSettings.safeParse({ ...base, ...patch })
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

/** The settings to apply: the loaded ones, or the format's defaults until they arrive. */
export function useEditorSettings(format: NovelFormat): EditorSettings {
  const settings = useEditorSettingsStore((s) => s.settings)
  return settings ?? defaultEditorSettings(format)
}

/** Drops the timer, the revert baseline, and the registration, then empties the store. For tests only. */
export function resetEditorSettingsStore(): void {
  useEditorSettingsStore.getState().clear()
}
