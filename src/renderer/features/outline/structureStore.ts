import { create } from 'zustand'
import type { StructureTemplateId } from '@shared/structure'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The one owner of the project's structure template (F-11.1b): which act/beat template the
 * Outline tab lays the manuscript against, or none. A choice from a select, so `setTemplate`
 * applies at once and writes at once (no debounce); a failed write reverts to the previous
 * template and toasts. Loaded on project open and cleared on close (`App.tsx`). The beat each
 * node sits on lives in its scene metadata (`SceneMeta.beats`), not here.
 */
interface StructureState {
  template: StructureTemplateId | null
  /** False until `load` resolves; the Outline tab shows no structure controls until then. */
  loaded: boolean
  load: () => Promise<void>
  setTemplate: (template: StructureTemplateId | null) => Promise<void>
  clear: () => void
}

/** Bumped by every load() and clear() so a response from a superseded request is dropped. */
let generation = 0

export const useStructureStore = create<StructureState>((set, get) => ({
  template: null,
  loaded: false,

  async load() {
    const mine = ++generation
    const value = await ipc().invoke('structure:get', undefined)
    if (mine !== generation) return
    set({ template: value.template, loaded: true })
  },

  async setTemplate(template) {
    const previous = get().template
    if (!get().loaded || previous === template) return
    const mine = generation
    set({ template })
    try {
      await ipc().invoke('structure:set', { template })
    } catch (err) {
      if (mine !== generation) return // the project closed meanwhile; nothing to revert
      if (get().template === template) set({ template: previous })
      toast.error(describeError(err))
    }
  },

  clear() {
    generation++
    set({ template: null, loaded: false })
  }
}))

/** Empties the store and drops any response in flight. For tests only. */
export function resetStructureStore(): void {
  useStructureStore.getState().clear()
}
