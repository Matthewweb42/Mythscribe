/**
 * The parts of Electron's `Session` the spelling dictionary needs (F-3.11); structural so tests
 * can pass a fake.
 */
export interface SpellSession {
  listWordsInSpellCheckerDictionary(): Promise<string[]>
  addWordToSpellCheckerDictionary(word: string): boolean
  removeWordFromSpellCheckerDictionary(word: string): boolean
}

export interface SessionDictionary {
  /** Makes the spellchecker's custom words exactly `words`; resolves once that sync has run. */
  sync(words: string[]): Promise<void>
}

/**
 * Keeps the spellchecker's custom word list equal to the open project's dictionary (F-3.11).
 *
 * Electron stores custom words in the profile, where every project would share them, so adding
 * a project's words on open is not enough: the words of the project before would stay accepted.
 * `sync` instead lists what the session holds, removes what is not wanted, and adds what is
 * missing. It is called with the project's words on every change and with `[]` on close and at
 * startup, which also cleans up after a crash. On macOS and Windows Electron writes added words
 * to the OS's own custom dictionary too; the same removal takes them out again.
 *
 * Calls are serialized on one promise chain, so two quick syncs end at the second list. A
 * failure (the session refusing to list its words) goes to `onError` and never rejects: the
 * project still opens, with the spellchecker left as it was.
 */
export function createSessionDictionary(
  session: SpellSession,
  onError: (err: unknown) => void
): SessionDictionary {
  let chain: Promise<void> = Promise.resolve()

  const run = async (words: string[]): Promise<void> => {
    const wanted = new Set(words)
    const current = new Set(await session.listWordsInSpellCheckerDictionary())
    for (const word of current) {
      if (!wanted.has(word)) session.removeWordFromSpellCheckerDictionary(word)
    }
    for (const word of wanted) {
      if (!current.has(word)) session.addWordToSpellCheckerDictionary(word)
    }
  }

  return {
    sync(words) {
      const wanted = [...words]
      chain = chain.then(() => run(wanted)).catch(onError)
      return chain
    }
  }
}
