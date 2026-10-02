/** Answers whether the spellchecker underlines a word. */
export type SpellChecker = (word: string) => boolean

let override: SpellChecker | null = null

/**
 * Whether the spellchecker underlines `word` (F-3.14), asked of the preload bridge
 * (`webFrame.isWordMisspelled`). False when there is no bridge, when the bridge is older than
 * the method, or when the call throws: a word nobody can check is left alone.
 */
export function isWordMisspelled(word: string): boolean {
  try {
    if (override !== null) return override(word)
    if (typeof window === 'undefined') return false
    return window.mythscribe?.isWordMisspelled?.(word) ?? false
  } catch {
    return false
  }
}

/** Replaces the spellchecker, or puts the bridge's back with null. For tests only. */
export function setSpellChecker(next: SpellChecker | null): void {
  override = next
}
