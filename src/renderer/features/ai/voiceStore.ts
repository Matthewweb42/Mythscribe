import { create } from 'zustand'
import type { VoiceConsistencyReport, VoiceExemplar, VoiceProfile } from '@shared/ipc/contract'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer owner of the voice profile (F-14.1): the project's exemplars (loaded with the
 * project by `App.tsx`, so the toolbar button knows the count before the AI tab ever opens)
 * and the last built profile (loaded by the Voice section on mount; it is cheap and local, and
 * main caches it). `add` and `remove` merge main's answer into the list instead of re-listing,
 * then refresh the profile if one is held, since the exemplars are part of it. The consistency
 * report (F-14.7) is loaded on demand by the section's button and held until the next load or
 * the project closes. Per project: `clear` on close. The generation counter drops a response
 * from a superseded request.
 */
interface VoiceState {
  /** null until the first `load` resolves. */
  exemplars: VoiceExemplar[] | null
  /** null until the first `loadProfile` resolves. */
  profile: VoiceProfile | null
  /** null until the first `loadReport` resolves (F-14.7). */
  report: VoiceConsistencyReport | null
  load: () => Promise<void>
  loadProfile: () => Promise<void>
  loadReport: () => Promise<void>
  /** Marks a passage; resolves to the new exemplar once the list holds it, so the caller can toast the count. */
  add: (nodeId: string, text: string) => Promise<VoiceExemplar>
  remove: (id: string) => Promise<void>
  clear: () => void
}

/** Bumped by every clear so a response from a superseded request is dropped. */
let generation = 0

export const useVoiceStore = create<VoiceState>((set, get) => ({
  exemplars: null,
  profile: null,
  report: null,

  async load() {
    const mine = generation
    const exemplars = await ipc().invoke('voice:listExemplars', undefined)
    if (mine !== generation) return
    set({ exemplars })
  },

  async loadProfile() {
    const mine = generation
    const profile = await ipc().invoke('voice:profile', {})
    if (mine !== generation) return
    set({ profile })
  },

  async loadReport() {
    const mine = generation
    const report = await ipc().invoke('voice:consistencyReport', {})
    if (mine !== generation) return
    set({ report })
  },

  async add(nodeId, text) {
    const mine = generation
    const exemplar = await ipc().invoke('voice:addExemplar', { nodeId, text })
    if (mine === generation) {
      set((s) => ({ exemplars: [...(s.exemplars ?? []), exemplar] }))
      if (get().profile !== null) void get().loadProfile()
    }
    return exemplar
  },

  async remove(id) {
    const mine = generation
    await ipc().invoke('voice:removeExemplar', { id })
    if (mine !== generation) return
    set((s) => ({ exemplars: (s.exemplars ?? []).filter((e) => e.id !== id) }))
    if (get().profile !== null) void get().loadProfile()
  },

  clear() {
    generation++
    set({ exemplars: null, profile: null, report: null })
  }
}))

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetVoiceStore(): void {
  useVoiceStore.getState().clear()
}
