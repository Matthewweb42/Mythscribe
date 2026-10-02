import { MAX_SPELL_SUGGESTIONS } from '@shared/dictionary'

/** The parts of Electron's `ContextMenuParams` the spelling menu reads (F-3.11). */
export interface SpellMenuParams {
  misspelledWord: string
  dictionarySuggestions: string[]
  isEditable: boolean
}

/** What the `spellcheck:menu` event carries: the underlined word and what could replace it. */
export interface SpellMenuPayload {
  word: string
  suggestions: string[]
}

/**
 * The spelling menu for a right-click (F-3.11), or null when there is none to show: the click
 * was not in an editable, or not on a word the spellchecker underlined. The suggestions are
 * capped so the menu stays a menu.
 */
export function spellMenuPayload(params: SpellMenuParams): SpellMenuPayload | null {
  if (!params.isEditable || params.misspelledWord === '') return null
  return {
    word: params.misspelledWord,
    suggestions: params.dictionarySuggestions.slice(0, MAX_SPELL_SUGGESTIONS)
  }
}
