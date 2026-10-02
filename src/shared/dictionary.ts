import { z } from 'zod'

/**
 * The per-project spelling dictionary (F-3.11): the words the author told the spellchecker to
 * accept in this project. It is a local list, no AI and nothing sent anywhere. Main keeps the
 * spellchecker's own custom list equal to the open project's words, so a name accepted in one
 * novel is still underlined in another.
 */

/** Settings-table key under which the project dictionary is stored as JSON. */
export const DICTIONARY_KEY = 'dictionary'

/** Longest word the dictionary takes; the spellchecker itself refuses anything much longer. */
export const DICTIONARY_WORD_MAX = 64

/** Most suggestions the spelling menu lists for one misspelled word. */
export const MAX_SPELL_SUGGESTIONS = 5

/** One dictionary word: trimmed, not empty, and a single word (the spellchecker checks word by word). */
export const DictionaryWord = z
  .string()
  .trim()
  .min(1, 'Type a word')
  .max(DICTIONARY_WORD_MAX, `A word can be at most ${DICTIONARY_WORD_MAX} characters`)
  .regex(/^\S+$/, 'One word at a time, without spaces')
export type DictionaryWord = z.infer<typeof DictionaryWord>

/**
 * The project's accepted words, unique and sorted, and the words the author said are not a
 * misspelled story name (F-3.14), lower-cased, unique and sorted.
 */
export const ProjectDictionary = z.object({
  words: z.array(z.string()).default([]),
  notNames: z.array(z.string()).default([])
})
export type ProjectDictionary = z.infer<typeof ProjectDictionary>

/** The empty dictionary a project without a stored row (or with an unreadable one) starts from. */
export function defaultProjectDictionary(): ProjectDictionary {
  return { words: [], notNames: [] }
}

/**
 * The dictionary with `word` in it. Case-sensitive, as the spellchecker is ("Mara" does not
 * accept "mara"); the list stays unique and sorted. Answers the same object when the word is
 * already there, so a caller can tell that nothing changed.
 */
export function addWord(dict: ProjectDictionary, word: string): ProjectDictionary {
  if (dict.words.includes(word)) return dict
  return { ...dict, words: [...dict.words, word].sort((a, b) => a.localeCompare(b)) }
}

/** The dictionary without `word`; the same object when the word was not in it. */
export function removeWord(dict: ProjectDictionary, word: string): ProjectDictionary {
  if (!dict.words.includes(word)) return dict
  return { ...dict, words: dict.words.filter((w) => w !== word) }
}

/**
 * The dictionary with `word` remembered as not a name (F-3.14): the near-name underline leaves
 * it alone from then on, however it is capitalized. The same object when it is already there.
 */
export function addNotName(dict: ProjectDictionary, word: string): ProjectDictionary {
  const key = word.toLocaleLowerCase()
  if (dict.notNames.includes(key)) return dict
  return { ...dict, notNames: [...dict.notNames, key].sort((a, b) => a.localeCompare(b)) }
}

/**
 * What the spellchecker accepts while the project is open (F-3.14): the author's own words and
 * the words of the story's names, which are derived on every sync rather than stored, so a
 * renamed or deleted name leaves no word behind.
 */
export function spellcheckWords(dict: ProjectDictionary, nameWords: readonly string[]): string[] {
  return [...new Set([...dict.words, ...nameWords])]
}
