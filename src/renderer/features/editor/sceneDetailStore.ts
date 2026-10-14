import { create } from 'zustand'
import { detailsOf, type SceneDetails, type SceneDetailsView } from '@shared/memory/sceneDetails'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc, IpcRequestError } from '@renderer/lib/ipc'

/**
 * Typed scene details in the renderer (F-16.11, story memory v2): the one owner of each loaded
 * scene's POV, place, time, story year, "+ also here", which point at records, and the Flashback
 * switch. A save is optimistic: the pane shows the new details at once, main's answer replaces
 * them, and a refusal puts the last saved ones back (and propagates). Only the newest save of a
 * scene may land, so a slow answer never undoes a quicker click. A roster change (`record:changed`
 * with `roster`: a merge re-points details, a delete leaves a "+ also here" id gone) reads again
 * only the loaded scenes whose details name one of its records.
 */
interface SceneDetailState {
  docs: Record<string, SceneDetailsView>
  /** Reads a scene's details (again). */
  load: (nodeId: string) => Promise<void>
  save: (nodeId: string, details: SceneDetails) => Promise<void>
  /**
   * Sets the scene's Flashback switch (true, false, or null to follow the book) over its details
   * as stored, reading them first when they are not loaded; answers the switch as it was (for
   * *Undo*). *Check the book*'s *Not a flashback?* sets it to false (2026-10-14).
   */
  setFlashback: (nodeId: string, flashback: boolean | null) => Promise<boolean | null>
  /** Opens the `record:changed` subscription (idempotent); call it where a v2 project opens. */
  subscribe: () => void
  clear: () => void
}

/** Whether a scene's details point at any of these records (POV, place, "+ also here"). */
export function namesAny(view: SceneDetailsView, recordIds: ReadonlySet<string>): boolean {
  return [view.povRecordId, view.place.recordId, ...view.alsoHere, ...view.gone].some(
    (id) => id !== null && recordIds.has(id)
  )
}

let generation = 0
/**
 * The newest save per scene, kept until `clear`: neither an older save's answer nor a read sent
 * before it ever lands over it, whatever order the answers come in.
 */
const latest = new Map<string, number>()
let saves = 0
let unsubscribe: (() => void) | null = null

export const useSceneDetailStore = create<SceneDetailState>((set, get) => ({
  docs: {},

  async load(nodeId) {
    const mine = generation
    const before = latest.get(nodeId)
    const view = await ipc().invoke('sceneDetail:get', { nodeId })
    // A save sent meanwhile is newer than this read.
    if (mine !== generation || latest.get(nodeId) !== before) return
    set({ docs: { ...get().docs, [nodeId]: view } })
  },

  async save(nodeId, details) {
    const mine = generation
    const ticket = ++saves
    latest.set(nodeId, ticket)
    const before = get().docs[nodeId]
    set({ docs: { ...get().docs, [nodeId]: { ...details, gone: before?.gone ?? [] } } })
    const settle = (): boolean => latest.get(nodeId) === ticket && mine === generation
    try {
      const view = await ipc().invoke('sceneDetail:set', { nodeId, details })
      if (settle()) set({ docs: { ...get().docs, [nodeId]: view } })
    } catch (err) {
      if (settle() && before !== undefined) set({ docs: { ...get().docs, [nodeId]: before } })
      throw err
    }
  },

  async setFlashback(nodeId, flashback) {
    if (get().docs[nodeId] === undefined) await get().load(nodeId)
    const view = get().docs[nodeId] ?? (await ipc().invoke('sceneDetail:get', { nodeId }))
    await get().save(nodeId, { ...detailsOf(view), flashback })
    return view.flashback
  },

  subscribe() {
    unsubscribe ??= ipc().on('record:changed', ({ recordIds, roster }) => {
      if (!roster) return
      const changed = new Set(recordIds)
      for (const [nodeId, view] of Object.entries(get().docs)) {
        if (!namesAny(view, changed)) continue
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
