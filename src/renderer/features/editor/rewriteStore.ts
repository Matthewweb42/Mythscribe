import { create } from 'zustand'
import type { Editor } from '@tiptap/core'
import type { AiUsage } from '@shared/ai'
import type { AiRewriteResult, EventPayload, Input } from '@shared/ipc/contract'
import { REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '@shared/rewrite'
import { useAiActivityStore } from '@renderer/features/ai/aiActivityStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { captureRewriteText, rewriteContext, rewriteTargetOf } from './rewriteTarget'

/**
 * Where a rewrite stands: `streaming` while the first draft arrives (no Accept yet), `ready`
 * once main has checked it against the voice profile and the panel shows the diff, `invalid`
 * when the passage changed under it (the diff stays, Accept does not), `error` for a failure
 * the author can act on.
 */
export type RewriteStatus = 'streaming' | 'ready' | 'invalid' | 'error'

/** The checked rewrite: the proposal (F-14.5), its fidelity flag (F-14.7), and what it cost. */
export interface RewriteOutcome {
  text: string
  flagged: boolean
  violation: string | null
  proposalId: string
  model: string
  costUsd: number
  /** The tokens the request spent, for the cost line (F-5.9). */
  usage: AiUsage
  cached: boolean
}

export interface RewriteSession {
  nodeId: string
  requestId: string
  status: RewriteStatus
  /** The passage as sent; the diff is drawn against it. */
  original: string
  /** The streamed first draft, then the checked answer. */
  draft: string
  result: RewriteOutcome | null
  error: string | null
  /** The range as captured at request time (a snapshot; the editor's target maps through edits). */
  from: number
  to: number
}

/**
 * The one rewrite in progress, app-wide (F-14.10). `start` captures the selection, its context
 * windows, and the target range in the editor, then sends `ai:rewrite` and appends the
 * `ai:rewriteDelta` pieces for its id to the draft; the reply (post-processed and voice-checked
 * in main) turns the session `ready` with the diff. Accept goes through the editor's
 * `acceptRewrite` command and settles the proposal `accepted`; Reject and Close settle it
 * `rejected`; Regenerate settles it `regenerated` and sends again with the note and the
 * predecessor id. The request is tracked in the activity store (F-5.10): Stop cancels it and
 * clears at once, a late reply is ignored (a late ok rejects its proposal), and a `CANCELLED`
 * reply is silent. Every other failure shows in the panel with its next step, not in a toast.
 */
interface RewriteState {
  session: RewriteSession | null
  /** Rewrites the editor's selection for `nodeId`; ignored while a rewrite is in progress or when the selection is out of bounds. */
  start: (nodeId: string, editor: Editor) => void
  /** Cancels the streaming request and clears the panel; the target highlight goes with it. */
  stop: () => void
  /** Asks again with the author's note (F-14.5); the shown proposal settles `regenerated`. */
  regenerate: (note: string | null) => void
  /** Replaces the passage with the checked rewrite through the editor; the proposal settles `accepted`. */
  accept: (editor: Editor) => void
  /** Drops the rewrite: a streaming one is cancelled, a shown one settles `rejected`. */
  reject: () => void
  /** Ends the rewrite for `nodeId` when its editor goes away (unmount, document switch, rebuild). */
  dismissFor: (nodeId: string) => void
}

/** The editor the session runs in, for the target range and the transaction watch; null between sessions. */
let editorInUse: Editor | null = null
let unsubscribe: (() => void) | null = null
let counter = 0

const nextRequestId = (): string => `rw-${Date.now().toString(36)}-${++counter}`

/** A `ready` session turns `invalid` the moment the editor drops its target (an edit inside the passage). */
function onTransaction(): void {
  const session = useRewriteStore.getState().session
  if (session?.status !== 'ready' || editorInUse === null) return
  if (rewriteTargetOf(editorInUse.state) === null) {
    useRewriteStore.setState({ session: { ...session, status: 'invalid' } })
  }
}

function onDelta({ requestId, delta }: EventPayload<'ai:rewriteDelta'>): void {
  const session = useRewriteStore.getState().session
  if (session?.requestId !== requestId || session.status !== 'streaming') return
  useRewriteStore.setState({ session: { ...session, draft: session.draft + delta } })
}

/** Ends the session: the editor's target highlight and transaction watch go, then the state. */
function end(): void {
  const editor = editorInUse
  editorInUse = null
  if (editor !== null && !editor.isDestroyed) {
    editor.off('transaction', onTransaction)
    editor.commands.clearRewriteTarget()
  }
  useRewriteStore.setState({ session: null })
}

/** The target still stands in the session's editor. */
function targetStands(): boolean {
  return (
    editorInUse !== null && !editorInUse.isDestroyed && rewriteTargetOf(editorInUse.state) !== null
  )
}

function settle(requestId: string, result: AiRewriteResult): void {
  const session = useRewriteStore.getState().session
  if (session?.requestId !== requestId) {
    // Stopped, rejected, or dismissed meanwhile: nothing shows the answer.
    if (result.ok) void proposalStore.settle(result.proposalId, 'rejected', null)
    return
  }
  if (!result.ok) {
    if (result.code === 'CANCELLED') end()
    else fail(requestId, `${result.message} ${result.nextStep}`.trim())
    return
  }
  useRewriteStore.setState({
    session: {
      ...session,
      status: targetStands() ? 'ready' : 'invalid',
      draft: result.text,
      result: {
        text: result.text,
        flagged: result.flagged,
        violation: result.violation,
        proposalId: result.proposalId,
        model: result.model,
        costUsd: result.costUsd,
        usage: result.usage,
        cached: result.cached
      }
    }
  })
}

function fail(requestId: string, message: string): void {
  const session = useRewriteStore.getState().session
  if (session?.requestId !== requestId) return
  useRewriteStore.setState({ session: { ...session, status: 'error', error: message } })
}

function send(input: Input<'ai:rewrite'>): void {
  useAiActivityStore
    .getState()
    .track('rewrite', input.requestId, ipc().invoke('ai:rewrite', input))
    .then(
      (result) => settle(input.requestId, result),
      (err: unknown) => fail(input.requestId, describeError(err))
    )
}

export const useRewriteStore = create<RewriteState>((set, get) => ({
  session: null,

  start(nodeId, editor) {
    if (get().session !== null || editor.isDestroyed) return
    const { from, to, text } = captureRewriteText(editor)
    if (text.length < REWRITE_TEXT_MIN || text.length > REWRITE_TEXT_MAX) return
    if (!editor.commands.setRewriteTarget(from, to, text)) return
    unsubscribe ??= ipc().on('ai:rewriteDelta', onDelta)
    editorInUse = editor
    editor.on('transaction', onTransaction)
    const requestId = nextRequestId()
    const { before, after } = rewriteContext(editor.state.doc, from, to)
    set({
      session: {
        nodeId,
        requestId,
        status: 'streaming',
        original: text,
        draft: '',
        result: null,
        error: null,
        from,
        to
      }
    })
    send({ nodeId, from, to, text, before, after, requestId })
  },

  stop() {
    const session = get().session
    if (session?.status !== 'streaming') return
    // The panel clears now, so the author can select again at once; the cancelled reply finds no session.
    void useAiActivityStore.getState().cancel(session.requestId)
    end()
  },

  regenerate(note) {
    const session = get().session
    if (session?.status !== 'ready' || session.result === null) return
    const editor = editorInUse
    if (editor === null || editor.isDestroyed) return
    const target = rewriteTargetOf(editor.state)
    if (target === null) {
      set({ session: { ...session, status: 'invalid' } })
      return
    }
    void proposalStore.settle(session.result.proposalId, 'regenerated', note)
    const requestId = nextRequestId()
    const { from, to, text } = target
    const { before, after } = rewriteContext(editor.state.doc, from, to)
    set({
      session: {
        ...session,
        requestId,
        status: 'streaming',
        draft: '',
        result: null,
        error: null,
        from,
        to
      }
    })
    send({
      nodeId: session.nodeId,
      from,
      to,
      text,
      before,
      after,
      requestId,
      note,
      regeneratedFrom: session.result.proposalId
    })
  },

  accept(editor) {
    const session = get().session
    if (session?.status !== 'ready' || session.result === null) return
    const { text, proposalId } = session.result
    if (!editor.chain().focus().acceptRewrite(text, proposalId).run()) {
      set({ session: { ...session, status: 'invalid' } })
      return
    }
    void proposalStore.settle(proposalId, 'accepted', null)
    end()
  },

  reject() {
    const session = get().session
    if (session === null) return
    if (session.status === 'streaming') {
      void useAiActivityStore.getState().cancel(session.requestId)
    } else if (session.result !== null) {
      void proposalStore.settle(session.result.proposalId, 'rejected', null)
    }
    end()
  },

  dismissFor(nodeId) {
    if (get().session?.nodeId === nodeId) get().reject()
  }
}))

/** Ends any session, drops the delta subscription, and restarts the id counter. For tests only. */
export function resetRewriteStore(): void {
  end()
  unsubscribe?.()
  unsubscribe = null
  counter = 0
}
