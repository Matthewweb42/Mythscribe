import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { AiUsage } from '@shared/ai'
import type { AiProofreadResult, Input } from '@shared/ipc/contract'
import {
  PROOFREAD_CHAR_BUDGET,
  PROOFREAD_TEXT_MIN,
  type ProofreadFix,
  type ProofreadScope
} from '@shared/proofread'
import type { SettledStatus } from '@shared/proposal'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { applyFixToPassage, REWRITE_BUSY_MESSAGE } from './applyFix'
import { useDocumentStore } from './documentStore'
import { locateText } from './locateText'
import { captureRewriteText } from './rewriteTarget'

/**
 * Where a proofreading pass stands: `pending` while main reads the text and asks the model,
 * `ready` once the fixes are in, `error` for a failure the author can act on.
 */
export type ProofreadStatus = 'pending' | 'ready' | 'error'

/**
 * Where one fix stands: `open` until the author decides, `applied` once it is in the
 * manuscript, `rejected` when the author turned it down, `stale` when its quote is no longer
 * in the document (so neither Show nor Accept can land).
 */
export type ProofreadFixState = 'open' | 'applied' | 'rejected' | 'stale'

/** What the pass cost and which proposal it became (F-14.5), with what main had to cut. */
export interface ProofreadOutcome {
  proposalId: string
  model: string
  costUsd: number
  /** The tokens the request spent, for the cost line (F-5.9). */
  usage: AiUsage
  cached: boolean
  /** The text was head-truncated before it was sent (by main, or the selection here). */
  truncated: boolean
  /** Fixes main dropped (not found, overlapping, too large, or "correcting" a name); only counted. */
  dropped: number
}

export interface ProofreadSession {
  nodeId: string
  requestId: string
  status: ProofreadStatus
  scope: ProofreadScope
  fixes: ProofreadFix[]
  /** Per fix: where it stands. */
  states: ProofreadFixState[]
  result: ProofreadOutcome | null
  error: string | null
  /** The proposal has been settled (once no fix is open, or on close); never twice. */
  settled: boolean
}

/**
 * The one proofreading pass in progress, app-wide (F-14.12). `start` reads the selection (a
 * selection of at least `PROOFREAD_TEXT_MIN` characters is proofread instead of the scene),
 * flushes the autosave (main reads the saved row), and sends `ai:proofread`; the reply fills
 * the panel with the fixes. Nothing enters the manuscript on its own: `accept` replaces exactly
 * the quoted passage through `applyFixToPassage` (AI-origin marked, F-14.6, one undo step),
 * `reject` turns a fix down, `acceptAll` accepts every open fix in order. A quote that is no
 * longer in the document marks its fix stale. Once no fix is open the proposal settles by how
 * many were applied (all, some, none); close settles it if that has not happened. The request
 * is tracked in the activity store (F-5.10): Stop cancels it, a late ok rejects its proposal,
 * and a `CANCELLED` reply is silent.
 */
interface ProofreadState {
  session: ProofreadSession | null
  /** Proofreads the selection or the scene of `nodeId`; ignored while a pass is in progress. */
  start: (nodeId: string, editor: Editor) => void
  /** Cancels the pending request and clears the panel. */
  stop: () => void
  /** Selects the passage a fix quotes, or marks the fix stale when it is gone. */
  show: (index: number, editor: Editor) => void
  /** Replaces the quoted passage with the fix; refused (with a toast) while a rewrite holds the editor. */
  accept: (index: number, editor: Editor) => void
  /** Turns one fix down. */
  reject: (index: number) => void
  /** Accepts every open fix in document order. */
  acceptAll: (editor: Editor) => void
  /** Ends the pass: a pending one is cancelled, a shown one settles if it has not yet. */
  close: () => void
  /** Ends the pass for `nodeId` when its editor goes away (unmount, document switch, rebuild). */
  dismissFor: (nodeId: string) => void
}

let counter = 0

const nextRequestId = (): string => `pr-${Date.now().toString(36)}-${++counter}`

/** How the proposal settles: every fix applied, some of them, or none (F-14.5). */
function settlementOf(session: ProofreadSession): SettledStatus {
  const applied = session.states.filter((state) => state === 'applied').length
  if (applied === 0) return 'rejected'
  return applied === session.fixes.length ? 'accepted' : 'acceptedPart'
}

/** Settles the proposal once, when it has not been settled yet; returns the session as settled. */
function settleProposal(session: ProofreadSession): ProofreadSession {
  if (session.settled || session.result === null) return session
  void proposalStore.settle(session.result.proposalId, settlementOf(session), null)
  return { ...session, settled: true }
}

/** Sets one fix's state, and settles the proposal once no fix is open. */
function setFixState(requestId: string, index: number, state: ProofreadFixState): void {
  const session = useProofreadStore.getState().session
  if (session?.requestId !== requestId) return
  const states = session.states.map((value, i) => (i === index ? state : value))
  let next: ProofreadSession = { ...session, states }
  if (!states.includes('open')) next = settleProposal(next)
  useProofreadStore.setState({ session: next })
}

function settle(requestId: string, result: AiProofreadResult, selectionCut: boolean): void {
  const session = useProofreadStore.getState().session
  if (session?.requestId !== requestId) {
    // Stopped, closed, or dismissed meanwhile: nothing shows the answer.
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
    return
  }
  if (!result.ok) {
    if (result.code === 'CANCELLED') useProofreadStore.setState({ session: null })
    else fail(requestId, `${result.message} ${result.nextStep}`.trim())
    return
  }
  useProofreadStore.setState({
    session: {
      ...session,
      status: 'ready',
      scope: result.scope,
      fixes: result.fixes,
      states: result.fixes.map(() => 'open'),
      result: {
        proposalId: result.proposalId,
        model: result.model,
        costUsd: result.costUsd,
        usage: result.usage,
        cached: result.cached,
        truncated: result.truncated || selectionCut,
        dropped: result.dropped
      }
    }
  })
}

function fail(requestId: string, message: string): void {
  const session = useProofreadStore.getState().session
  if (session?.requestId !== requestId) return
  useProofreadStore.setState({ session: { ...session, status: 'error', error: message } })
}

/** Flushes the author's unsaved typing, then sends the request: main reads the saved row. */
function send(input: Input<'ai:proofread'>, selectionCut: boolean): void {
  useDocumentStore
    .getState()
    .flush()
    .then(() =>
      useAiActivityStore
        .getState()
        .track('proofread', input.requestId, ipc().invoke('ai:proofread', input))
    )
    .then(
      (result) => settle(input.requestId, result, selectionCut),
      (err: unknown) => fail(input.requestId, describeError(err))
    )
}

/** The selection to proofread instead of the scene, or null when it is too short to count. */
export function proofreadSelection(editor: Editor): string | null {
  const { text } = captureRewriteText(editor)
  return text.trim().length >= PROOFREAD_TEXT_MIN ? text : null
}

export const useProofreadStore = create<ProofreadState>((set, get) => ({
  session: null,

  start(nodeId, editor) {
    if (get().session !== null) return
    const selected = editor.isDestroyed ? null : proofreadSelection(editor)
    // The contract caps the selection at the character budget: a longer one is head-truncated
    // here, and the panel says so as it does for a truncated scene.
    const selection = selected?.slice(0, PROOFREAD_CHAR_BUDGET) ?? null
    const selectionCut = selected !== null && selected.length > PROOFREAD_CHAR_BUDGET
    const requestId = nextRequestId()
    set({
      session: {
        nodeId,
        requestId,
        status: 'pending',
        scope: selection === null ? 'scene' : 'selection',
        fixes: [],
        states: [],
        result: null,
        error: null,
        settled: false
      }
    })
    send({ nodeId, requestId, selection }, selectionCut)
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
    const fix = session.fixes[index]
    if (fix === undefined || session.states[index] !== 'open') return
    const range = locateText(editor.state.doc, fix.quote)
    if (range === null) {
      setFixState(session.requestId, index, 'stale')
      return
    }
    editor.chain().focus().setTextSelection(range).scrollIntoView().run()
  },

  accept(index, editor) {
    const session = get().session
    if (session?.status !== 'ready' || session.result === null || editor.isDestroyed) return
    const fix = session.fixes[index]
    if (fix === undefined || session.states[index] !== 'open') return
    const outcome = applyFixToPassage(editor, fix.quote, fix.fix, session.result.proposalId)
    if (outcome === 'busy') {
      // A rewrite in progress owns the editor's target: nothing changed, the fix stays open.
      toast.warning(REWRITE_BUSY_MESSAGE)
      return
    }
    setFixState(session.requestId, index, outcome === 'gone' ? 'stale' : 'applied')
  },

  reject(index) {
    const session = get().session
    if (session?.status !== 'ready' || session.states[index] !== 'open') return
    setFixState(session.requestId, index, 'rejected')
  },

  acceptAll(editor) {
    const session = get().session
    if (session?.status !== 'ready') return
    for (let index = 0; index < session.fixes.length; index++) {
      const current = get().session
      if (current?.requestId !== session.requestId) return
      if (current.states[index] !== 'open') continue
      get().accept(index, editor)
      // Refused while a rewrite holds the editor: one toast, and the rest stay open.
      if (get().session?.states[index] === 'open') return
    }
  },

  close() {
    const session = get().session
    if (session === null) return
    if (session.status === 'pending') {
      void useAiActivityStore.getState().cancel(session.requestId)
    } else {
      settleProposal(session)
    }
    set({ session: null })
  },

  dismissFor(nodeId) {
    if (get().session?.nodeId === nodeId) get().close()
  }
}))

/** Ends any session and restarts the id counter. For tests only. */
export function resetProofreadStore(): void {
  useProofreadStore.setState({ session: null })
  counter = 0
}
