import { Extension } from '@tiptap/core'
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * The plugin state while a suggestion is showing (F-5.3): the text still to accept and the
 * document position it hangs at (the caret when it was set, moved along as the author
 * accepts or types it). Null when nothing is showing. Never part of the document: the
 * suggestion renders as a widget decoration, so `getJSON`, autosave, and undo never see it
 * until the author accepts it.
 */
export interface GhostState {
  text: string
  from: number
  /** The suggestion failed the voice fidelity check (F-14.7): the widget carries a warning badge. */
  flagged: boolean
  /** The first violation in plain language when flagged ("switches to present tense"), else null. */
  violation: string | null
}

type GhostMeta =
  | { type: 'set'; text: string; flagged: boolean; violation: string | null }
  | { type: 'advance'; text: string; from: number; flagged: boolean; violation: string | null }
  | { type: 'clear' }

export const GHOST_TEXT_KEY = new PluginKey<GhostState | null>('ghostText')

/** The class the widget carries; the stylesheet dims it and the e2e test reads it. */
export const GHOST_TEXT_CLASS = 'ghost-text'
/** The class of the warning badge inside a flagged widget (F-14.7). */
export const GHOST_TEXT_FLAG_CLASS = 'ghost-text-flag'

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    ghostText: {
      /**
       * Show `text` at the caret; false for empty text. `flagged` with the `violation` marks a
       * suggestion that failed the voice fidelity check (F-14.7) so the widget shows the badge.
       */
      setGhost: (text: string, flagged?: boolean, violation?: string | null) => ReturnType
      /** Drop the suggestion without inserting anything; false when none is showing. */
      clearGhost: () => ReturnType
      /** Insert the whole remaining suggestion as plain text with the caret's marks (Tab). */
      acceptGhost: () => ReturnType
      /** Insert the next word plus its trailing space and keep the rest showing (Shift+Tab). */
      acceptGhostWord: () => ReturnType
    }
  }
}

/** The current suggestion, if any. */
export function ghostOf(state: EditorState): GhostState | null {
  return GHOST_TEXT_KEY.getState(state) ?? null
}

/**
 * The next state for a transaction. Our own metadata wins outright; otherwise a change to the
 * document keeps the suggestion only when the author typed exactly its next characters at its
 * anchor (the typed prefix is consumed, so the widget shrinks), and a moved caret or a range
 * selection drops it. Anything else (a deletion, a paste, an edit elsewhere) drops it too:
 * the spec says typing anything but the suggestion clears it.
 */
function apply(tr: Transaction, value: GhostState | null): GhostState | null {
  const meta = tr.getMeta(GHOST_TEXT_KEY) as GhostMeta | undefined
  if (meta !== undefined) {
    if (meta.type === 'clear') return null
    const { text, flagged, violation } = meta
    if (!text) return null
    const from = meta.type === 'set' ? tr.selection.from : meta.from
    return { text, from, flagged, violation }
  }
  if (value === null) return null
  if (tr.docChanged) {
    if (!tr.selection.empty) return null
    // Map the anchor to stay before text inserted exactly there (assoc -1), so what was typed
    // at it lies between the anchor and the caret.
    const mapped = tr.mapping.map(value.from, -1)
    const caret = tr.selection.from
    if (caret <= mapped) return null
    const typed = tr.doc.textBetween(mapped, caret)
    if (!typed || !value.text.startsWith(typed)) return null
    const rest = value.text.slice(typed.length)
    return rest ? { ...value, text: rest, from: caret } : null
  }
  if (tr.selectionSet && (!tr.selection.empty || tr.selection.from !== value.from)) return null
  return value
}

function renderGhost(ghost: GhostState): HTMLElement {
  const span = document.createElement('span')
  span.className = GHOST_TEXT_CLASS
  span.setAttribute('aria-hidden', 'true')
  span.textContent = ghost.text
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

/** The next word of a suggestion: leading whitespace, the word, and one trailing space if present. */
const NEXT_WORD = /^(\s*\S+)(\s?)/

/**
 * VibeWrite's ghost text (F-5.3): a widget decoration at the caret holding the AI's proposed
 * continuation, entirely in plugin state; a suggestion the fidelity check flagged (F-14.7)
 * renders with a warning badge that names the violation and keeps it through word-by-word
 * acceptance. Tab accepts everything, Shift+Tab one word, Escape
 * dismisses; typing the suggestion's own next character consumes it, typing anything else
 * clears it, as does moving the caret, leaving the editor, or starting an IME composition
 * (a composed insert lands in one step and cannot be matched character by character). The
 * accept commands insert plain text through an ordinary transaction, so the document store,
 * autosave, and undo treat the accepted text like typing. Nothing here decides when to ask
 * for a suggestion: the controller does, and it calls `setGhost`.
 */
export const GhostText = Extension.create({
  name: 'ghostText',

  addCommands() {
    return {
      setGhost:
        (text, flagged = false, violation = null) =>
        ({ tr, dispatch }) => {
          if (!text) return false
          if (dispatch) {
            const meta: GhostMeta = { type: 'set', text, flagged, violation }
            tr.setMeta(GHOST_TEXT_KEY, meta)
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
            tr.insertText(ghost.text, ghost.from)
            tr.setMeta(GHOST_TEXT_KEY, { type: 'clear' } satisfies GhostMeta)
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
            tr.insertText(chunk, ghost.from)
            const meta: GhostMeta = remaining
              ? {
                  type: 'advance',
                  text: remaining,
                  from: ghost.from + chunk.length,
                  flagged: ghost.flagged,
                  violation: ghost.violation
                }
              : { type: 'clear' }
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
    const clear = (view: { state: EditorState; dispatch: (tr: Transaction) => void }): false => {
      if (ghostOf(view.state) !== null) {
        view.dispatch(view.state.tr.setMeta(GHOST_TEXT_KEY, { type: 'clear' } satisfies GhostMeta))
      }
      return false
    }
    return [
      new Plugin<GhostState | null>({
        key: GHOST_TEXT_KEY,
        state: { init: () => null, apply },
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
