import { useEffect, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { GHOST_AFTER_CHARS, GHOST_BEFORE_CHARS, type AiErrorCode } from '@shared/ai'
import { DEFAULT_GHOST_IDLE_MS, isFeatureAllowed } from '@shared/aiSettings'
import {
  GHOST_BACKOFF_MS,
  GHOST_MAX_PER_DAY,
  GHOST_MIN_NEW_CHARS,
  shouldTrigger
} from '@shared/aiThrottle'
import { INLINE_TAG_NODE_TYPE } from '@shared/inlineTags'
import type { AiGhostTextResult } from '@shared/ipc/contract'
import { useAiSettingsStore } from '@renderer/features/ai/aiSettingsStore'
import { proposalStore } from '@renderer/features/ai/proposalStore'
import { toast } from '@renderer/features/shell/dialogs/dialogStore'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { GHOST_TEXT_KEY, ghostOf, type GhostSettleHandler } from './ghostText'

/** The failures that turn VibeWrite off: nothing will succeed until the author acts in Settings. */
const TURN_OFF_CODES: ReadonlySet<AiErrorCode> = new Set(['DISABLED', 'NO_KEY', 'INVALID_KEY'])

/** Session state shared by every editor instance: the soft per-day count, the back-off, the one-time toast. */
interface SessionState {
  dayKey: string
  requestsToday: number
  /** When the last request failed for a reason worth backing off from; null when none did. */
  failedAt: number | null
  /** The turn-off toast was shown; reset when the author turns VibeWrite back on. */
  turnOffToastShown: boolean
}

const dayKeyOf = (now: number): string => new Date(now).toDateString()

let session: SessionState = {
  dayKey: dayKeyOf(Date.now()),
  requestsToday: 0,
  failedAt: null,
  turnOffToastShown: false
}

/** Drops the session counters, the back-off, and the toast flag. For tests only. */
export function resetGhostTextController(): void {
  session = {
    dayKey: dayKeyOf(Date.now()),
    requestsToday: 0,
    failedAt: null,
    turnOffToastShown: false
  }
}

/** Inline atoms as the author reads them: an inline tag token as `#name` (mirrors `docToText`). */
function leafText(node: PmNode): string {
  if (node.type.name !== INLINE_TAG_NODE_TYPE) return ''
  const name: unknown = node.attrs.name
  return typeof name === 'string' ? `#${name}` : ''
}

/**
 * The text ghost text may send (F-5.3, the data-sharing panel's line): up to
 * `GHOST_BEFORE_CHARS` before the caret and `GHOST_AFTER_CHARS` after it, blocks joined by a
 * newline. Positions are not characters (block boundaries count), so a wider span is read and
 * sliced to the character cap; the span stays bounded so a long scene is never serialized whole.
 */
export function caretWindow(state: EditorState): { before: string; after: string } {
  const { from } = state.selection
  const size = state.doc.content.size
  const before = state.doc
    .textBetween(Math.max(0, from - GHOST_BEFORE_CHARS * 4), from, '\n', leafText)
    .slice(-GHOST_BEFORE_CHARS)
  const after = state.doc
    .textBetween(from, Math.min(size, from + GHOST_AFTER_CHARS * 4), '\n', leafText)
    .slice(0, GHOST_AFTER_CHARS)
  return { before, after }
}

export interface GhostConfig {
  /** VibeWrite is on, the dial allows ghost text, and this editor is the single-document view. */
  armed: boolean
  idleMs: number
}

interface GhostSessionDeps {
  editor: Editor
  nodeId: string
  /** Read on every event, so a Settings change applies to the next tick without a remount. */
  config: () => GhostConfig
  /** The subtle failure line for the toolbar indicator; null clears it. */
  onError: (message: string | null) => void
  now: () => number
}

/**
 * One editor instance's trigger loop. Every edit or caret move restarts the idle timer; when it
 * fires, `shouldTrigger` (F-5.14) decides, then the caret window leaves through `ai:ghostText`
 * with a fresh request id. An answer is shown only if nothing moved on meanwhile: the same
 * document, the newest request id, no edit or caret move since it left, and the editor still
 * focused. Failures are handled whatever their age: DISABLED, NO_KEY, and INVALID_KEY turn
 * VibeWrite off with one toast (nothing will succeed until Settings change); anything else
 * goes to the toolbar indicator and backs off for `GHOST_BACKOFF_MS`.
 *
 * A shown suggestion is a proposal (F-14.5): the session keeps its id while it shows and
 * settles it (never with a note; Escape stays silent) when the extension reports how it left
 * the screen; the extension marks what it inserts with the same id (F-14.6). Answers without
 * a proposal id (an empty suggestion) have nothing to settle.
 */
function startGhostSession(deps: GhostSessionDeps): () => void {
  const { editor, nodeId, now } = deps
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastEditAt = now()
  let newChars = 0
  let pending = false
  let latestRequestId = 0
  let editedSinceSend = false
  let focused = editor.isFocused
  let disposed = false
  /** The proposal behind the suggestion showing; null while none shows or it came without one. */
  let shownProposalId: string | null = null

  const onSettle: GhostSettleHandler = (status) => {
    const id = shownProposalId
    shownProposalId = null
    if (id !== null) void proposalStore.settle(id, status, null)
  }
  const storage = editor.storage.ghostText
  if (storage) storage.onSettle = onSettle

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }

  const rollDay = (): void => {
    const key = dayKeyOf(now())
    if (key !== session.dayKey) session = { ...session, dayKey: key, requestsToday: 0 }
  }

  const failed = (code: AiErrorCode | null, message: string, nextStep: string): void => {
    if (code !== null && TURN_OFF_CODES.has(code)) {
      const store = useAiSettingsStore.getState()
      const settings = store.settings
      if (settings) store.update({ ghostText: { ...settings.ghostText, enabled: false } })
      if (!session.turnOffToastShown) {
        session = { ...session, turnOffToastShown: true }
        toast.error(`VibeWrite turned off: ${message} ${nextStep}`)
      }
      return
    }
    session = { ...session, failedAt: now() }
    deps.onError(`${message} ${nextStep}`.trim())
  }

  const settle = (result: AiGhostTextResult): void => {
    pending = false
    if (!result.ok) {
      failed(result.code, result.message, result.nextStep)
      return
    }
    if (disposed || result.requestId !== String(latestRequestId) || editedSinceSend || !focused) {
      return
    }
    deps.onError(null)
    // Set the id after the command: a suggestion this one replaces settles under its own id first.
    if (
      result.text &&
      editor.commands.setGhost(result.text, result.flagged, result.violation, result.proposalId)
    ) {
      shownProposalId = result.proposalId
    }
  }

  const check = (): void => {
    timer = null
    if (disposed) return
    const { armed, idleMs } = deps.config()
    if (!armed) return
    rollDay()
    if (session.failedAt !== null && now() - session.failedAt < GHOST_BACKOFF_MS) return
    const visible = ghostOf(editor.state) !== null
    const ok = shouldTrigger({
      idleMs: now() - lastEditAt,
      minIdleMs: idleMs,
      newChars,
      minNewChars: GHOST_MIN_NEW_CHARS,
      pending,
      visible,
      requestsToday: session.requestsToday,
      dailyRequestCap: GHOST_MAX_PER_DAY
    })
    if (!ok || !focused || !editor.state.selection.empty) return
    const { before, after } = caretWindow(editor.state)
    if (!before.trim()) return
    pending = true
    editedSinceSend = false
    newChars = 0
    session = { ...session, requestsToday: session.requestsToday + 1 }
    const requestId = String(++latestRequestId)
    ipc()
      .invoke('ai:ghostText', { nodeId, before, after, requestId })
      .then(settle, (err: unknown) => {
        pending = false
        failed(null, describeError(err), '')
      })
  }

  const activity = (transaction: Transaction, sizeDelta: number): void => {
    if (transaction.getMeta(GHOST_TEXT_KEY) !== undefined) return
    focused = true
    editedSinceSend = true
    lastEditAt = now()
    newChars = Math.max(0, newChars + sizeDelta)
    clearTimer()
    const { armed, idleMs } = deps.config()
    if (armed) timer = setTimeout(check, idleMs)
  }

  const onUpdate = ({ transaction }: { transaction: Transaction }): void => {
    activity(transaction, transaction.doc.content.size - transaction.before.content.size)
  }
  const onSelection = ({ transaction }: { transaction: Transaction }): void => {
    if (!transaction.docChanged) activity(transaction, 0)
  }
  const onFocus = (): void => {
    focused = true
  }
  const onBlur = (): void => {
    focused = false
  }

  editor.on('update', onUpdate)
  editor.on('selectionUpdate', onSelection)
  editor.on('focus', onFocus)
  editor.on('blur', onBlur)

  return () => {
    disposed = true
    clearTimer()
    editor.off('update', onUpdate)
    editor.off('selectionUpdate', onSelection)
    editor.off('focus', onFocus)
    editor.off('blur', onBlur)
    if (!editor.isDestroyed && ghostOf(editor.state) !== null) editor.commands.clearGhost()
    if (storage?.onSettle === onSettle) storage.onSettle = null
  }
}

/**
 * Mounts the VibeWrite trigger loop on an editor (F-5.3). Safe to call from every region:
 * `active` is false outside the single-document view, and the hook arms itself only while
 * the project's VibeWrite toggle is on and the dial allows ghost text. Returns the subtle
 * failure line for the toolbar indicator (null when the last answer was fine).
 */
export function useGhostTextController({
  editor,
  nodeId,
  active
}: {
  editor: Editor | null
  nodeId: string
  active: boolean
}): { error: string | null } {
  const enabled = useAiSettingsStore((s) => s.settings?.ghostText.enabled ?? false)
  const allowed = useAiSettingsStore((s) =>
    s.settings ? isFeatureAllowed(s.settings, 'ghostText') : false
  )
  const idleMs = useAiSettingsStore((s) => s.settings?.ghostText.idleMs ?? DEFAULT_GHOST_IDLE_MS)
  const [error, setError] = useState<string | null>(null)
  const armed = active && enabled && allowed
  const config = useRef<GhostConfig>({ armed, idleMs })
  // Turning the mode on starts clean: the indicator's last failure is dropped.
  const [armedSeen, setArmedSeen] = useState(armed)
  if (armedSeen !== armed) {
    setArmedSeen(armed)
    if (armed) setError(null)
  }

  useEffect(() => {
    config.current = { armed, idleMs }
  }, [armed, idleMs])

  useEffect(() => {
    if (!editor || !active) return
    return startGhostSession({
      editor,
      nodeId,
      config: () => config.current,
      onError: setError,
      now: Date.now
    })
  }, [editor, nodeId, active])

  // Turning the mode off drops a suggestion still showing; turning it on resets the session's
  // back-off and the one-time toast, so the next failure is reported again.
  useEffect(() => {
    if (!editor) return
    if (!armed) {
      if (!editor.isDestroyed && ghostOf(editor.state) !== null) editor.commands.clearGhost()
    } else {
      session = { ...session, turnOffToastShown: false, failedAt: null }
    }
  }, [armed, editor])

  return { error }
}
