import { z } from 'zod'
import { aliasKey, cleanAlias } from './aliases'
import {
  findMentions,
  isProperNoun,
  nameWords,
  textRuns,
  type MentionCandidate,
  type MentionRange
} from './mentions'
import type { TiptapNodeT } from './tiptap'

/**
 * Likely misspellings of story names (F-4.14): "Rynna Falseer" in a book whose tag is
 * `rynna-falsire`. Found locally (no AI, no key, nothing leaves the machine) by comparing the
 * capitalised words of a document with every tag's name and aliases, word by word, under a
 * small edit distance. They are only ever offered: the author approves each fix, which is the
 * one path of the alias work that changes scene text. A misspelling is never added as an alias
 * on its own.
 */

/** Settings-table key of the spellings the author said to keep ("Not a typo"), by `aliasKey`. */
export const KEPT_SPELLINGS_KEY = 'keptSpellings'

export const KeptSpellings = z.object({ keys: z.array(z.string()).default([]) })
export type KeptSpellings = z.infer<typeof KeptSpellings>

/** Most kept spellings stored; the oldest go first past it. */
export const KEPT_SPELLINGS_MAX = 500

/** A name the check compares the prose with: a tag, how its name is spelled, and its aliases. */
export interface SpellingCandidate extends MentionCandidate {
  /** How the main name is spelled in prose ("Rynna Falsire"); the tag name title-cased when unknown. */
  display?: string
}

/** One likely misspelling in a document: where, what it says, and what it should say. */
export interface Misspelling {
  tagId: string
  /** ProseMirror range of the misspelled words, what `setTextSelection` and `insertText` take. */
  range: MentionRange
  /** The text as written: "Falseer". */
  text: string
  /** The proposed spelling: "Falsire". */
  suggestion: string
}

/** Every occurrence of one misspelling in a document, for one row with one fix. */
export interface MisspellingGroup {
  tagId: string
  text: string
  suggestion: string
  ranges: MentionRange[]
}

/** The shortest word compared at all: short words are too often a different, real name. */
const MIN_WORD_LENGTH = 4

/** How many edits a word of this length may be away from a name and still be its misspelling. */
export function allowedEdits(length: number): number {
  if (length < MIN_WORD_LENGTH) return 0
  return length < 6 ? 1 : 2
}

/**
 * The optimal string alignment distance (Levenshtein plus adjacent transpositions, so "Rynan"
 * is one edit from "Rynna"), stopping early once it exceeds `limit`.
 */
export function editDistance(a: string, b: string, limit = Infinity): number {
  const x = [...a]
  const y = [...b]
  if (Math.abs(x.length - y.length) > limit) return limit + 1
  let prev2: number[] = []
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j)
  for (let i = 1; i <= x.length; i++) {
    const row = [i]
    let best = i
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1
      let value = Math.min((prev[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        value = Math.min(value, (prev2[j - 2] ?? 0) + 1)
      }
      row.push(value)
      best = Math.min(best, value)
    }
    if (best > limit) return limit + 1
    prev2 = prev
    prev = row
  }
  return prev[y.length] ?? 0
}

/**
 * Whether `typed` reads as a misspelling of `known` (both one lower-case word): different, the
 * same first letter (a typo rarely changes it, and "Kael" against "Rael" are two people), and
 * within `allowedEdits` of the known word's length.
 */
export function isCloseSpelling(typed: string, known: string): boolean {
  if (typed === known || [...known].length < MIN_WORD_LENGTH) return false
  if ([...typed][0] !== [...known][0]) return false
  const allowed = allowedEdits([...known].length)
  return editDistance(typed, known, allowed) <= allowed
}

/** One spelling a tag answers to: its words (lower case) and how they are written in prose. */
interface Form {
  tagId: string
  words: string[]
  display: string[]
}

/** A word of the prose: its text and its `[start, end)` in the run. */
interface Token {
  text: string
  start: number
  end: number
}

const WORD = /[\p{L}\p{M}\p{N}]+/gu

/** A kebab-case name as display words when nothing spells it better: `rynna-falsire` → Rynna Falsire. */
function titleWords(name: string): string[] {
  return nameWords(name).map((word) => word.charAt(0).toLocaleUpperCase() + word.slice(1))
}

/**
 * The spellings every candidate answers to: its name (as `display` spells it), each alias, and,
 * for a name of several words, each long word on its own ("Falsire" of "Rynna Falsire"), so a
 * misspelt surname is found when it stands alone.
 */
function formsOf(candidates: readonly SpellingCandidate[]): Form[] {
  const forms: Form[] = []
  for (const candidate of candidates) {
    const display = candidate.display ? cleanAlias(candidate.display).split(' ') : []
    const main = nameWords(candidate.name)
    const spelled =
      display.length === main.length && aliasKey(display.join(' ')) === candidate.name
        ? display
        : titleWords(candidate.name)
    const full: Form[] = [
      { tagId: candidate.id, words: main, display: spelled },
      ...(candidate.aliases ?? []).flatMap((alias): Form[] => {
        const words = nameWords(aliasKey(alias))
        const shown = cleanAlias(alias).split(' ')
        if (words.length === 0) return []
        return [
          {
            tagId: candidate.id,
            words,
            display: shown.length === words.length ? shown : titleWords(aliasKey(alias))
          }
        ]
      })
    ]
    forms.push(...full)
    for (const form of full) {
      if (form.words.length < 2) continue
      form.words.forEach((word, i) => {
        if ([...word].length < 5) return
        forms.push({ tagId: candidate.id, words: [word], display: [form.display[i] ?? word] })
      })
    }
  }
  // Longest first, as the mention scan does, so a two-word misspelling is one finding.
  return forms.sort((a, b) => b.words.length - a.words.length)
}

/**
 * The likely misspellings of the candidates' names and aliases in a document (F-4.14), in
 * document order. A run of capitalised words is one when every word is a close spelling of the
 * same word of one name form (`isCloseSpelling`) or exactly it, at least one is not exact, the
 * words are separated by whitespace only, and the run is neither a mention already (an exact
 * name or alias of any tag, F-4.12) nor a spelling the author said to keep (`ignored`, keys by
 * `aliasKey`). The suggestion keeps the name's spelling ("Falsire"); a name only known in kebab
 * case is title-cased.
 */
export function findMisspellings(
  doc: TiptapNodeT,
  candidates: readonly SpellingCandidate[],
  ignored: ReadonlySet<string> = new Set()
): Misspelling[] {
  const runs = textRuns(doc)
  if (runs.length === 0 || candidates.length === 0) return []
  const forms = formsOf(candidates)
  /** Every key some tag answers to exactly: such words are a name, never a misspelling. */
  const known = new Set(forms.map((form) => form.words.join('-')))
  const taken = runs.map((): [number, number][] => [])
  for (const ranges of findMentions(doc, [...candidates]).values()) {
    for (const [from, to] of ranges) {
      const index = runs.findIndex((run) => from >= run.from && to <= run.from + run.text.length)
      const run = runs[index]
      if (run !== undefined) taken[index]?.push([from - run.from, to - run.from])
    }
  }
  const found: Misspelling[] = []
  runs.forEach((run, index) => {
    const spans = taken[index] ?? []
    const tokens: Token[] = [...run.text.matchAll(WORD)].map((match) => ({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length
    }))
    for (const form of forms) {
      const n = form.words.length
      for (let i = 0; i + n <= tokens.length; i++) {
        const window = tokens.slice(i, i + n)
        const first = window[0]
        const last = window[n - 1]
        if (first === undefined || last === undefined) continue
        if (spans.some(([start, end]) => first.start < end && start < last.end)) continue
        if (
          !window.every(
            (token, k) => k === 0 || /^\s+$/u.test(run.text.slice(window[k - 1]?.end, token.start))
          )
        ) {
          continue
        }
        const text = run.text.slice(first.start, last.end)
        if (!isProperNoun(text)) continue
        const lower = window.map((token) => token.text.toLocaleLowerCase())
        const key = lower.join('-')
        if (known.has(key) || ignored.has(aliasKey(text))) continue
        const close = lower.every(
          (word, k) => word === form.words[k] || isCloseSpelling(word, form.words[k] ?? '')
        )
        if (!close) continue
        spans.push([first.start, last.end])
        found.push({
          tagId: form.tagId,
          range: [run.from + first.start, run.from + last.end],
          text,
          suggestion: form.display.join(' ')
        })
      }
    }
  })
  return found.sort((a, b) => a.range[0] - b.range[0])
}

/** The misspellings grouped by what is written and what it should be, in order of first use. */
export function groupMisspellings(found: readonly Misspelling[]): MisspellingGroup[] {
  const groups = new Map<string, MisspellingGroup>()
  for (const item of found) {
    const key = `${item.tagId}\u0000${item.text}\u0000${item.suggestion}`
    const group = groups.get(key)
    if (group) group.ranges.push(item.range)
    else
      groups.set(key, {
        tagId: item.tagId,
        text: item.text,
        suggestion: item.suggestion,
        ranges: [item.range]
      })
  }
  return [...groups.values()]
}

/** Whether a proposed tag name (F-4.12b, one kebab word) is a close spelling of a word the bank knows. */
export function isMisspeltName(name: string, knownNames: readonly string[]): boolean {
  const words = knownNames.flatMap((known) => nameWords(known))
  return words.some((word) => isCloseSpelling(name, word))
}
