import type { Editor } from '@tiptap/core'
import type { Node as PmNode } from '@tiptap/pm/model'
import type { AgentEdit } from '@shared/agent'
import { CHAT_SCENE_CHAR_BUDGET } from '@shared/chat'
import { REWRITE_CONTEXT_CHARS, REWRITE_TEXT_MAX, REWRITE_TEXT_MIN } from '@shared/rewrite'
import type { AiChatResult } from '@shared/ipc/contract'
import { reportAiNote } from '@renderer/features/devtools/rendererDevLog'
import { useActiveEditorStore } from '@renderer/features/editor/activeEditorStore'
import { AgentEditError, endOfText } from '@renderer/features/editor/agentEditing'
import {
  GHOST_TEXT_CLASS,
  ghostOf,
  type GhostExit,
  type GhostUpdate
} from '@renderer/features/editor/ghostText'
import { locateUniqueText } from '@renderer/features/editor/locateText'
import { describeError } from '@renderer/lib/errors'
import { ipc } from '@renderer/lib/ipc'
import { openEditor } from './agentApply'
import { useAiActivityStore } from './aiActivityStore'
import { proposalStore } from './proposalStore'

/**
 * The chat agent's insertions land in the editor as ghost text (2026-10-07, the author's
 * decision after reporting that they never did): the agent names what to write and where, this
 * resolves the anchor in the live document, asks main for the prose (`ai:agentDraft`, streamed),
 * and shows it as a pinned ghost suggestion at the anchor while it arrives. Tab accepts and
 * Escape dismisses as with VibeWrite, in normal and focus mode alike (one editor); the chat's
 * card can do either. In Auto the suggestion is accepted once the draft is in, unless the voice
 * check flagged it. Every step is noted for the developer tools' AI inspector.
 */

/** Where an insertion goes: the position, what goes before the prose, and why it is not the anchor. */
export interface InsertAnchor {
  pos: number
  /** A paragraph break after a paragraph with text, a space mid-paragraph, or nothing. */
  prefix: string
  /** Said on the card when the anchor text was not found once and the caret (or end) was used. */
  notice: string | null
}

const quoteOf = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 60 ? `${flat.slice(0, 59).trimEnd()}…` : flat
}

/** What precedes prose placed at `pos`, so it reads as its own paragraph or runs on cleanly. */
function prefixAt(doc: PmNode, pos: number): string {
  const $pos = doc.resolve(pos)
  if (!$pos.parent.isTextblock || $pos.parent.content.size === 0) return ''
  if ($pos.parentOffset === $pos.parent.content.size) return '\n\n'
  if ($pos.parentOffset === 0) return ''
  const before = doc.textBetween(pos - 1, pos)
  return /\s/.test(before) ? '' : ' '
}

/**
 * Where the agent's insertion goes in `doc`: after the paragraph holding `after` when the
 * document has it exactly once (as `insertParagraphs` places one); otherwise, and for an empty
 * `after`, at `caret` (the open document's caret) or the end of the text. A missing or repeated
 * anchor says so in `notice`.
 */
export function resolveInsertAnchor(
  doc: PmNode,
  after: string,
  caret: number | null
): InsertAnchor {
  const fallback = (notice: string | null): InsertAnchor => {
    const pos = caret ?? endOfText(doc)
    return { pos, prefix: prefixAt(doc, pos), notice }
  }
  if (after.trim() === '') return fallback(null)
  const range = locateUniqueText(doc, after)
  if (range === 'missing' || range === 'ambiguous') {
    const where = caret === null ? 'at the end' : 'at the caret'
    const why = range === 'missing' ? 'is not in the scene' : 'occurs more than once'
    return fallback(`“${quoteOf(after)}” ${why}; placed ${where} instead.`)
  }
  const $to = doc.resolve(range.to)
  const pos = $to.end($to.depth)
  return { pos, prefix: prefixAt(doc, pos), notice: null }
}

/** How a landing ended. */
export type LandingOutcome =
  | {
      status: 'accepted' | 'acceptedPart' | 'rejected'
      /** What entered the manuscript, trimmed; empty when rejected. */
      text: string
      proposalId: string | null
      notice: string | null
    }
  | { status: 'failed'; error: string | null }

export interface LandingHooks {
  /** The draft is on its way (`writing`, its text so far) or waiting in the editor (`shown`). */
  progress: (status: 'writing' | 'shown', text: string) => void
}

/** A landing in progress, so the card's Accept and Dismiss reach its suggestion. */
interface Landing {
  editor: Editor
  pin: string
}

const landings = new Map<string, Landing>()

/** The card's Accept: takes the whole suggestion of change `changeId`; false when none shows. */
export function acceptLanding(changeId: string): boolean {
  const landing = landings.get(changeId)
  if (landing === undefined || landing.editor.isDestroyed) return false
  if (ghostOf(landing.editor.state)?.pin !== landing.pin) return false
  return landing.editor.commands.acceptGhost()
}

/** The card's Dismiss: drops the suggestion of change `changeId`; false when none shows. */
export function dismissLanding(changeId: string): boolean {
  const landing = landings.get(changeId)
  if (landing === undefined || landing.editor.isDestroyed) return false
  if (ghostOf(landing.editor.state)?.pin !== landing.pin) return false
  return landing.editor.commands.clearGhost()
}

/** Drops every landing's handle. For tests and project close. */
export function resetLandings(): void {
  landings.clear()
}

/** Scrolls the suggestion (or the anchor before it shows) into view. */
function reveal(editor: Editor, pos: number): void {
  const ghost = editor.view.dom.querySelector(`.${GHOST_TEXT_CLASS}`)
  const target =
    ghost instanceof HTMLElement
      ? ghost
      : (() => {
          const { node } = editor.view.domAtPos(pos)
          return node instanceof HTMLElement ? node : node.parentElement
        })()
  target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
}

/**
 * Lands one drafted insertion (`isDraftIntent`) of change `changeId` in its scene, as described
 * above. Opens the scene first (the tree's selection drives the editor, normal or focus mode),
 * then resolves the anchor against the live text. Resolves once the author (or Auto) settled the
 * suggestion, or the draft failed; the drafted proposal is settled with the outcome (F-14.5).
 */
export async function landDraft(
  changeId: string,
  edit: Extract<AgentEdit, { kind: 'insert' }>,
  options: { requestId: string; autoAccept: boolean },
  hooks: LandingHooks
): Promise<LandingOutcome> {
  const { requestId } = options
  const note = (text: string): void => reportAiNote(requestId, text)
  const active = useActiveEditorStore.getState().active
  const wasOpen = active?.id === edit.nodeId && !active.editor.isDestroyed
  let editor: Editor
  try {
    editor = await openEditor(edit.nodeId)
  } catch (err) {
    note(`Nothing shown: ${describeError(err)} (${edit.title})`)
    return { status: 'failed', error: describeError(err) }
  }
  let anchor: InsertAnchor
  try {
    anchor = resolveInsertAnchor(
      editor.state.doc,
      edit.after,
      wasOpen ? editor.state.selection.from : null
    )
  } catch (err) {
    if (err instanceof AgentEditError) return { status: 'failed', error: err.message }
    throw err
  }
  reveal(editor, anchor.pos)
  const before = editor.state.doc.textBetween(0, anchor.pos, '\n\n').slice(-CHAT_SCENE_CHAR_BUDGET)

  const pin = `${changeId}:${requestId}`
  landings.set(changeId, { editor, pin })
  /** Mutated by the listener and the stream: what shows, and how it ended once it did. */
  const live: { shown: boolean; drafted: string; exit: GhostExit | null } = {
    shown: false,
    drafted: '',
    exit: null
  }
  let settleExit: (exit: GhostExit) => void = () => undefined
  const exited = new Promise<GhostExit>((resolve) => {
    settleExit = resolve
  })
  const listener = (ended: GhostExit): void => {
    if (ended.pin !== pin) return
    live.exit = ended
    settleExit(ended)
  }
  const storage = editor.storage.ghostText
  storage?.listeners.add(listener)
  const finish = (): void => {
    storage?.listeners.delete(listener)
    landings.delete(changeId)
    if (!editor.isDestroyed && ghostOf(editor.state)?.pin === pin) editor.commands.clearGhost()
  }
  const show = (text: string, update?: GhostUpdate): void => {
    if (editor.isDestroyed || live.exit !== null) return
    const full = `${anchor.prefix}${text}`
    if (!live.shown) {
      live.shown = editor.commands.setGhost(
        full,
        update?.flagged ?? false,
        update?.violation ?? null,
        update?.proposalId ?? null,
        { at: anchor.pos, pin }
      )
      if (live.shown) reveal(editor, anchor.pos)
      return
    }
    editor.commands.streamGhost(pin, full, update)
  }
  const unsubscribe = ipc().on('ai:agentDraftDelta', (event) => {
    if (event.requestId !== requestId) return
    live.drafted += event.delta
    hooks.progress('writing', live.drafted)
    show(live.drafted)
    // The author dismissed it while it streamed: nothing more is wanted.
    if (live.exit !== null) void useAiActivityStore.getState().cancel(requestId)
  })
  hooks.progress('writing', '')
  note(
    anchor.notice === null
      ? `Insertion into ${edit.title} at position ${anchor.pos}${edit.after ? ' (after its anchor)' : ' (at the caret)'}`
      : `Insertion into ${edit.title}: ${anchor.notice}`
  )

  let result: AiChatResult
  try {
    result = await useAiActivityStore.getState().track(
      'agent',
      requestId,
      ipc().invoke('ai:agentDraft', {
        nodeId: edit.nodeId,
        brief: edit.brief,
        words: edit.words,
        before,
        after: '',
        passage: null,
        requestId
      })
    )
  } catch (err) {
    finish()
    return { status: 'failed', error: describeError(err) }
  } finally {
    unsubscribe()
  }

  if (!result.ok) {
    finish()
    note(`Nothing shown: the draft failed (${result.code}: ${result.message})`)
    return {
      status: 'failed',
      error: result.code === 'CANCELLED' ? null : `${result.message} ${result.nextStep}`.trim()
    }
  }
  const final = {
    flagged: result.flagged,
    violation: result.violation,
    proposalId: result.proposalId
  }
  show(result.text, final)
  if (live.shown && live.exit === null) {
    hooks.progress('shown', result.text)
    if (options.autoAccept && !result.flagged) editor.commands.acceptGhost()
  }
  if (!live.shown && live.exit === null) {
    finish()
    note('Nothing shown: the editor refused the suggestion')
    void proposalStore.settle(result.proposalId, 'rejected', null)
    return { status: 'failed', error: 'The scene could not show the text' }
  }
  const ended = live.exit ?? (await exited)
  storage?.listeners.delete(listener)
  landings.delete(changeId)
  void proposalStore.settle(result.proposalId, ended.status, null)
  note(
    ended.status === 'rejected'
      ? 'Dismissed in the editor'
      : `${ended.status === 'accepted' ? 'Accepted' : 'Partly accepted'} (${ended.consumed.trim().length} characters)${options.autoAccept && !result.flagged ? ' automatically (Auto)' : ''}`
  )
  return {
    status: ended.status,
    text: ended.consumed.trim(),
    proposalId: result.proposalId,
    notice: anchor.notice
  }
}

/**
 * The replacement for a rewrite intent (`isRewriteIntent`), drafted from the live passage and
 * its context and streamed to `onText`; the card then shows it like any replacement, waiting for
 * Apply in Ask. Main voice-checks it; the flag comes back with it.
 */
export async function draftReplacement(
  edit: Extract<AgentEdit, { kind: 'text' }>,
  requestId: string,
  onText: (text: string) => void
): Promise<AiChatResult | { ok: false; error: string }> {
  const passage = edit.find
  if (passage.length < REWRITE_TEXT_MIN || passage.length > REWRITE_TEXT_MAX) {
    return { ok: false, error: 'The passage is too short or too long to rewrite' }
  }
  let context = { before: '', after: '' }
  const active = useActiveEditorStore.getState().active
  if (active?.id === edit.nodeId && !active.editor.isDestroyed) {
    const doc = active.editor.state.doc
    const range = locateUniqueText(doc, passage)
    if (typeof range !== 'string') {
      context = {
        before: doc.textBetween(0, range.from, '\n\n').slice(-REWRITE_CONTEXT_CHARS),
        after: doc.textBetween(range.to, doc.content.size, '\n\n').slice(0, REWRITE_CONTEXT_CHARS)
      }
    }
  }
  let drafted = ''
  const unsubscribe = ipc().on('ai:agentDraftDelta', (event) => {
    if (event.requestId !== requestId) return
    drafted += event.delta
    onText(drafted)
  })
  try {
    return await useAiActivityStore.getState().track(
      'agent',
      requestId,
      ipc().invoke('ai:agentDraft', {
        nodeId: edit.nodeId,
        brief: edit.brief,
        words: 0,
        before: context.before,
        after: context.after,
        passage,
        requestId
      })
    )
  } catch (err) {
    return { ok: false, error: describeError(err) }
  } finally {
    unsubscribe()
  }
}
