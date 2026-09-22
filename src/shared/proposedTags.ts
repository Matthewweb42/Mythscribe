import { z } from 'zod'
import { nameWords } from './mentions'
import { toTagName } from './tags'

/**
 * Proposed tags (F-4.12b): a name the author keeps using that no tag stands for yet. The scan of
 * F-4.12 answers where the tags of the bank occur; this one reads the other side of the same
 * text — the capitalised words that match no tag — and proposes the recurring ones as character
 * tags in the tag bar. It is a local heuristic, no AI and nothing sent anywhere, and it proposes
 * only: nothing is created until the author clicks Create tag (author-control rule 1), and one
 * click dismisses a name for the project.
 */

/** Settings-table key under which the dismissed proposals (F-4.12b) are stored as JSON. */
export const DISMISSED_NAMES_KEY = 'proposedTags'

/** How often a name must stand mid-sentence in the manuscript before it is proposed. */
export const PROPOSED_TAG_MIN_MENTIONS = 3

/** Most proposals shown at once: the tag bar is a bar, and a long list is noise, not help. */
export const PROPOSED_TAG_MAX = 10

/** The names the author dismissed, kebab-cased like a tag name so the two can be compared. */
export const DismissedNames = z.object({
  names: z.array(z.string()).default([])
})
export type DismissedNames = z.infer<typeof DismissedNames>

/** The empty list a project without a stored row (or with an unreadable one) starts from. */
export function defaultDismissedNames(): DismissedNames {
  return { names: [] }
}

/**
 * One proposal: the tag name it would be created under, the spelling the manuscript uses, how
 * often the word occurs, and the documents that hold it (the tag bar shows a document only the
 * proposals its own text carries).
 */
export const ProposedTag = z.object({
  /** The kebab-cased name `tag:create` would store, and the key a dismissal is remembered by. */
  name: z.string(),
  /** The first spelling seen in reading order — what the author typed, shown in the bar. */
  display: z.string(),
  /** Every occurrence of the word in the manuscript, mid-sentence ones and sentence openings alike. */
  count: z.number().int().positive(),
  /** The manuscript documents the word occurs in, in reading order. */
  nodeIds: z.array(z.string())
})
export type ProposedTag = z.infer<typeof ProposedTag>

/** How one word is used in one document: the spelling first seen and the three counts that decide. */
export interface WordCount {
  /** The first capitalised spelling of the word in this document ("Tash"). */
  display: string
  /** Occurrences that stand mid-sentence, which is what makes a word look like a name. */
  mid: number
  /** Occurrences that open a sentence, where any word is capitalised and so says nothing. */
  start: number
  /** Occurrences of the same word in lower case ("the rose"), which say it is not a name at all. */
  lower: number
}

/** One document's counts, as `proposeTags` takes them: the node the text came from and its words. */
export interface DocumentWordCounts {
  nodeId: string
  counts: Map<string, WordCount>
}

/**
 * Words that are capitalised in prose without being anybody's name: honorifics, the days and
 * months, and the one deity the heuristic meets in nearly every manuscript. They are excluded
 * rather than left to be dismissed, since every project would dismiss them.
 */
const STOPLIST: ReadonlySet<string> = new Set([
  'mr',
  'mrs',
  'ms',
  'miss',
  'sir',
  'madam',
  'madame',
  'dr',
  'doctor',
  'professor',
  'captain',
  'lord',
  'lady',
  'god',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december'
])

/**
 * One word of prose: letters with their combining marks, and the apostrophes inside a name
 * ("O'Rourke", "Sidi'ath") held together. The trailing contraction or possessive is stripped
 * afterwards, so "Tash's" counts as "Tash".
 */
const WORD = /\p{L}[\p{L}\p{M}]*(?:['’]\p{L}+)*/gu

/** The English endings an apostrophe glues to a name; "Tash's" is a mention of Tash, not of Tash's. */
const SUFFIX = /['’](s|d|ll|ve|re|m|t)$/iu

/** What may stand between a sentence's end and its first word: quotes, brackets, dashes, spaces. */
const OPENERS = /[\s"'“”‘’«»()[\]{}—–-]/u

/** The characters a sentence ends on, so the word after one is capitalised by grammar, not by name. */
const SENTENCE_END = /[.!?…]/u

/**
 * Counts the capitalised words of one document's text (F-4.12b), keyed by the lower-cased word,
 * so "Tash" and "TASH's" are one entry. Per word it answers how often it stands mid-sentence,
 * how often it opens one, and how often the same word occurs in lower case; a name earns its
 * proposal on the first count, and the third is what tells "Rose" the person from "the rose".
 * Words of one letter and words in full capitals (an acronym, a shout) are counted as neither.
 */
export function countCapitalisedWords(text: string): Map<string, WordCount> {
  const counts = new Map<string, WordCount>()
  WORD.lastIndex = 0
  for (let match = WORD.exec(text); match !== null; match = WORD.exec(text)) {
    const word = match[0].replace(SUFFIX, '')
    if ([...word].length < 2) continue
    const key = word.toLocaleLowerCase()
    const capitalised = isCapitalised(word)
    // A word in full capitals cannot say whether it is a name, so it neither proposes nor vetoes.
    if (capitalised && word === word.toLocaleUpperCase()) continue
    const entry = counts.get(key) ?? { display: word, mid: 0, start: 0, lower: 0 }
    if (!capitalised) entry.lower += 1
    else if (opensSentence(text, match.index)) entry.start += 1
    else entry.mid += 1
    // The shown spelling is the first capitalised one; a lower-case first sight is only a placeholder.
    if (capitalised && !isCapitalised(entry.display)) entry.display = word
    counts.set(key, entry)
  }
  return counts
}

/** Whether a word opens with an upper-case letter, which is all "capitalised" means here. */
function isCapitalised(word: string): boolean {
  return /\p{Lu}/u.test([...word][0] ?? '')
}

/**
 * Whether the word at `at` is the first of a sentence: walking back over spaces and the
 * punctuation a sentence may open with, the text either runs out, breaks a line, or ends a
 * sentence. Dialogue counts as its own sentence ("said Tash" keeps `Tash` mid-sentence, while
 * `"Tash," she said` does not), which is the conservative way round: a name that only ever
 * opens sentences is not proposed, and one used in the middle of a line is.
 */
function opensSentence(text: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i--) {
    const char = text[i] ?? ''
    if (char === '\n' || char === '\r') return true
    if (SENTENCE_END.test(char)) return true
    if (!OPENERS.test(char)) return false
  }
  return true
}

/**
 * The names to propose (F-4.12b), most used first, at most `PROPOSED_TAG_MAX` of them. A word
 * is proposed when, across the whole manuscript, it stands mid-sentence at least
 * `PROPOSED_TAG_MIN_MENTIONS` times, never occurs in lower case (so it is a name and not a
 * noun the author also capitalises after a full stop), is not one of the words an existing tag
 * is already named by, is not on the stoplist, and was not dismissed. The count shown is every
 * occurrence, sentence openings included: the author counts words, not grammar.
 */
export function proposeTags(
  perDocument: DocumentWordCounts[],
  tagNames: string[],
  dismissed: string[]
): ProposedTag[] {
  const taken = new Set<string>()
  // A tag's whole name and each of its words: `rose-marsh` spares both "Rose" and "Marsh", and
  // `o-rourke` spares "O'Rourke", whose kebab form is not one of its words.
  for (const name of tagNames) {
    taken.add(name)
    for (const word of nameWords(name)) taken.add(word)
  }
  const skip = new Set(dismissed.map((name) => toTagName(name)))
  /** Every document's counts folded into one entry per word; the documents stay in reading order. */
  const totals = new Map<string, WordCount & { nodeIds: string[] }>()
  for (const { nodeId, counts } of perDocument) {
    for (const [key, count] of counts) {
      const entry = totals.get(key) ?? {
        display: count.display,
        mid: 0,
        start: 0,
        lower: 0,
        nodeIds: []
      }
      entry.mid += count.mid
      entry.start += count.start
      entry.lower += count.lower
      if (!isCapitalised(entry.display) && isCapitalised(count.display))
        entry.display = count.display
      if (count.mid + count.start > 0 && !entry.nodeIds.includes(nodeId)) entry.nodeIds.push(nodeId)
      totals.set(key, entry)
    }
  }
  const proposals: ProposedTag[] = []
  for (const [key, entry] of totals) {
    if (entry.mid < PROPOSED_TAG_MIN_MENTIONS || entry.lower > 0 || STOPLIST.has(key)) continue
    const name = toTagName(key)
    if (name.length === 0 || taken.has(name) || skip.has(name)) continue
    proposals.push({
      name,
      display: entry.display,
      count: entry.mid + entry.start,
      nodeIds: entry.nodeIds
    })
  }
  return proposals
    .sort((a, b) => (b.count !== a.count ? b.count - a.count : a.name.localeCompare(b.name)))
    .slice(0, PROPOSED_TAG_MAX)
}
