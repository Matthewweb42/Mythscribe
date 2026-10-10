import { create } from 'zustand'
import {
  StoryBibleSettings,
  defaultStoryBibleSettings,
  type BibleListView
} from '@shared/storyBibleSettings'
import { SETTINGS_SAVE_DELAY_MS } from '@renderer/features/editor/settingsStore'
import { registerPendingSave } from '@renderer/features/project/pendingSaves'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's story-bible settings in the renderer (F-9.17, F-9.19): the
 * List/Cards choice every category tab shares, the view a new sheet opens in, and the write-up
 * style per category. The author-rules pattern: `update` applies a change at once and persists it
 * after the shared debounce; a failed write reverts to the last persisted value and toasts. The
 * timer and the revert baseline live at module level so a closing dialog can never orphan a
 * write; the pending-save registry flushes it before the project closes. Loaded on project open
 * and cleared on close (`App.tsx`). Until it loads, the defaults stand in (`useBibleListView`).
 */
interface StoryBibleSettingsState {
  /** The loaded settings; null until `load` resolves. */
  settings: StoryBibleSettings | null
  load: () => Promise<void>
  /** Merges `patch` at once and schedules the write. Ignored when nothing is loaded or the result does not parse. */
  update: (patch: Partial<StoryBibleSettings>) => void
  /** Writes a pending change now (the Settings tab before a field change that reads the style). */
  flush: () => Promise<void>
  clear: () => void
}

let timer: ReturnType<typeof setTimeout> | null = null
/** The last persisted value while a write is pending or in flight; null when the store is in sync. */
let persisted: StoryBibleSettings | null = null
let generation = 0
let unregister: (() => void) | null = null

function cancelTimer(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
}

async function write(): Promise<void> {
  cancelTimer()
  const value = useStoryBibleSettingsStore.getState().settings
  const revertTo = persisted
  persisted = null
  if (value === null || revertTo === null) return
  const mine = generation
  try {
    await ipc().invoke('storyBible:set', value)
  } catch (err) {
    if (mine !== generation) return
    if (persisted !== null) persisted = revertTo
    else useStoryBibleSettingsStore.setState({ settings: revertTo })
    throw err
  }
}

const reportFailure = (err: unknown): void => {
  toast.error(describeError(err))
}

async function flushPending(): Promise<void> {
  if (persisted === null) return
  await write()
}

export const useStoryBibleSettingsStore = create<StoryBibleSettingsState>((set, get) => ({
  settings: null,

  async load() {
    unregister ??= registerPendingSave(flushPending)
    const mine = ++generation
    const value = await ipc().invoke('storyBible:get', undefined)
    if (mine !== generation) return
    set({ settings: value })
  },

  update(patch) {
    const base = get().settings
    if (base === null) return
    const next = StoryBibleSettings.safeParse({ ...base, ...patch })
    if (!next.success) return
    persisted ??= base
    set({ settings: next.data })
    cancelTimer()
    timer = setTimeout(() => {
      write().catch(reportFailure)
    }, SETTINGS_SAVE_DELAY_MS)
  },

  async flush() {
    await flushPending()
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

/** F-9.17: the List/Cards choice every category tab shares; cards until the settings load. */
export function useBibleListView(): BibleListView {
  return useStoryBibleSettingsStore((s) => s.settings?.listView ?? 'cards')
}

/** The settings as they stand, or the defaults while none are loaded (outside React). */
export function storyBibleSettingsNow(): StoryBibleSettings {
  return useStoryBibleSettingsStore.getState().settings ?? defaultStoryBibleSettings()
}

/** Drops the timer, the revert baseline, and the registration, then empties the store. For tests only. */
export function resetStoryBibleSettingsStore(): void {
  useStoryBibleSettingsStore.getState().clear()
}
