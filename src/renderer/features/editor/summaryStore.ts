import { create } from 'zustand'
import type { EventPayload } from '@shared/ipc/contract'
import type { SceneSummaryState } from '@shared/summary'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'

/** The subscription to main's background runs; one for the renderer, opened by the first load. */
let unsubscribe: (() => void) | null = null
let counter = 0
/** A request id `ai:cancel` can find (F-5.10), unique across this renderer's summaries. */
const nextRequestId = (): string => `sum-${Date.now().toString(36)}-${++counter}`

/** What a manuscript document with no summary yet looks like, for a Summarize now before any load. */
const FRESH: SceneSummaryState = {
  available: true,
  summary: null,
  stale: false,
  status: 'idle',
  error: null
}

/**
 * The renderer's view of the scene summaries (F-5.6), keyed by node. Main owns the summaries:
 * it writes them in the background after the author pauses typing and tells the renderer when a
 * node's run changes status (`ai:summaryChanged`), so this store only fetches (`summary:get`),
 * holds the last state per node, and asks for a run now (`ai:summarize`). A summary is not a
 * proposal: it is derived index data, so there is nothing to accept or reject here.
 */
interface SummaryState {
  /** The last known state per node; a node the pane never asked for is absent. */
  byNode: Record<string, SceneSummaryState>
  /** Fetches one node's state (and opens the change subscription on the first call). Toasts a failed fetch. */
  load: (id: string) => Promise<void>
  /** Flushes the document, then summarises it now. A cancelled run is silent; a failure lands in the node's `error`. */
  summarize: (id: string) => Promise<void>
  /** Forgets every node (project close). */
  clear: () => void
}

/** Replaces one node's state and leaves every other node alone. */
function put(id: string, state: SceneSummaryState): void {
  useSummaryStore.setState((s) => ({ byNode: { ...s.byNode, [id]: state } }))
}

/**
 * A background run started or ended in main. The status shows at once (so the pane says
 * "Updating…" while it runs) and a finished run is refetched, because only main knows the new
 * row, whether it is stale, and what failed.
 */
function onChanged({ nodeId, status }: EventPayload<'ai:summaryChanged'>): void {
  const held = useSummaryStore.getState().byNode[nodeId]
  // Nothing on screen holds this node: the pane fetches when it shows it.
  if (held === undefined) return
  put(nodeId, { ...held, status })
  if (status !== 'pending') void useSummaryStore.getState().load(nodeId)
}

export const useSummaryStore = create<SummaryState>((set, get) => ({
  byNode: {},

  async load(id) {
    unsubscribe ??= ipc().on('ai:summaryChanged', onChanged)
    try {
      put(id, await ipc().invoke('summary:get', { id }))
    } catch (err: unknown) {
      toast.error(describeError(err))
    }
  },

  async summarize(id) {
    const held = get().byNode[id] ?? null
    if (held?.status === 'pending') return
    const requestId = nextRequestId()
    // The old row stays in view while the new one is written, and an old failure is superseded.
    put(id, { ...(held ?? FRESH), available: true, status: 'pending', error: null })
    try {
      // Main summarises the saved row, so unsaved typing is flushed first.
      await useDocumentStore.getState().flush()
      const result = await useAiActivityStore
        .getState()
        .track('summary', requestId, ipc().invoke('ai:summarize', { nodeId: id, requestId }))
      if (result.ok) {
        put(id, result.state)
      } else if (result.code === 'CANCELLED') {
        // The author stopped it: back to what the node showed before, with no complaint.
        put(id, held ?? FRESH)
      } else {
        put(id, {
          ...(get().byNode[id] ?? held ?? FRESH),
          status: 'failed',
          error: { message: result.message, nextStep: result.nextStep }
        })
      }
    } catch (err: unknown) {
      put(id, held ?? FRESH)
      toast.error(describeError(err))
    }
  },

  clear() {
    set({ byNode: {} })
  }
}))

/** Forgets every node, drops the change subscription, and restarts the id counter. For tests only. */
export function resetSummaryStore(): void {
  unsubscribe?.()
  unsubscribe = null
  counter = 0
  useSummaryStore.setState({ byNode: {} })
}
