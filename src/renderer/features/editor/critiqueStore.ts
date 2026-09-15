import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { CritiqueNote } from '@shared/critique'
import type { AiCritiqueResult, Input } from '@shared/ipc/contract'
import type { SettledStatus } from '@shared/proposal'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { useDocumentStore } from './documentStore'
import { locateText } from './locateText'
import { passageText } from './rewriteTarget'
import { useRewriteStore } from './rewriteStore'

/**
 * Where a critique stands: `pending` while main reads the scene and asks the model, `ready`
 * once the notes are in (every one citing a passage main found), `error` for a failure the
 * author can act on.
 */
export type CritiqueStatus = 'pending' | 'ready' | 'error'

/** What the critique cost and which proposal it became (F-14.5), with what main had to cut. */
export interface CritiqueOutcome {
  proposalId: string
  model: string
  costUsd: number
  cached: boolean
  /** The scene was head-truncated before it was sent. */
  truncated: boolean
  /** Notes main dropped because it could not find their quote; never shown, only counted. */
  dropped: number
}

export interface CritiqueSession {
  nodeId: string
  requestId: string
  status: CritiqueStatus
  notes: CritiqueNote[]
  /** Per note: its fix is in the manuscript. */
  applied: boolean[]
  /** Per note: its quote is no longer in the document, so neither Show nor Apply can land. */
  stale: boolean[]
  result: CritiqueOutcome | null
  error: string | null
}

/**
 * The one critique in progress, app-wide (F-14.8). `start` flushes the autosave (main reads
 * the saved row, as the tag bar's request does) and sends `ai:critique`; the reply fills the
 * panel with the editor's notes. Nothing enters the manuscript on its own: `show` selects the
 * cited passage, and `applyFix` replaces exactly that passage with the note's fix through the
 * rewrite-target commands, so the text is AI-origin marked (F-14.6) and undoes as one step. A
 * quote that is no longer in the document marks its note stale instead. Close settles the
 * proposal by how many fixes were applied (all, some, none); Regenerate settles it
 * `regenerated` and asks again with the note and the predecessor id. The request is tracked in
 * the activity store (F-5.10): Stop cancels it, a late reply is ignored (a late ok rejects its
 * proposal), and a `CANCELLED` reply is silent. Every other failure shows in the panel.
 */
interface CritiqueState {
  session: CritiqueSession | null
  /** Asks for editor's notes on `nodeId`; ignored while a critique is in progress. */
  start: (nodeId: string) => void
  /** Cancels the pending request and clears the panel. */
  stop: () => void
  /** Selects the passage a note cites, or marks the note stale when it is gone. */
  show: (index: number, editor: Editor) => void
  /** Replaces the cited passage with the note's fix; refused while a rewrite holds the editor. */
  applyFix: (index: number, editor: Editor) => void
  /** Asks again with the author's note (F-14.5); the shown proposal settles `regenerated`. */
  regenerate: (note: string | null) => void
  /** Ends the critique: a pending one is cancelled, a shown one settles by the applied count. */
  close: () => void
  /** Ends the critique for `nodeId` when its editor goes away (unmount, document switch, rebuild). */
  dismissFor: (nodeId: string) => void
}

let counter = 0

const nextRequestId = (): string => `cr-${Date.now().toString(36)}-${++counter}`

/** How the proposal settles on close: every fix applied, some of them, or none (F-14.5). */
function settlementOf(session: CritiqueSession): SettledStatus {
  const fixable = session.notes.filter((note) => note.fix !== null).length
  const applied = session.applied.filter(Boolean).length
  if (applied === 0) return 'rejected'
  return applied === fixable ? 'accepted' : 'acceptedPart'
}

/** Marks one note as no longer locatable; the panel greys its Show and Apply. */
function markStale(index: number): void {
  const session = useCritiqueStore.getState().session
  if (session === null) return
  const stale = session.stale.map((value, i) => (i === index ? true : value))
  useCritiqueStore.setState({ session: { ...session, stale } })
}

function settle(requestId: string, result: AiCritiqueResult): void {
  const session = useCritiqueStore.getState().session
  if (session?.requestId !== requestId) {
    // Stopped, closed, or dismissed meanwhile: nothing shows the answer.
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
    return
  }
  if (!result.ok) {
    if (result.code === 'CANCELLED') useCritiqueStore.setState({ session: null })
    else fail(requestId, `${result.message} ${result.nextStep}`.trim())
    return
  }
  useCritiqueStore.setState({
    session: {
      ...session,
      status: 'ready',
      notes: result.notes,
      applied: result.notes.map(() => false),
      stale: result.notes.map(() => false),
      result: {
        proposalId: result.proposalId,
        model: result.model,
        costUsd: result.costUsd,
        cached: result.cached,
        truncated: result.truncated,
        dropped: result.dropped
      }
    }
  })
}

function fail(requestId: string, message: string): void {
  const session = useCritiqueStore.getState().session
  if (session?.requestId !== requestId) return
  useCritiqueStore.setState({ session: { ...session, status: 'error', error: message } })
}

/** Flushes the author's unsaved typing, then sends the request: main reads the saved row. */
function send(input: Input<'ai:critique'>): void {
  useDocumentStore
    .getState()
    .flush()
    .then(() =>
      useAiActivityStore
        .getState()
        .track('critique', input.requestId, ipc().invoke('ai:critique', input))
    )
    .then(
      (result) => settle(input.requestId, result),
      (err: unknown) => fail(input.requestId, describeError(err))
    )
}

export const useCritiqueStore = create<CritiqueState>((set, get) => ({
  session: null,

  start(nodeId) {
    if (get().session !== null) return
    const requestId = nextRequestId()
    set({
      session: {
        nodeId,
        requestId,
        status: 'pending',
        notes: [],
        applied: [],
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
    const note = session.notes[index]
    if (note === undefined || session.stale[index] === true) return
    const range = locateText(editor.state.doc, note.quote)
    if (range === null) {
      markStale(index)
      return
    }
    editor.chain().focus().setTextSelection(range).scrollIntoView().run()
  },

  applyFix(index, editor) {
    const session = get().session
    if (session?.status !== 'ready' || session.result === null || editor.isDestroyed) return
    // The rewrite target is one per editor: a rewrite in progress owns it.
    if (useRewriteStore.getState().session !== null) return
    const note = session.notes[index]
    if (note?.fix === undefined || note.fix === null) return
    if (session.applied[index] === true || session.stale[index] === true) return
    const range = locateText(editor.state.doc, note.quote)
    if (range === null) {
      markStale(index)
      return
    }
    const { from, to } = range
    // Two commands, not one chain: `acceptRewrite` reads the target from the state the chain
    // started in, so the target has to be set in its own transaction first.
    if (!editor.commands.setRewriteTarget(from, to, passageText(editor.state.doc, from, to))) {
      markStale(index)
      return
    }
    if (!editor.chain().focus().acceptRewrite(note.fix, session.result.proposalId).run()) {
      editor.commands.clearRewriteTarget()
      markStale(index)
      return
    }
    const current = get().session
    if (current?.requestId !== session.requestId) return
    set({
      session: {
        ...current,
        applied: current.applied.map((value, i) => (i === index ? true : value))
      }
    })
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
        notes: [],
        applied: [],
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
      void proposalStore.settle(session.result.proposalId, settlementOf(session), null)
    }
    set({ session: null })
  },

  dismissFor(nodeId) {
    if (get().session?.nodeId === nodeId) get().close()
  }
}))

/** Ends any session and restarts the id counter. For tests only. */
export function resetCritiqueStore(): void {
  useCritiqueStore.setState({ session: null })
  counter = 0
}
