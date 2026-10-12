import { create } from 'zustand'
import type { NamedInRow, NameMentionView } from '@shared/memory/nameScan'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * Where the book names its records (F-16.5, F-16.6; story memory v2), as main's local name scan
 * last recorded it: the one owner of the per-scene counts (*Named in* on a sheet, "named in N
 * scenes" in the lists) and of the mentions of the scenes a view asked for. Main pushes
 * `names:changed` after a scan (the counts and the scenes it names are read again) and
 * `record:changed` after a roster change (a merge, split or delete re-points or drops mentions
 * without a scan): only the counts and loaded scenes naming one of its records are read again.
 */
interface NameMentionState {
  /** One row per record and scene, certain mentions only. */
  namedIn: NamedInRow[]
  loaded: boolean
  /** The mentions of the scenes loaded so far, in document order. */
  byNode: Record<string, NameMentionView[]>
  load: () => Promise<void>
  /** Reads one scene's mentions (again). */
  loadNode: (nodeId: string) => Promise<NameMentionView[]>
  /** Opens the `names:changed` and `record:changed` subscriptions (idempotent). */
  subscribe: () => void
  clear: () => void
}

/** The scenes naming one record, each with its count. */
export function namedInOf(
  rows: readonly NamedInRow[],
  recordId: string
): { nodeId: string; count: number }[] {
  return rows
    .filter((row) => row.recordId === recordId)
    .map((row) => ({ nodeId: row.nodeId, count: row.count }))
}

/** How many scenes name each record. */
export function sceneCounts(rows: readonly NamedInRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const row of rows) counts[row.recordId] = (counts[row.recordId] ?? 0) + 1
  return counts
}

let generation = 0
let offs: (() => void)[] = []

export const useNameMentionStore = create<NameMentionState>((set, get) => ({
  namedIn: [],
  loaded: false,
  byNode: {},

  async load() {
    const mine = generation
    const namedIn = await ipc().invoke('names:byRecord', undefined)
    if (mine !== generation) return
    set({ namedIn, loaded: true })
  },

  async loadNode(nodeId) {
    const mine = generation
    const mentions = await ipc().invoke('names:forNode', { nodeId })
    if (mine === generation) set({ byNode: { ...get().byNode, [nodeId]: mentions } })
    return mentions
  },

  subscribe() {
    if (offs.length > 0) return
    const failed = (err: unknown): void => {
      toast.error(describeError(err))
    }
    const refresh = (nodeIds: readonly string[]): void => {
      get().load().catch(failed)
      for (const nodeId of nodeIds) {
        if (get().byNode[nodeId] !== undefined) get().loadNode(nodeId).catch(failed)
      }
    }
    const rosterChanged = (recordIds: readonly string[]): void => {
      const changed = new Set(recordIds)
      const { namedIn, byNode } = get()
      if (namedIn.some((row) => changed.has(row.recordId))) get().load().catch(failed)
      for (const [nodeId, mentions] of Object.entries(byNode)) {
        if (mentions.some((mention) => changed.has(mention.recordId))) {
          get().loadNode(nodeId).catch(failed)
        }
      }
    }
    offs = [
      ipc().on('names:changed', ({ nodeIds }) => refresh(nodeIds)),
      ipc().on('record:changed', ({ recordIds, roster }) => {
        if (roster) rosterChanged(recordIds)
      })
    ]
  },

  clear() {
    generation++
    set({ namedIn: [], loaded: false, byNode: {} })
  }
}))

/** Closes the subscriptions and empties the store. For tests and project close. */
export function resetNameMentionStore(): void {
  for (const off of offs) off()
  offs = []
  useNameMentionStore.getState().clear()
}
