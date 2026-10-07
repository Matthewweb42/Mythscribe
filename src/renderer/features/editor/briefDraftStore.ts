import { create } from 'zustand'
import type { AiUsage } from '@shared/ai'
import type { SceneBrief } from '@shared/sceneMeta'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { patchSceneMeta } from './sceneMetaStore'

let requestCounter = 0
/** A request id `ai:cancel` can find (F-5.10). */
const nextRequestId = (): string => `b-${Date.now().toString(36)}-${++requestCounter}`

/**
 * One brief draft (F-14.3), for the node it was asked for. A `done` draft is a proposal
 * (F-14.5) the author settles: Use draft fills the five fields and settles it accepted, Discard
 * settles it rejected. The pending state carries the request id its Cancel button stops (F-5.10).
 */
export type BriefDraftState =
  | { nodeId: string; status: 'pending'; requestId: string }
  | {
      nodeId: string
      status: 'done'
      proposalId: string
      brief: SceneBrief
      truncated: boolean
      model: string
      costUsd: number
      /** The tokens the request spent, for the cost line (F-5.9). */
      usage: AiUsage
      cached: boolean
    }
  | { nodeId: string; status: 'error'; message: string; nextStep: string }

/**
 * The draft-with-AI flow of the brief (F-14.3), app-wide since 2026-10-06: started from the
 * assistant's actions menu (it left the Scene details disclosure with every other AI button) and
 * shown in the assistant panel's results. One draft at a time; starting one for another node
 * discards a draft still on screen. The request goes through the activity store so the header
 * indicator and Cancel can find it; the gate (dial, toggle, text length) is the menu's.
 */
interface BriefDraftStoreState {
  draft: BriefDraftState | null
  /** Flushes the document, then asks main for a draft of `nodeId`'s brief; ignored while one is pending. */
  start: (nodeId: string) => void
  /** Stops the pending request; the draft goes when its cancelled reply lands. */
  cancel: () => void
  /** Fills the five fields through the scene-metadata autosave store and settles the proposal accepted. */
  accept: () => Promise<void>
  /** Drops the draft and settles the proposal rejected (an error just goes). */
  discard: () => void
}

/** Replaces the pending state `requestId` owns; a reply for another request changes nothing. */
function settle(requestId: string, next: BriefDraftState | null): void {
  const current = useBriefDraftStore.getState().draft
  if (current?.status === 'pending' && current.requestId === requestId) {
    useBriefDraftStore.setState({ draft: next })
  }
}

export const useBriefDraftStore = create<BriefDraftStoreState>((set, get) => ({
  draft: null,

  start(nodeId) {
    if (get().draft?.status === 'pending') return
    get().discard()
    const requestId = nextRequestId()
    set({ draft: { nodeId, status: 'pending', requestId } })
    // Main reads the saved row, so unsaved typing goes first: the draft is made from what the
    // author sees, and the character gate here and in main agree.
    useDocumentStore
      .getState()
      .flush()
      .then(() =>
        useAiActivityStore
          .getState()
          .track('brief', requestId, ipc().invoke('ai:draftBrief', { nodeId, requestId }))
      )
      .then((result) => {
        if (result.ok) {
          settle(requestId, {
            nodeId,
            status: 'done',
            proposalId: result.proposalId,
            brief: result.brief,
            truncated: result.truncated,
            model: result.model,
            costUsd: result.costUsd,
            usage: result.usage,
            cached: result.cached
          })
        } else if (result.code === 'CANCELLED') {
          settle(requestId, null)
        } else {
          settle(requestId, {
            nodeId,
            status: 'error',
            message: result.message,
            nextStep: result.nextStep
          })
        }
      })
      .catch((err: unknown) => {
        settle(requestId, null)
        toast.error(describeError(err))
      })
  },

  cancel() {
    const draft = get().draft
    if (draft?.status !== 'pending') return
    void useAiActivityStore.getState().cancel(draft.requestId)
  },

  async accept() {
    const draft = get().draft
    if (draft?.status !== 'done') return
    set({ draft: null })
    try {
      await patchSceneMeta(draft.nodeId, (meta) => ({ ...meta, brief: draft.brief }))
    } catch (err) {
      toast.error(describeError(err))
      return
    }
    void proposalStore.settle(draft.proposalId, 'accepted')
  },

  discard() {
    const draft = get().draft
    if (draft === null || draft.status === 'pending') return
    if (draft.status === 'done') void proposalStore.settle(draft.proposalId, 'rejected')
    set({ draft: null })
  }
}))

/** Empties the store and restarts the id counter. For tests only. */
export function resetBriefDraftStore(): void {
  useBriefDraftStore.setState({ draft: null })
  requestCounter = 0
}
