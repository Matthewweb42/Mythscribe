import { create } from 'zustand'
import { REPLACE_QUERY_MAX, REPLACEMENT_MAX } from '@shared/replace'
import { useActiveEditorStore } from './activeEditorStore'
import { selectedText } from './selectedText'

/**
 * The find bar of the open document (F-3.10): whether it shows, whether its replace row does,
 * what is typed, and the options. One bar for the project screen; it follows the active editor
 * (`useActiveEditorStore`), and `FindBar` pushes these fields to that editor's `FindReplace`
 * extension. `focusTick` grows on every open, so a repeated Ctrl+F refocuses the find field.
 */
interface FindStoreState {
  open: boolean
  showReplace: boolean
  query: string
  replacement: string
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
  focusTick: number
  /**
   * Opens the bar, with the replace row when `replace` (Ctrl+H) and without it otherwise
   * (Ctrl+F). A non-empty, single-line selection in the active editor becomes the query (escaped
   * in regex mode, so it still finds itself).
   */
  openFind: (replace: boolean) => void
  close: () => void
  setShowReplace: (showReplace: boolean) => void
  setQuery: (query: string) => void
  setReplacement: (replacement: string) => void
  setMatchCase: (matchCase: boolean) => void
  setWholeWord: (wholeWord: boolean) => void
  setRegex: (regex: boolean) => void
}

const INITIAL = {
  open: false,
  showReplace: false,
  query: '',
  replacement: '',
  matchCase: false,
  wholeWord: false,
  regex: false,
  focusTick: 0
}

/** `text` as a pattern that matches exactly it. */
export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** The active editor's selection as a query, or null when it is empty, multi-line, or too long. */
function selectionQuery(regex: boolean): string | null {
  const editor = useActiveEditorStore.getState().active?.editor
  if (editor === undefined || editor.isDestroyed || editor.state.selection.empty) return null
  const text = selectedText(editor)
  if (text === '' || text.includes('\n')) return null
  const query = regex ? escapeRegex(text) : text
  return query.length > REPLACE_QUERY_MAX ? null : query
}

export const useFindStore = create<FindStoreState>((set, get) => ({
  ...INITIAL,

  openFind(replace) {
    const prefill = selectionQuery(get().regex)
    set((state) => ({
      open: true,
      showReplace: replace,
      query: prefill ?? state.query,
      focusTick: state.focusTick + 1
    }))
  },

  close: () => set({ open: false }),
  setShowReplace: (showReplace) => set({ showReplace }),
  setQuery: (query) => set({ query: query.slice(0, REPLACE_QUERY_MAX) }),
  setReplacement: (replacement) => set({ replacement: replacement.slice(0, REPLACEMENT_MAX) }),
  setMatchCase: (matchCase) => set({ matchCase }),
  setWholeWord: (wholeWord) => set({ wholeWord }),
  setRegex: (regex) => set({ regex })
}))

/** Closes the bar and forgets what was typed: the project closed, or a test starts. */
export function resetFindStore(): void {
  useFindStore.setState(INITIAL)
}
