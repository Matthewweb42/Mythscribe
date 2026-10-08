import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { AddMarkStep, RemoveMarkStep } from '@tiptap/pm/transform'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { SettledStatus } from '@shared/proposal'
import { markAiOrigin } from './aiOrigin'
import { insertProse } from './insertProse'

/**
 * The suggestion while it is showing (F-5.3): the text still to accept and the document
 * position it hangs at (the caret when it was set, moved along as the author accepts or
 * types it). Never part of the document: the suggestion renders as a widget decoration, so
 * `getJSON`, autosave, and undo never see it until the author accepts it.
 */
export interface GhostState {
  /** What is still showing: `full` minus what the author has accepted or typed so far. */
  text: string
  /** The whole suggestion as it was shown, set once; the settlement is measured against it (F-14.5). */
  full: string
  from: number
  /** The suggestion failed the voice fidelity check (F-14.7): the widget carries a warning badge. */
  flagged: boolean
  /** The first violation in plain language when flagged ("switches to present tense"), else null. */
  violation: string | null
  /** The proposal behind the suggestion (F-14.5); accepted text is marked with it (F-14.6). Null inserts unmarked. */
  proposalId: string | null
  /** Characters accepted through Tab or Shift+Tab so far: the `accepted` baseline the mark carries (F-14.6). */
  acceptedChars: number
  /**
   * 2026-10-07: a suggestion the chat placed (an agent insertion), keyed by its landing. It is
   * pinned at its anchor rather than the caret: moving the caret, editing elsewhere, or leaving
   * the editor keeps it (the author is usually in the chat box when it lands); Tab, Shift+Tab,
   * and Escape still act on it, and the chat's card can settle it. Null for VibeWrite's own.
   */
  pin: string | null
}

/**
 * How a shown suggestion left the screen (F-14.5): `accepted` when all of it entered the
 * manuscript (Tab, Shift+Tab to the end, or typing it through), `acceptedPart` when some of it
 * did before anything else ended it, `rejected` when none did.
 */
export type GhostSettleStatus = Extract<SettledStatus, 'accepted' | 'acceptedPart' | 'rejected'>

/** Reports one shown suggestion's settlement; `consumed` is the prefix of `full` that entered the manuscript. */
export type GhostSettleHandler = (status: GhostSettleStatus, consumed: string) => void

/** How one suggestion left the screen, with what it was: the listeners' view (2026-10-07). */
export interface GhostExit {
  status: GhostSettleStatus
  consumed: string
  /** The suggestion's pin (`GhostState.pin`); null for VibeWrite's own. */
  pin: string | null
}

/**
 * The extension's per-editor storage: the settlement hook, set by the ghost-text controller
 * (it knows which proposal the suggestion belongs to) and null while nobody is listening; and
 * (2026-10-07) every other listener, such as a chat insertion waiting for its pinned
 * suggestion to be accepted or dismissed. Each hears every exit once and picks its own by pin.
 */
export interface GhostTextStorage {
  onSettle: GhostSettleHandler | null
  listeners: Set<(exit: GhostExit) => void>
}

/** Where `setGhost` puts a suggestion other than at the caret, and the pin that keeps it there. */
export interface GhostPlacement {
  /** A document position; the caret when absent. */
  at?: number
  /** Pins the suggestion (`GhostState.pin`). */
  pin?: string | null
}

/** What `streamGhost` may change besides the text, once the draft has finished. */
export interface GhostUpdate {
  flagged?: boolean
  violation?: string | null
  proposalId?: string | null
}

/**
 * The plugin state: the suggestion showing (null when none) and, on the transaction that
 * ended one, how it ended. The plugin view reports each `exit` once, so the hook fires exactly
 * once per shown suggestion whatever path took it off the screen.
 */
interface GhostPluginState {
  ghost: GhostState | null
  exit: GhostExit | null
}

const EMPTY: GhostPluginState = { ghost: null, exit: null }

type GhostMeta =
  | {
      type: 'set'
      text: string
      flagged: boolean
      violation: string | null
      proposalId: string | null
      at: number | null
      pin: string | null
    }
  | { type: 'advance'; text: string; from: number; acceptedChars: number }
  | { type: 'stream'; pin: string; full: string; update: GhostUpdate }
  | { type: 'accept' }
  | { type: 'clear' }

export const GHOST_TEXT_KEY = new PluginKey<GhostPluginState>('ghostText')

/** The class the widget carries; the stylesheet dims it and the e2e test reads it. */
export const GHOST_TEXT_CLASS = 'ghost-text'
/** The class of the warning badge inside a flagged widget (F-14.7). */
export const GHOST_TEXT_FLAG_CLASS = 'ghost-text-flag'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ghostText: {
      /**
       * Show `text` at the caret; false for empty text. `flagged` with the `violation` marks a
       * suggestion that failed the voice fidelity check (F-14.7) so the widget shows the badge;
       * `proposalId` is what accepted text is marked with (F-14.6), null inserts it unmarked.
       */
      setGhost: (
        text: string,
        flagged?: boolean,
        violation?: string | null,
        proposalId?: string | null,
        placement?: GhostPlacement
      ) => ReturnType
      /**
       * 2026-10-07: the pinned suggestion `pin` grows to `full` as its draft streams in (what the
       * author already took with Shift+Tab stays taken), and takes the draft's final flag and
       * proposal; false when that suggestion is no longer showing.
       */
      streamGhost: (pin: string, full: string, update?: GhostUpdate) => ReturnType
      /** Drop the suggestion without inserting anything; false when none is showing. */
      clearGhost: () => ReturnType
      /** Insert the whole remaining suggestion as plain text with the caret's marks (Tab). */
      acceptGhost: () => ReturnType
      /** Insert the next word plus its trailing space and keep the rest showing (Shift+Tab). */
      acceptGhostWord: () => ReturnType
    }
  }

  interface Storage {
    /** Present only for editors built with the ghost-text extension (manuscript documents). */
    ghostText?: GhostTextStorage
  }
}

/** The current suggestion, if any. */
export function ghostOf(state: EditorState): GhostState | null {
  return GHOST_TEXT_KEY.getState(state)?.ghost ?? null
}

/**
 * The settlement of `ghost` leaving the screen: all of it when the rest was just inserted,
 * otherwise whatever the author had accepted or typed along before this.
 */
function exitOf(ghost: GhostState, restInserted: boolean): GhostExit {
  const consumed = restInserted
    ? ghost.full
    : ghost.full.slice(0, ghost.full.length - ghost.text.length)
  const status: GhostSettleStatus =
    consumed.length === ghost.full.length
      ? 'accepted'
      : consumed.length > 0
        ? 'acceptedPart'
        : 'rejected'
  return { status, consumed, pin: ghost.pin }
}

const ended = (ghost: GhostState, restInserted: boolean): GhostPluginState => ({
  ghost: null,
  exit: exitOf(ghost, restInserted)
})

function applyMeta(tr: Transaction, meta: GhostMeta, ghost: GhostState | null): GhostPluginState {
  switch (meta.type) {
    case 'set': {
      // A suggestion replaced while showing ended without the rest: settle it on its own.
      const exit = ghost === null ? null : exitOf(ghost, false)
      if (!meta.text) return { ghost: null, exit }
      const from =
        meta.at === null ? tr.selection.from : Math.max(0, Math.min(meta.at, tr.doc.content.size))
      return {
        ghost: {
          text: meta.text,
          full: meta.text,
          from,
          flagged: meta.flagged,
          violation: meta.violation,
          proposalId: meta.proposalId,
          acceptedChars: 0,
          pin: meta.pin
        },
        exit
      }
    }
    case 'stream': {
      if (ghost?.pin !== meta.pin || ghost === null) return { ghost, exit: null }
      // What the author already took (Shift+Tab) stays taken; the rest is the new draft's.
      const taken = ghost.full.length - ghost.text.length
      const full = meta.full.length > taken ? meta.full : ghost.full
      return {
        ghost: {
          ...ghost,
          full,
          text: full.slice(taken),
          flagged: meta.update.flagged ?? ghost.flagged,
          violation: meta.update.violation === undefined ? ghost.violation : meta.update.violation,
          proposalId:
            meta.update.proposalId === undefined ? ghost.proposalId : meta.update.proposalId
        },
        exit: null
      }
    }
    case 'advance':
      return ghost === null
        ? EMPTY
        : {
            ghost: {
              ...ghost,
              text: meta.text,
              from: meta.from,
              acceptedChars: meta.acceptedChars
            },
            exit: null
          }
    case 'accept':
      return ghost === null ? EMPTY : ended(ghost, true)
    case 'clear':
      return ghost === null ? EMPTY : ended(ghost, false)
  }
}

/**
 * The next state for a transaction. Our own metadata wins outright; otherwise a change to the
 * document keeps the suggestion only when the author typed exactly its next characters at its
 * anchor (the typed prefix is consumed, so the widget shrinks; typing it through to the end
 * counts as accepting it), and a moved caret or a range selection drops it. Anything else (a
 * deletion, a paste, an edit elsewhere) drops it too: the spec says typing anything but the
 * suggestion clears it. Whatever ends a suggestion records its `exit` on this state only; the
 * next transaction starts clean.
 */
function apply(tr: Transaction, value: GhostPluginState): GhostPluginState {
  const meta = tr.getMeta(GHOST_TEXT_KEY) as GhostMeta | undefined
  const ghost = value.ghost
  if (meta !== undefined) return applyMeta(tr, meta, ghost)
  if (ghost === null) return value.exit === null ? value : EMPTY
  if (tr.docChanged) {
    // A mark-only change (the provenance plugin stripping a mark, F-14.6) neither types nor
    // moves anything: the suggestion stays.
    if (tr.steps.every((step) => step instanceof AddMarkStep || step instanceof RemoveMarkStep)) {
      return value.exit === null ? value : { ghost, exit: null }
    }
    if (ghost.pin !== null) {
      // 2026-10-07: a pinned suggestion follows its anchor through edits elsewhere and ends
      // only when the text it hangs on is deleted.
      const mapped = tr.mapping.mapResult(ghost.from, -1)
      if (mapped.deleted) return ended(ghost, false)
      return { ghost: { ...ghost, from: mapped.pos }, exit: null }
    }
    if (!tr.selection.empty) return ended(ghost, false)
    // Map the anchor to stay before text inserted exactly there (assoc -1), so what was typed
    // at it lies between the anchor and the caret.
    const mapped = tr.mapping.map(ghost.from, -1)
    const caret = tr.selection.from
    if (caret <= mapped) return ended(ghost, false)
    const typed = tr.doc.textBetween(mapped, caret)
    if (!typed || !ghost.text.startsWith(typed)) return ended(ghost, false)
    const rest = ghost.text.slice(typed.length)
    return rest ? { ghost: { ...ghost, text: rest, from: caret }, exit: null } : ended(ghost, true)
  }
  if (
    ghost.pin === null &&
    tr.selectionSet &&
    (!tr.selection.empty || tr.selection.from !== ghost.from)
  ) {
    return ended(ghost, false)
  }
  return value.exit === null ? value : { ghost, exit: null }
}

function renderGhost(ghost: GhostState): HTMLElement {
  const span = document.createElement('span')
  span.className = GHOST_TEXT_CLASS
  span.setAttribute('aria-hidden', 'true')
  // Line breaks as elements (2026-10-07): a chat insertion that opens a new paragraph starts with
  // a blank line, which the widget at the end of a paragraph showed as a space. The newline
  // stays in the text (so the widget reads as the suggestion) and collapses before its break.
  ghost.text.split('\n').forEach((line, index) => {
    if (index > 0) {
      span.appendChild(document.createTextNode('\n'))
      span.appendChild(document.createElement('br'))
    }
    if (line) span.appendChild(document.createTextNode(line))
  })
  span.dataset.flagged = ghost.flagged ? 'true' : 'false'
  if (ghost.flagged) {
    const flag = document.createElement('span')
    flag.className = GHOST_TEXT_FLAG_CLASS
    const violation = ghost.violation ?? 'does not match the voice profile'
    flag.title = violation
    flag.setAttribute('aria-label', `Voice warning: ${violation}`)
    flag.textContent = '⚠'
    span.appendChild(flag)
  }
  return span
}

/**
 * The next word of a suggestion: leading whitespace (a paragraph break included, so the split
 * lands with the word that opens the paragraph), the word, and one trailing space if present.
 */
const NEXT_WORD = /^(\s*\S+)( ?)/

/**
 * Inserts `text` at the suggestion's anchor as prose (`insertProse`: blank lines become
 * paragraphs, single newlines hard breaks) and, when it belongs to a proposal, marks it as
 * AI-origin with the running total of what the author has accepted from it (F-14.6). Returns
 * the position right after what was inserted.
 */
function insertAccepted(tr: Transaction, ghost: GhostState, text: string): number {
  const pos = insertProse(tr, ghost.from, text)
  if (ghost.proposalId !== null) {
    markAiOrigin(tr, ghost.from, pos, {
      proposalId: ghost.proposalId,
      accepted: ghost.acceptedChars + text.length
    })
  }
  return pos
}

/**
 * VibeWrite's ghost text (F-5.3): a widget decoration at the caret holding the AI's proposed
 * continuation, entirely in plugin state; a suggestion the fidelity check flagged (F-14.7)
 * renders with a warning badge that names the violation and keeps it through word-by-word
 * acceptance. Tab accepts everything, Shift+Tab one word, Escape
 * dismisses; typing the suggestion's own next character consumes it, typing anything else
 * clears it, as does moving the caret, leaving the editor, or starting an IME composition
 * (a composed insert lands in one step and cannot be matched character by character). The
 * accept commands insert plain text through an ordinary transaction, so the document store,
 * autosave, and undo treat the accepted text like typing; what they insert carries the
 * AI-origin mark of the suggestion's proposal (F-14.6), text the author types along does not.
 * Nothing here decides when to ask for a suggestion: the controller does, and it calls `setGhost`.
 *
 * Every shown suggestion is a proposal (F-14.5): whichever path takes it off the screen (an
 * accept, Escape, blur, a composition, a mismatching edit, a moved caret, a replacement, or
 * the editor being torn down) reports its settlement once through `storage.onSettle`.
 *
 * 2026-10-07: the chat's insertions use the same widget, pinned (`GhostState.pin`): placed at an
 * anchor rather than the caret, grown as the draft streams (`streamGhost`), kept through caret
 * moves, edits elsewhere, and blur, and reported to `storage.listeners` instead of `onSettle`.
 */
export const GhostText = Extension.create<Record<string, never>, GhostTextStorage>({
  name: 'ghostText',

  addStorage() {
    return { onSettle: null, listeners: new Set() }
  },

  addCommands() {
    return {
      setGhost:
        (text, flagged = false, violation = null, proposalId = null, placement = {}) =>
        ({ tr, dispatch }) => {
          if (!text) return false
          if (dispatch) {
            const meta: GhostMeta = {
              type: 'set',
              text,
              flagged,
              violation,
              proposalId,
              at: placement.at ?? null,
              pin: placement.pin ?? null
            }
            tr.setMeta(GHOST_TEXT_KEY, meta)
          }
          return true
        },
      streamGhost:
        (pin, full, update = {}) =>
        ({ state, tr, dispatch }) => {
          if (ghostOf(state)?.pin !== pin || !full) return false
          if (dispatch) {
            tr.setMeta(GHOST_TEXT_KEY, { type: 'stream', pin, full, update } satisfies GhostMeta)
          }
          return true
        },
      clearGhost:
        () =>
        ({ state, tr, dispatch }) => {
          if (ghostOf(state) === null) return false
          if (dispatch) tr.setMeta(GHOST_TEXT_KEY, { type: 'clear' } satisfies GhostMeta)
          return true
        },
      acceptGhost:
        () =>
        ({ state, tr, dispatch }) => {
          const ghost = ghostOf(state)
          if (ghost === null) return false
          if (dispatch) {
            insertAccepted(tr, ghost, ghost.text)
            tr.setMeta(GHOST_TEXT_KEY, { type: 'accept' } satisfies GhostMeta)
            tr.scrollIntoView()
          }
          return true
        },
      acceptGhostWord:
        () =>
        ({ state, tr, dispatch }) => {
          const ghost = ghostOf(state)
          if (ghost === null) return false
          const match = NEXT_WORD.exec(ghost.text)
          if (!match) return false
          const chunk = `${match[1] ?? ''}${match[2] ?? ''}`
          const remaining = ghost.text.slice(chunk.length)
          if (dispatch) {
            const end = insertAccepted(tr, ghost, chunk)
            const meta: GhostMeta = remaining
              ? {
                  type: 'advance',
                  text: remaining,
                  from: end,
                  acceptedChars: ghost.acceptedChars + chunk.length
                }
              : { type: 'accept' }
            tr.setMeta(GHOST_TEXT_KEY, meta)
            tr.scrollIntoView()
          }
          return true
        }
    }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => this.editor.commands.acceptGhost(),
      'Shift-Tab': () => this.editor.commands.acceptGhostWord(),
      Escape: () => this.editor.commands.clearGhost()
    }
  },

  addProseMirrorPlugins() {
    const storage = this.storage
    const report = (exit: GhostExit): void => {
      // VibeWrite's controller settles its own suggestions; a pinned one belongs to its listener.
      if (exit.pin === null) storage.onSettle?.(exit.status, exit.consumed)
      for (const listener of [...storage.listeners]) listener(exit)
    }
    // Leaving the editor or composing drops VibeWrite's suggestion, never a pinned one.
    const clear = (view: { state: EditorState; dispatch: (tr: Transaction) => void }): false => {
      const ghost = ghostOf(view.state)
      if (ghost !== null && ghost.pin === null) {
        view.dispatch(view.state.tr.setMeta(GHOST_TEXT_KEY, { type: 'clear' } satisfies GhostMeta))
      }
      return false
    }
    return [
      new Plugin<GhostPluginState>({
        key: GHOST_TEXT_KEY,
        state: { init: () => EMPTY, apply },
        view: (editorView) => {
          // A reconfigured plugin set recreates this view while the suggestion lives on in the
          // new state; only a view destroyed with its own plugins in place is the editor going.
          const plugins = editorView.state.plugins
          return {
            update: (view, prevState) => {
              const exit = GHOST_TEXT_KEY.getState(view.state)?.exit ?? null
              if (exit !== null && exit !== GHOST_TEXT_KEY.getState(prevState)?.exit) report(exit)
            },
            destroy: () => {
              if (editorView.state.plugins !== plugins) return
              const ghost = ghostOf(editorView.state)
              if (ghost !== null) report(exitOf(ghost, false))
            }
          }
        },
        props: {
          decorations(state) {
            const ghost = ghostOf(state)
            if (ghost === null) return DecorationSet.empty
            return DecorationSet.create(state.doc, [
              Decoration.widget(ghost.from, () => renderGhost(ghost), {
                side: 1,
                ignoreSelection: true
              })
            ])
          },
          handleDOMEvents: { blur: clear, compositionstart: clear }
        }
      })
    ]
  }
})
