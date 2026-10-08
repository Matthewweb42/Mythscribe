import { create } from 'zustand'
import type { EventPayload } from '@shared/ipc/contract'
import { planLinkKey, type PlanLinkSuggestion, type PlanRef } from '@shared/planLinks'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { useSceneMetaStore } from '@renderer/features/editor/sceneMetaStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'

/**
 * The renderer's view of the plan links (F-11.1d). Main owns them: the links themselves live in
 * the scene metadata (`fulfilledBy` on a planned scene, `beats` on a written one), the waiting
 * suggestions and the AI-made marks in the project settings. This store holds the suggestions
 * and the AI-made keys, asks main to run the job now (Find links), and confirms, dismisses, or
 * unlinks. Every write flushes pending metadata first and reloads the nodes main rewrote into
 * `useSceneMetaStore`, so no queued autosave writes the old metadata back (the timeline's
 * pattern). The background job's `planLinks:changed` does the same. Loaded by the Outline tab,
 * cleared on project close (`App.tsx`); generation-guarded.
 */
interface PlanLinksState {
  suggestions: readonly PlanLinkSuggestion[]
  /** `planLinkKey`s the job applied itself at Auto: the outline marks them as AI-made. */
  aiApplied: readonly string[]
  /** True while Find links runs. */
  running: boolean
  load: () => Promise<void>
  /** Runs the plan-link job now; toasts what it found. */
  run: () => Promise<void>
  confirm: (key: string) => Promise<void>
  dismiss: (key: string) => Promise<void>
  unlink: (plan: PlanRef) => Promise<void>
  clear: () => void
}

let generation = 0
let unsubscribe: (() => void) | null = null
let counter = 0
const nextRequestId = (): string => `plan-${Date.now().toString(36)}-${++counter}`

/** The background job stored suggestions or applied links: refetch, and reload what it rewrote. */
function onChanged({ changedNodeIds }: EventPayload<'planLinks:changed'>): void {
  void useSceneMetaStore.getState().reload(changedNodeIds)
  void usePlanLinksStore.getState().load()
}

/** Flushes pending metadata, runs `write`, then reloads the nodes it rewrote and the view. */
async function rewrite(write: () => Promise<{ changedNodeIds: string[] }>): Promise<void> {
  const mine = generation
  try {
    const metas = useSceneMetaStore.getState()
    await metas.flush()
    const result = await write()
    if (mine !== generation) return
    await metas.reload(result.changedNodeIds)
    await usePlanLinksStore.getState().load()
  } catch (err) {
    if (mine !== generation) return
    toast.error(describeError(err))
    await usePlanLinksStore.getState().load()
  }
}

export const usePlanLinksStore = create<PlanLinksState>((set, get) => ({
  suggestions: [],
  aiApplied: [],
  running: false,

  async load() {
    unsubscribe ??= ipc().on('planLinks:changed', onChanged)
    const mine = ++generation
    try {
      const view = await ipc().invoke('planLinks:get', undefined)
      if (mine !== generation) return
      set({ suggestions: view.suggestions, aiApplied: view.aiApplied })
    } catch (err) {
      if (mine === generation) toast.error(describeError(err))
    }
  },

  async run() {
    if (get().running) return
    set({ running: true })
    const requestId = nextRequestId()
    await rewrite(async () => {
      const result = await useAiActivityStore
        .getState()
        .track('planLinks', requestId, ipc().invoke('planLinks:run', { requestId }))
      if (!result.requested) toast.info('No open plan or summarized scene to link yet.')
      else if (result.applied > 0)
        toast.info(`Linked ${result.applied} ${result.applied === 1 ? 'plan' : 'plans'}.`)
      else if (result.suggested > 0)
        toast.info(
          `${result.suggested} suggested ${result.suggested === 1 ? 'link' : 'links'} in the outline.`
        )
      else toast.info('No plan matched a written scene.')
      return result
    })
    set({ running: false })
  },

  confirm(key) {
    return rewrite(() => ipc().invoke('planLinks:confirm', { key }))
  },

  async dismiss(key) {
    set((s) => ({ suggestions: s.suggestions.filter((link) => planLinkKey(link) !== key) }))
    await rewrite(async () => {
      await ipc().invoke('planLinks:dismiss', { key })
      return { changedNodeIds: [] }
    })
  },

  unlink(plan) {
    return rewrite(() => ipc().invoke('planLinks:unlink', { plan }))
  },

  clear() {
    generation++
    set({ suggestions: [], aiApplied: [], running: false })
  }
}))

/** Empties the store and drops the subscription. For tests only. */
export function resetPlanLinksStore(): void {
  unsubscribe?.()
  unsubscribe = null
  counter = 0
  usePlanLinksStore.getState().clear()
}
