import { DICTIONARY_WORD_MAX } from './dictionary'

/**
 * Story names in the spellchecker (F-3.14). The names the author gave their entities and tags
 * are accepted words without being added to the project dictionary by hand, and a word one or
 * two letters away from one of them is pointed out, so a name is spelled the same way every
 * time. All of it is local string work: no AI, no request, nothing sent anywhere.
 */

/** A name word shorter than this is never compared: "Al" is one letter away from half the language. */
export const NEAR_NAME_MIN = 4

/** From this length on a word two letters away still counts as near; shorter names allow one. */
export const NEAR_NAME_TWO_FROM = 6

/** A run of letters, with the apostrophes inside it ("K'rath", "O’Neil"). */
const WORD = /\p{L}[\p{L}\p{M}'’]*/gu

/** A possessive ending or a trailing apostrophe, which is not part of the word being spelled. */
const POSSESSIVE = /(?:['’]s|['’]+)$/iu

/** One word of a text: where it is and how it reads, without a possessive ending. */
export interface TextWord {
  from: number
  to: number
  word: string
}

/** The words of `text` in order: "Mara's sword" → "Mara" at [0, 4) and "sword" at [7, 12). */
export function wordsIn(text: string): TextWord[] {
  const words: TextWord[] = []
  for (const match of text.matchAll(WORD)) {
    const word = match[0].replace(POSSESSIVE, '')
    if (word.length > 0) words.push({ from: match.index, to: match.index + word.length, word })
  }
  return words
}

/**
 * The words the spellchecker should accept for these entity and tag names, as the author spells
 * them: "Mara Voss" gives "Mara" and "Voss", the tag "rose-marsh" gives "rose" and "marsh".
 * Single letters are left out (the spellchecker never underlines them), as is anything longer
 * than a dictionary word may be. Unique and sorted.
 */
export function storyNameWords(names: readonly string[]): string[] {
  const words = new Set<string>()
  for (const name of names) {
    for (const { word } of wordsIn(name.normalize('NFC'))) {
      if (word.length >= 2 && word.length <= DICTIONARY_WORD_MAX) words.add(word)
    }
  }
  return [...words].sort((a, b) => a.localeCompare(b))
}

/** What a word is compared against: the names worth a suggestion and every word that is fine as it is. */
export interface NameIndex {
  /** Lower-cased name word → the spelling to offer, for names of `NEAR_NAME_MIN` letters or more. */
  names: Map<string, string>
  /** Lower-cased words that are never a near miss: the names themselves and the accepted words. */
  known: Set<string>
}

export interface NameIndexInput {
  /** Entity names, as the author spells them; their spelling is the one offered. */
  entityNames: readonly string[]
  /** Kebab-case names of the tags that name something in the story (a character, a place). */
  nameTagNames: readonly string[]
  /** Words that are right as they are: every other tag name, the dictionary, and the dismissed words. */
  accepted: readonly string[]
}

/** Builds the index once per change of the names; `nearName` then answers per word. */
export function buildNameIndex({ entityNames, nameTagNames, accepted }: NameIndexInput): NameIndex {
  const names = new Map<string, string>()
  const known = new Set<string>()
  // Entities first: their spelling carries the author's capitals, a tag's is lower-cased.
  for (const word of [...storyNameWords(entityNames), ...storyNameWords(nameTagNames)]) {
    const key = word.toLocaleLowerCase()
    known.add(key)
    if (key.length >= NEAR_NAME_MIN && !names.has(key)) names.set(key, word)
  }
  for (const word of storyNameWords(accepted)) known.add(word.toLocaleLowerCase())
  return { names, known }
}

/**
 * The edit distance between `a` and `b` (insert, delete, substitute, or swap two neighbouring
 * letters, each counting one), or `max + 1` as soon as it is known to be more than `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let twoBack: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (twoBack[j - 2] ?? 0) + 1)
      }
      current.push(value)
      if (value < best) best = value
    }
    if (best > max) return max + 1
    twoBack = previous
    previous = current
  }
  return Math.min(previous[b.length] ?? max + 1, max + 1)
}

/** `spelling` with the first letter in capitals when `word` starts with one and `spelling` has none. */
function matchCapital(spelling: string, word: string): string {
  const first = word.charAt(0)
  const typedCapital = first !== first.toLocaleLowerCase()
  if (!typedCapital || spelling !== spelling.toLocaleLowerCase()) return spelling
  return spelling.charAt(0).toLocaleUpperCase() + spelling.slice(1)
}

/**
 * The known name `word` is probably a slip for ("Marra" → "Mara"), or null: the word is short,
 * is a name or an accepted word itself, or is not within reach of any name (one letter for a
 * name of four or five, two from `NEAR_NAME_TWO_FROM` on). The closest name wins; between two
 * equally close, the first in the index. Whether the word is a real word of the language is the
 * caller's question for the spellchecker; this only measures.
 */
export function nearName(word: string, index: NameIndex): string | null {
  const lower = word.normalize('NFC').toLocaleLowerCase()
  if (lower.length < NEAR_NAME_MIN || index.known.has(lower)) return null
  let best: string | null = null
  let bestDistance = Number.POSITIVE_INFINITY
  for (const [key, spelling] of index.names) {
    const max = key.length >= NEAR_NAME_TWO_FROM ? 2 : 1
    const distance = editDistance(lower, key, max)
    if (distance <= max && distance < bestDistance) {
      best = spelling
      bestDistance = distance
    }
  }
  return best === null ? null : matchCapital(best, word)
}
