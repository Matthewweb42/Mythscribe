import { normalizeForMatch, straightenQuotes } from '../critique'
import { sentenceHash } from './anchor'
import { caseForm, normName } from './names'
import type { NameIndex } from './nameScan'
import { splitSentences } from './sentences'

/**
 * The reading gate (F-16.16; design §2.3 "When"): free, local code that decides whether a scene
 * needs reading at all, and how much. Nothing is sent while the author types; when she leaves a
 * scene or pauses, the gate compares the scene's finished sentences with what was read before
 * (`scene_read`) and answers nothing, a window, or a full read.
 *
 * - Paragraphs are numbered as `passageParagraphs` numbers them (the caller passes their texts),
 *   so the reader's ¶ numbers, the caret's paragraph and the name scan's `para` agree.
 * - A sentence is finished unless it is in the paragraph at the caret and that paragraph has no
 *   closing punctuation yet (then the whole paragraph waits).
 * - Names are kept out of the hash (`gateText`): every span that is a roster name becomes a token
 *   of its record ids, so a rename never triggers a read, while swapping one person for another
 *   still does. The lookup is context-free (one sentence at a time), so a stored sentence can be
 *   hashed again under today's roster: a record or nickname added later changes nothing.
 * - A cosmetic edit (whitespace or punctuation only, or one word changed by at most two letters
 *   where the old word is not a known word and neither word holds a digit: "1814" to "1815" is a
 *   real change) does not trigger a read and stays unread, so the next real read takes it in. A
 *   cosmetic edit to a sentence the card's quotes rest on still reads (`cardStale`).
 * - A scene is read whole on its first read, when more than half its finished sentences are
 *   unread, or after five window reads; otherwise the paragraphs with unread sentences, plus the
 *   paragraphs of claims gone stale (so "re-checking after you pause" is kept even when the only
 *   change was cosmetic or a name), make the window (`windows.ts` adds the context).
 */

/** Window reads before the next read is a full one. */
export const PARTIALS_BEFORE_FULL = 5
/** More than this share of finished sentences unread makes the read a full one. */
export const HALF_UNREAD = 0.5
/** Most letters a cosmetic one-word fix may change. */
export const COSMETIC_MAX_EDITS = 2

/** A paragraph's text ends a sentence: closing punctuation, then any closing quotes or brackets. */
const CLOSED = /(?:[.!?…]|[—–](?=["')\]]))["')\]]*$/u

/** Whether a paragraph's text has its closing punctuation. */
export function hasClosingPunctuation(text: string): boolean {
  return CLOSED.test(straightenQuotes(text).trimEnd())
}

/** One finished sentence, by paragraph and its index in `splitSentences(paragraph)`. */
export interface FinishedSentence {
  para: number
  index: number
  /** `normalizeForMatch` of the sentence (names kept). */
  text: string
}

/**
 * The finished sentences of a scene, in order. `caretPara` is the paragraph the caret is in
 * (the idle trigger only, P2a-D6); while it has no closing punctuation it is skipped whole.
 */
export function finishedSentences(
  paragraphs: readonly string[],
  options: { caretPara: number | null }
): FinishedSentence[] {
  const found: FinishedSentence[] = []
  paragraphs.forEach((paragraph, para) => {
    if (para === options.caretPara && !hasClosingPunctuation(paragraph)) return
    splitSentences(paragraph).forEach((span, index) => {
      const text = normalizeForMatch(span.text)
      if (text !== '') found.push({ para, index, text })
    })
  })
  return found
}

/** The longest name (in words) of a roster, cached per index. */
const MAX_WORDS = new WeakMap<NameIndex, number>()
function maxNameWords(index: NameIndex): number {
  const known = MAX_WORDS.get(index)
  if (known !== undefined) return known
  let most = 1
  for (const norm of index.byNorm.keys()) most = Math.max(most, norm.split(' ').length)
  MAX_WORDS.set(index, most)
  return most
}

const foldFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1)

interface Word {
  /** Where its letters start and end (outer punctuation and a possessive left out). */
  from: number
  to: number
}

function wordsOf(text: string): Word[] {
  return [...text.matchAll(/\S+/g)].flatMap((match) => {
    const raw = match[0]
    const lead = raw.length - raw.replace(/^[^\p{L}\p{N}]+/u, '').length
    let core = raw.slice(lead).replace(/[^\p{L}\p{N}]+$/u, '')
    if (/'s$/i.test(core)) core = core.slice(0, -2)
    else if (core.endsWith("'")) core = core.slice(0, -1)
    if (core === '') return []
    const from = match.index + lead
    return [{ from, to: from + core.length }]
  })
}

/**
 * A sentence as the gate hashes it: normalised, with every span that is a roster name (longest
 * first, on word boundaries, in its case unless the name matches in any case; a sentence's first
 * word in either case) replaced by `⟨record ids⟩`. A possessive stays outside the token.
 */
export function gateText(sentence: string, names: NameIndex | null): string {
  const text = normalizeForMatch(sentence)
  if (names === null || names.byNorm.size === 0) return text
  const words = wordsOf(text)
  const most = maxNameWords(names)
  let out = ''
  let copied = 0
  let i = 0
  while (i < words.length) {
    let matched = 0
    for (let n = Math.min(most, words.length - i); n >= 1 && matched === 0; n -= 1) {
      const first = words[i]
      const last = words[i + n - 1]
      if (first === undefined || last === undefined) continue
      const span = text.slice(first.from, last.to)
      const entries = names.byNorm.get(normName(span))
      if (entries === undefined) continue
      const form = caseForm(span)
      const ids = entries
        .filter(
          (alias) =>
            alias.rule === 'any' ||
            form === alias.form ||
            (i === 0 && foldFirst(form) === foldFirst(alias.form))
        )
        .map((alias) => alias.recordId)
      if (ids.length === 0) continue
      out += `${text.slice(copied, first.from)}⟨${[...new Set(ids)].sort().join('|')}⟩`
      copied = last.to
      matched = n
    }
    i += matched === 0 ? 1 : matched
  }
  return out + text.slice(copied)
}

/** The gate's hash of a gate text. */
export function gateHash(gate: string): string {
  return sentenceHash(gate)
}

/** A finished sentence with its gate text and hash. */
export interface GateSentence extends FinishedSentence {
  gate: string
  hash: string
}

/** The scene's finished sentences, each with its gate text and hash under `names`. */
export function gateSentences(
  paragraphs: readonly string[],
  options: { caretPara: number | null; names: NameIndex | null }
): GateSentence[] {
  return finishedSentences(paragraphs, options).map((sentence) => {
    const gate = gateText(sentence.text, options.names)
    return { ...sentence, gate, hash: gateHash(gate) }
  })
}

/**
 * One stored read sentence (`scene_read.sentences`): its gate hash when it was read, and its
 * normalised text with the names in, so it can be hashed again under a later roster.
 */
export type ReadEntry = readonly [hash: string, text: string]

/** A read sentence as the gate compares it: its text and its gate text under today's roster. */
export interface ReadSentence {
  text: string
  gate: string
}

/** The read set under `names`, by gate hash: stored texts hashed again, so names never count. */
export function readSetOf(
  entries: readonly ReadEntry[],
  names: NameIndex | null
): Map<string, ReadSentence> {
  const set = new Map<string, ReadSentence>()
  for (const [, text] of entries) {
    const gate = gateText(text, names)
    set.set(gateHash(gate), { text, gate })
  }
  return set
}

/** The sentences not read yet. */
export function unreadSentences(
  current: readonly GateSentence[],
  read: ReadonlyMap<string, ReadSentence>
): GateSentence[] {
  return current.filter((sentence) => !read.has(sentence.hash))
}

/** Edit distance with transpositions (optimal string alignment), stopping past `limit`. */
export function editDistance(a: string, b: string, limit = COSMETIC_MAX_EDITS): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1
  const rows: number[][] = []
  for (let i = 0; i <= a.length; i += 1) {
    const row: number[] = [i]
    for (let j = 1; j <= b.length; j += 1) {
      if (i === 0) {
        row.push(j)
        continue
      }
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const above = rows[i - 1] ?? []
      let best = Math.min((above[j] ?? 0) + 1, (row[j - 1] ?? 0) + 1, (above[j - 1] ?? 0) + cost)
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        best = Math.min(best, (rows[i - 2]?.[j - 2] ?? 0) + 1)
      }
      row.push(best)
    }
    rows.push(row)
  }
  return rows[a.length]?.[b.length] ?? limit + 1
}

const bare = (gate: string): string =>
  gate
    .replace(/[^\p{L}\p{N}\s⟨⟩|]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()

/** The words the cosmetic skip treats as known, lower case (a `Set`, or a lookup over the book). */
export interface KnownWords {
  has(word: string): boolean
}

/**
 * Whether `after` is a cosmetic edit of `before` (both gate texts): the same words with only
 * whitespace or punctuation changed, or one word changed by at most two letters where the old
 * word is not a known word (`knownWords`, lower case: the active manuscript's other words, the
 * roster's names and the project dictionary; P2a-D3). A name is never the changed word.
 */
export function isCosmetic(
  before: string,
  after: string,
  options: { knownWords: KnownWords }
): boolean {
  const a = bare(before)
  const b = bare(after)
  if (a === b) return true
  const wordsA = a.split(' ')
  const wordsB = b.split(' ')
  if (wordsA.length !== wordsB.length) return false
  const changed = wordsA.flatMap((word, i) => (word === wordsB[i] ? [] : [i]))
  if (changed.length !== 1) return false
  const old = wordsA[changed[0] ?? 0] ?? ''
  const fresh = wordsB[changed[0] ?? 0] ?? ''
  if (old.includes('⟨') || fresh.includes('⟨')) return false
  if (/\p{N}/u.test(old) || /\p{N}/u.test(fresh)) return false
  if (options.knownWords.has(old.toLowerCase())) return false
  return editDistance(old.toLowerCase(), fresh.toLowerCase()) <= COSMETIC_MAX_EDITS
}

export interface ReadDecisionInput {
  /** The scene's finished sentences now (`gateSentences`). */
  sentences: readonly GateSentence[]
  /** What was read (`readSetOf`), or null when the scene was never read in this draft. */
  read: ReadonlyMap<string, ReadSentence> | null
  /** Window reads since the last full one (`scene_read.partials`). */
  partials: number
  /** Paragraphs holding a stale claim (its anchor changed and no free re-proof held it). */
  staleParas: ReadonlySet<number>
  /** A sentence the card's quotes rest on changed (`cardStale`): no edit there is cosmetic. */
  cardStale: boolean
  knownWords: KnownWords
}

export type ReadDecision =
  | { read: 'nothing'; reason: 'empty' | 'upToDate' | 'cosmetic'; unread: number }
  | { read: 'window'; reason: 'changed' | 'stale'; paras: number[]; unread: number }
  | { read: 'full'; reason: 'first' | 'half' | 'partials'; unread: number }

/** Whether the scene needs reading, and how much (see the module comment). */
export function readDecision(input: ReadDecisionInput): ReadDecision {
  const { sentences, read } = input
  if (read === null) {
    return sentences.length === 0
      ? { read: 'nothing', reason: 'empty', unread: 0 }
      : { read: 'full', reason: 'first', unread: sentences.length }
  }
  const unread = unreadSentences(sentences, read)
  const present = new Set(sentences.map((sentence) => sentence.hash))
  const removed = [...read].filter(([hash]) => !present.has(hash)).map(([, entry]) => entry.gate)
  const real = input.cardStale
    ? unread
    : unread.filter(
        (sentence) =>
          !removed.some((gate) => isCosmetic(gate, sentence.gate, { knownWords: input.knownWords }))
      )
  if (real.length === 0 && input.staleParas.size === 0) {
    return {
      read: 'nothing',
      reason: unread.length === 0 ? 'upToDate' : 'cosmetic',
      unread: unread.length
    }
  }
  if (real.length > 0 && real.length > sentences.length * HALF_UNREAD) {
    return { read: 'full', reason: 'half', unread: unread.length }
  }
  if (input.partials >= PARTIALS_BEFORE_FULL) {
    return { read: 'full', reason: 'partials', unread: unread.length }
  }
  const paras = [...new Set([...unread.map((sentence) => sentence.para), ...input.staleParas])]
  return {
    read: 'window',
    reason: real.length > 0 ? 'changed' : 'stale',
    paras: paras.sort((a, b) => a - b),
    unread: unread.length
  }
}

/**
 * The read set after a reading: every current sentence in a paragraph that was sent (`'all'` for
 * a full read), and every one already read; sentences no longer in the scene are dropped. A read
 * always covers every unread paragraph, so nothing cosmetic is left to compare against.
 */
export function nextReadSet(
  previous: ReadonlyMap<string, ReadSentence> | null,
  current: readonly GateSentence[],
  readParas: ReadonlySet<number> | 'all'
): ReadEntry[] {
  const entries = new Map<string, string>()
  for (const sentence of current) {
    const sent = readParas === 'all' || readParas.has(sentence.para)
    if (sent || previous?.has(sentence.hash) === true) entries.set(sentence.hash, sentence.text)
  }
  return [...entries]
}
