import { create } from 'zustand'
import type { ProvenanceReport } from '@shared/ipc/contract'
import { flushPendingSaves } from '@renderer/features/project/pendingSaves'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer owner of the provenance report (F-14.6): loaded by the Provenance section on
 * mount (local and cheap in main) and held until the next load or the project closes. Main
 * reads the saved rows, so both `load` and `exportReport` flush pending saves first; a report
 * that ignored the last minute of typing would understate the author's edits. Per project:
 * `clear` on close. The generation counter drops a response from a superseded request.
 */
interface ProvenanceState {
  /** null until the first `load` resolves. */
  report: ProvenanceReport | null
  load: () => Promise<void>
  /** Writes the disclosure where the author picks; resolves to the path, or null when they cancel. */
  exportReport: () => Promise<string | null>
  clear: () => void
}

/** Bumped by every clear so a response from a superseded request is dropped. */
let generation = 0

/** The report as main computes it after the pending saves are flushed (main reads saved rows). */
async function loadReport(): Promise<ProvenanceReport> {
  await flushPendingSaves()
  return await ipc().invoke('provenance:report', undefined)
}

export const useProvenanceStore = create<ProvenanceState>((set) => ({
  report: null,

  async load() {
    const mine = generation
    let report: ProvenanceReport
    try {
      report = await loadReport()
    } catch (err) {
      // A request the project close or a reset superseded must not surface as a toast.
      if (mine !== generation) return
      throw err
    }
    if (mine !== generation) return
    set({ report })
  },

  async exportReport() {
    await flushPendingSaves()
    const result = await ipc().invoke('provenance:export', undefined)
    return result?.path ?? null
  },

  clear() {
    generation++
    set({ report: null })
  }
}))

/** Empties the store and invalidates in-flight requests. For tests only. */
export function resetProvenanceStore(): void {
  useProvenanceStore.getState().clear()
}
