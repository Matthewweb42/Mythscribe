import { create } from 'zustand'
import type { SceneDetails, SceneDetailsView } from '@shared/memory/sceneDetails'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc, IpcRequestError } from '@renderer/lib/ipc'

/**
 * Typed scene details in the renderer (F-16.11, story memory v2): the one owner of each loaded
 * scene's POV, place, time, story year and "+ also here", which point at records. A save is
 * optimistic: the pane shows the new details at once, main's answer replaces them, and a refusal
 * puts the last saved ones back (and propagates). Only the newest save of a scene may land, so a
 * slow answer never undoes a quicker click. A roster change (`record:changed`: a merge re-points
 * details, a delete leaves a "+ also here" id gone) reads the loaded scenes again.
 */
interface SceneDetailState {
  docs: Record<string, SceneDetailsView>
  /** Reads a scene's details (again). */
  load: (nodeId: string) => Promise<void>
  save: (nodeId: string, details: SceneDetails) => Promise<void>
  /** Opens the `record:changed` subscription (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  clear: () => void
}

let generation = 0
/** The newest save per scene: an older answer never lands over it. */
const latest = new Map<string, number>()
let saves = 0
let unsubscribe: (() => void) | null = null

export const useSceneDetailStore = create<SceneDetailState>((set, get) => ({
  docs: {},

  async load(nodeId) {
    const mine = generation
    const view = await ipc().invoke('sceneDetail:get', { nodeId })
    // A save sent meanwhile is newer than this read.
    if (mine !== generation || latest.has(nodeId)) return
    set({ docs: { ...get().docs, [nodeId]: view } })
  },

  async save(nodeId, details) {
    const mine = generation
    const ticket = ++saves
    latest.set(nodeId, ticket)
    const before = get().docs[nodeId]
    set({ docs: { ...get().docs, [nodeId]: { ...details, gone: before?.gone ?? [] } } })
    const settle = (): boolean => {
      const newest = latest.get(nodeId) === ticket
      if (newest) latest.delete(nodeId)
      return newest && mine === generation
    }
    try {
      const view = await ipc().invoke('sceneDetail:set', { nodeId, details })
      if (settle()) set({ docs: { ...get().docs, [nodeId]: view } })
    } catch (err) {
      if (settle() && before !== undefined) set({ docs: { ...get().docs, [nodeId]: before } })
      throw err
    }
  },

  subscribe() {
    unsubscribe ??= ipc().on('record:changed', () => {
      for (const nodeId of Object.keys(get().docs)) {
        get()
          .load(nodeId)
          .catch((err: unknown) => {
            // A scene deleted meanwhile has no details to show any more.
            if (err instanceof IpcRequestError && err.code === 'NOT_FOUND') {
              const docs = { ...get().docs }
              delete docs[nodeId]
              set({ docs })
            } else toast.error(describeError(err))
          })
      }
    })
  },

  clear() {
    generation++
    latest.clear()
    set({ docs: {} })
  }
}))

/** Closes the subscription and empties the store. For tests and project close. */
export function resetSceneDetailStore(): void {
  unsubscribe?.()
  unsubscribe = null
  useSceneDetailStore.getState().clear()
}
