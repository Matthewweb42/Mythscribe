import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { AiUsage } from '@shared/ai'
import type { BetaReaderItem, BetaReaderScene } from '@shared/betaReader'
import type { AiBetaReaderResult, Input } from '@shared/ipc/contract'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { locateText } from './locateText'

/**
 * Where a read-through stands: `pending` while main gathers the earlier scenes' summaries and
 * asks the model, `ready` once the report is in (every item citing a passage main found in the
 * scene it names), `error` for a failure the author can act on.
 */
export type BetaReaderStatus = 'pending' | 'ready' | 'error'

/** What the read cost and which proposal it became (F-14.5), with what main had to leave out. */
export interface BetaReaderOutcome {
  proposalId: string
  model: string
  costUsd: number
  /** The tokens the request spent, for the cost line (F-5.9). */
  usage: AiUsage
  cached: boolean
  /** The current scene was head-truncated before it was sent. */
  truncated: boolean
  /** Earliest scenes left out to fit the input budget. */
  skipped: number
  /** Earlier scenes with no stored summary, so the reader never read them (F-5.6). */
  missing: number
  /** Items main dropped because their quote was not in the scene they named; only counted. */
  dropped: number
}

export interface BetaReaderSession {
  nodeId: string
  requestId: string
  status: BetaReaderStatus
  items: BetaReaderItem[]
  /** The scenes the reader read, in the order sent; the current one is the entry with `current`. */
  scenes: BetaReaderScene[]
  /** Per item: its quote is no longer in the document, so Show cannot land. */
  stale: boolean[]
  result: BetaReaderOutcome | null
  error: string | null
}

/**
 * The one beta read in progress, app-wide (F-14.11). `start` flushes the autosave (main reads
 * the saved row, as the critique request does) and sends `ai:betaReader`; the reply fills the
 * panel with what a first-time reader knows, believes, and expects. A reader only reports, so
 * nothing here writes to the manuscript: `show` selects the passage an item cites, and only for
 * an item citing the scene the author is in — an earlier scene was read as its summary, which
 * is not in this document. A quote that has since been edited away marks its item stale. Close
 * settles the proposal `rejected` (there was never anything to accept); Regenerate settles it
 * `regenerated` and asks again with the author's note and the predecessor id. The request is
 * tracked in the activity store (F-5.10): Stop cancels it, a late reply is ignored (a late ok
 * rejects its proposal), and a `CANCELLED` reply is silent. Every other failure shows in the panel.
 */
interface BetaReaderState {
  session: BetaReaderSession | null
  /** Asks for a read-through up to `nodeId`; ignored while one is in progress. */
  start: (nodeId: string) => void
  /** Cancels the pending request and clears the panel. */
  stop: () => void
  /** Selects the passage an item cites in this scene, or marks the item stale when it is gone. */
  show: (index: number, editor: Editor) => void
  /** Asks again with the author's note (F-14.5); the shown proposal settles `regenerated`. */
  regenerate: (note: string | null) => void
  /** Ends the read: a pending one is cancelled, a shown one settles `rejected`. */
  close: () => void
  /** Ends the read for `nodeId` when its editor goes away (unmount, document switch, rebuild). */
  dismissFor: (nodeId: string) => void
}

let counter = 0

const nextRequestId = (): string => `br-${Date.now().toString(36)}-${++counter}`

/** Marks one item as no longer locatable; the panel greys its Show. */
function markStale(index: number): void {
  const session = useBetaReaderStore.getState().session
  if (session === null) return
  const stale = session.stale.map((value, i) => (i === index ? true : value))
  useBetaReaderStore.setState({ session: { ...session, stale } })
}

function settle(requestId: string, result: AiBetaReaderResult): void {
  const session = useBetaReaderStore.getState().session
  if (session?.requestId !== requestId) {
    // Stopped, closed, or dismissed meanwhile: nothing shows the answer.
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
    return
  }
  if (!result.ok) {
    if (result.code === 'CANCELLED') useBetaReaderStore.setState({ session: null })
    else fail(requestId, `${result.message} ${result.nextStep}`.trim())
    return
  }
  useBetaReaderStore.setState({
    session: {
      ...session,
      status: 'ready',
      items: result.items,
      scenes: result.scenes,
      stale: result.items.map(() => false),
      result: {
        proposalId: result.proposalId,
        model: result.model,
        costUsd: result.costUsd,
        usage: result.usage,
        cached: result.cached,
        truncated: result.truncated,
        skipped: result.skipped,
        missing: result.missing,
        dropped: result.dropped
      }
    }
  })
}

function fail(requestId: string, message: string): void {
  const session = useBetaReaderStore.getState().session
  if (session?.requestId !== requestId) return
  useBetaReaderStore.setState({ session: { ...session, status: 'error', error: message } })
}

/** Flushes the author's unsaved typing, then sends the request: main reads the saved row. */
function send(input: Input<'ai:betaReader'>): void {
  useDocumentStore
    .getState()
    .flush()
    .then(() =>
      useAiActivityStore
        .getState()
        .track('betaReader', input.requestId, ipc().invoke('ai:betaReader', input))
    )
    .then(
      (result) => settle(input.requestId, result),
      (err: unknown) => fail(input.requestId, describeError(err))
    )
}

export const useBetaReaderStore = create<BetaReaderState>((set, get) => ({
  session: null,

  start(nodeId) {
    if (get().session !== null) return
    const requestId = nextRequestId()
    set({
      session: {
        nodeId,
        requestId,
        status: 'pending',
        items: [],
        scenes: [],
        stale: [],
        result: null,
        error: null
      }
    })
    send({ nodeId, requestId })
  },

  stop() {
    const session = get().session
    if (session?.status !== 'pending') return
    // The panel clears now, so the author can ask again at once; the cancelled reply finds no session.
    void useAiActivityStore.getState().cancel(session.requestId)
    set({ session: null })
  },

  show(index, editor) {
    const session = get().session
    if (session?.status !== 'ready' || editor.isDestroyed) return
    const item = session.items[index]
    if (item === undefined || session.stale[index] === true) return
    // Only the current scene is in this editor; an earlier scene was read as its summary.
    if (session.scenes[item.scene - 1]?.current !== true) return
    const range = locateText(editor.state.doc, item.quote)
    if (range === null) {
      markStale(index)
      return
    }
    editor.chain().focus().setTextSelection(range).scrollIntoView().run()
  },

  regenerate(note) {
    const session = get().session
    if (session?.status !== 'ready' || session.result === null) return
    void proposalStore.settle(session.result.proposalId, 'regenerated', note)
    const requestId = nextRequestId()
    const regeneratedFrom = session.result.proposalId
    set({
      session: {
        ...session,
        requestId,
        status: 'pending',
        items: [],
        scenes: [],
        stale: [],
        result: null,
        error: null
      }
    })
    send({ nodeId: session.nodeId, requestId, note, regeneratedFrom })
  },

  close() {
    const session = get().session
    if (session === null) return
    if (session.status === 'pending') {
      void useAiActivityStore.getState().cancel(session.requestId)
    } else if (session.result !== null) {
      // A report is never applied, so the proposal settles as declined either way (F-14.5).
      void proposalStore.settle(session.result.proposalId, 'rejected', null)
    }
    set({ session: null })
  },

  dismissFor(nodeId) {
    if (get().session?.nodeId === nodeId) get().close()
  }
}))

/** Ends any session and restarts the id counter. For tests only. */
export function resetBetaReaderStore(): void {
  useBetaReaderStore.setState({ session: null })
  counter = 0
}
