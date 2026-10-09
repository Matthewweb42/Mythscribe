import { nameWords } from './mentions'
import { opensSentence, PROPOSED_ORDINARY_MIN_MENTIONS, STOPLIST } from './proposedTags'
import { toTagName } from './tags'

/**
 * Which AI-made tags are names (the author's tag rule, 2026-10-08): "Tags should be capitalized
 * words, and any abnormal words like memorial fragments that could potentially be tags", and an
 * ordinary word is not banned outright: "if they are used frequently in abnormal ways, they can be
 * potential tags". Decided by Claude, unconfirmed: the rule reads the manuscript itself — how the
 * text writes the term — rather than a word list (none ships with the app) or a prompt change.
 * Local and deterministic: no AI, nothing sent anywhere.
 *
 * - `name`: the text writes it capitalised every time (Marta, Greywater, "the Tide Reckoning").
 * - `term`: a phrase of several words the text repeats (`TERM_PHRASE_MIN_REPEATS`, "memorial
 *   fragments" five times): a coined term even in ordinary words.
 * - `unusual`: an ordinary word the text also capitalises mid-sentence often
 *   (`PROPOSED_ORDINARY_MIN_MENTIONS`, "the Trial"): proposed (F-4.12b), never applied on its own.
 * - `ordinary`: an ordinary word used normally ("custom", "a fair trial").
 * - `absent`: the text does not hold it at all (a theme the model named, a name no scene uses).
 *
 * Background tagging (F-4.13) creates a tag only for `name` and `term`; Organise (F-9.10) offers
 * to remove AI-made `ordinary` tags and leaves them out of its duplicate search.
 */
export type TermVerdict = 'name' | 'term' | 'unusual' | 'ordinary' | 'absent'

/** How often a phrase of ordinary words must recur before it reads as a coined term. */
export const TERM_PHRASE_MIN_REPEATS = 3

/** The small words a name may carry ("the Tide Reckoning", "Isle of Skye"), which say nothing either way. */
const LINK_WORDS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'the',
  'of',
  'and',
  'in',
  'on',
  'at',
  'to',
  'de',
  'del',
  'la',
  'le',
  'du',
  'des',
  'von',
  'van'
])

/** What may join the words of one name in prose: spaces, an apostrophe (O'Rourke), a hyphen. */
const JOIN = "[\\s'’\\-]+"

const escape = (word: string): string => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** How the text writes one term: capitalised mid-sentence, capitalised at a sentence start, in lower case. */
export interface TermUse {
  mid: number
  start: number
  lower: number
}

/**
 * Every use of a tag's name in the texts: its words in order on word boundaries, in any case.
 * A use is capitalised when every word of it that is not a small linking word opens with a
 * capital (a caseless script counts as capitalised, as in `isProperNoun`).
 */
export function termUses(tagName: string, texts: readonly string[]): TermUse {
  const words = nameWords(toTagName(tagName))
  const use: TermUse = { mid: 0, start: 0, lower: 0 }
  if (words.length === 0) return use
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{M}\\p{N}])${words.map(escape).join(JOIN)}(?![\\p{L}\\p{M}\\p{N}])`,
    'giu'
  )
  for (const text of texts) {
    for (const match of text.matchAll(pattern)) {
      const parts = match[0].split(/[\s'’-]+/u).filter((part) => part !== '')
      const capitalised = parts.every(
        (part) => LINK_WORDS.has(part.toLocaleLowerCase()) || opensCapitalised(part)
      )
      if (!capitalised) use.lower += 1
      else if (opensSentence(text, match.index)) use.start += 1
      else use.mid += 1
    }
  }
  return use
}

function opensCapitalised(word: string): boolean {
  const first = [...word][0] ?? ''
  if (first.toLocaleLowerCase() === first.toLocaleUpperCase()) return true
  return first === first.toLocaleUpperCase()
}

/** The verdict on one tag name against the manuscript's texts (see `TermVerdict`). */
export function classifyTagTerm(tagName: string, texts: readonly string[]): TermVerdict {
  const words = nameWords(toTagName(tagName))
  const significant = words.filter((word) => !LINK_WORDS.has(word))
  if (significant.length === 0) return 'ordinary'
  const use = termUses(tagName, texts)
  const total = use.mid + use.start + use.lower
  if (total === 0) return 'absent'
  const stopword = significant.length === 1 && STOPLIST.has(significant[0] ?? '')
  if (use.lower === 0 && !stopword) return 'name'
  if (significant.length >= 2 && total >= TERM_PHRASE_MIN_REPEATS) return 'term'
  if (use.mid >= PROPOSED_ORDINARY_MIN_MENTIONS) return 'unusual'
  return 'ordinary'
}

/** Whether background tagging (F-4.13) may create a tag of this name on its own. */
export function mayAutoCreateTag(verdict: TermVerdict): boolean {
  return verdict === 'name' || verdict === 'term'
}
