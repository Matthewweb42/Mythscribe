import { z } from 'zod'
import {
  PROPOSED_ORDINARY_MIN_MENTIONS,
  STOPLIST,
  type DocumentWordCounts,
  type WordCount
} from '../proposedTags'
import { Dismissed, dismissedKey } from './dismissed'
import { RECORD_ALIAS_MAX, RecordName, StoryRecord } from './records'
import { capitalisedSpans, gateWords, isTitle, normName, SENTENCE_OPENERS } from './names'
import { twinGate, TwinGateBlocked, type TwinRosterRecord } from './twinGate'

/**
 * Name questions (F-16.4, design §2.2 rule 6, answer 9): new names and nicknames are asked about
 * once, quietly, in Needs a look. Local: a recurring capitalised span of the manuscript (the same
 * whole spans the name scan matches, `capitalisedSpans`) that no record answers to becomes a
 * question, so the name it offers is one the scan will find once it is added ("Hesk Varn", not
 * "Hesk" and "Varn"). If the twin gate clears it, it is a **new name** ("Hesk: named in 5
 * scenes"; *Add as* a category · *Not a name*); if the gate ties it to a record, it is a
 * **nickname** ("Is 'Rynna' Rynna Falsire?"; *Yes* · *No*). A dismissed one never appears again,
 * whatever the gate says, and a title with a name is never offered as a nickname (identity
 * rule 2: the author adds those herself).
 */

export const NAME_QUESTION_KINDS = ['newName', 'nickname'] as const
export const NameQuestionKind = z.enum(NAME_QUESTION_KINDS)
export type NameQuestionKind = z.infer<typeof NameQuestionKind>

/** Most questions shown at once: the most-named first. */
export const NAME_QUESTIONS_MAX = 10
/** How often a name must stand mid-sentence before it is asked about. */
export const NAME_QUESTION_MIN_MID = 2

export const NameQuestion = z.object({
  kind: NameQuestionKind,
  /** The spelling the manuscript uses first. */
  name: z.string(),
  /** `normName(name)`: what an answer is keyed by. */
  norm: z.string(),
  /** Every occurrence, sentence openings included. */
  count: z.number().int().positive(),
  /** The scenes that name it, in reading order. */
  nodeIds: z.array(z.string()),
  /** For a nickname: the record it may be, and that record's name. */
  recordId: z.string().nullable(),
  recordName: z.string().nullable()
})
export type NameQuestion = z.infer<typeof NameQuestion>

/** What has been answered No to before: dismissed names, and `alias` keys (`recordId|norm`). */
export interface NameQuestionDismissals {
  names: readonly string[]
  aliasKeys: ReadonlySet<string>
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** How often `words` stand in `text` written all in lower case, on word boundaries. */
function lowerUses(text: string, words: readonly string[]): number {
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}])${words.map((word) => escapeRegExp(word.toLowerCase())).join('\\s+')}(?![\\p{L}\\p{N}])`,
    'gu'
  )
  return [...text.matchAll(pattern)].length
}

/** A word in full capitals (an acronym, a shout), which cannot say whether it is a name. */
const isShout = (word: string): boolean => word.length >= 2 && word === word.toUpperCase()

/**
 * Counts the names of one document's text as the name scan reads them: every capitalised span
 * (`capitalisedSpans`; possessive stripped, link words inside), keyed by its `normName`, with a
 * common sentence opener taken off its front ("Then Hesk Varn" counts as "Hesk Varn"). Per span:
 * how often it stands mid-sentence, how often it opens one, and how often the same words occur in
 * lower case ("the Trial" beside "a fair trial"). A span of one letter, in full capitals, or made
 * only of titles, days, months and the like is not counted.
 */
export function countNameSpans(text: string): Map<string, WordCount> {
  const counts = new Map<string, WordCount>()
  const spoken = new Map<string, string[]>()
  for (const span of capitalisedSpans(text)) {
    const [first, ...rest] = span.words
    if (first === undefined) continue
    const words =
      span.sentenceStart && rest.length > 0 && SENTENCE_OPENERS.has(first.text.toLowerCase())
        ? rest
        : span.words
    const head = words[0]
    const tail = words[words.length - 1]
    if (head === undefined || tail === undefined) continue
    const named = words.filter((word) => !word.link)
    if (named.map((word) => word.text).join('').length < 2) continue
    if (named.every((word) => isShout(word.text))) continue
    if (
      named.every(
        (word) => STOPLIST.has(word.text.toLowerCase()) || isTitle(word.text.toLowerCase())
      )
    ) {
      continue
    }
    const display = text.slice(head.start, tail.end)
    const key = normName(display)
    if (key.length === 0) continue
    const entry = counts.get(key) ?? { display, mid: 0, start: 0, lower: 0 }
    if (span.sentenceStart) entry.start += 1
    else entry.mid += 1
    counts.set(key, entry)
    if (!spoken.has(key))
      spoken.set(
        key,
        words.map((word) => word.text)
      )
  }
  for (const [key, words] of spoken) {
    const entry = counts.get(key)
    if (entry !== undefined) entry.lower = lowerUses(text, words)
  }
  return counts
}

/**
 * The questions to ask, most named first, at most `NAME_QUESTIONS_MAX`. A name qualifies when it
 * stands capitalised mid-sentence at least `NAME_QUESTION_MIN_MID` times (words the manuscript
 * also writes in lower case, `PROPOSED_ORDINARY_MIN_MENTIONS` times, as F-4.12b counts them), or
 * once anywhere when the reader proposed it with a proved fact (`proved`, F-16.17), and
 * the scan would not already find it: it is no record's name, nor one with its "the" ("the
 * Wanderer"), nor its plural ("the Harrows"). A name of a record used alone ("Rynna" for Rynna
 * Falsire) is asked about as a nickname, since the scan matches whole names only.
 */
export function nameQuestions(
  perDocument: readonly DocumentWordCounts[],
  roster: readonly TwinRosterRecord[],
  dismissed: NameQuestionDismissals,
  options: {
    /**
     * F-16.17 (P2a-D7): norms of names the reader proposed with a proved fact (facts waiting on
     * the name): such a name is asked about once it is seen once, anywhere in a sentence.
     */
    proved?: ReadonlySet<string>
  } = {}
): NameQuestion[] {
  const known = new Set(roster.flatMap((record) => record.names.map(normName)))
  const scanned = (key: string): boolean =>
    known.has(key) ||
    known.has(`the ${key}`) ||
    (key.endsWith('s') && known.has(key.slice(0, -1))) ||
    (key.endsWith('es') && known.has(key.slice(0, -2)))
  const notNames = new Set(dismissed.names.map((name) => gateWords(name).join(' ')))
  const totals = new Map<
    string,
    { display: string; mid: number; start: number; lower: number; nodeIds: string[] }
  >()
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
      if (count.mid + count.start > 0 && !entry.nodeIds.includes(nodeId)) entry.nodeIds.push(nodeId)
      totals.set(key, entry)
    }
  }
  const nameOf = new Map(roster.map((record) => [record.id, record.names[0] ?? '']))
  const questions: NameQuestion[] = []
  for (const [key, entry] of totals) {
    const needed = entry.lower > 0 ? PROPOSED_ORDINARY_MIN_MENTIONS : NAME_QUESTION_MIN_MID
    const seen = options.proved?.has(key) === true ? entry.mid + entry.start >= 1 : entry.mid >= needed
    if (!seen || scanned(key)) continue
    const words = gateWords(entry.display)
    // Dismissed first: a Not a name stays silent even once a record near it exists.
    if (notNames.has(words.join(' '))) continue
    const gate = twinGate(entry.display, roster, dismissed.names)
    const base = {
      name: entry.display,
      norm: key,
      count: entry.mid + entry.start,
      nodeIds: entry.nodeIds
    }
    if (gate.outcome === 'clear') {
      questions.push({ ...base, kind: 'newName', recordId: null, recordName: null })
      continue
    }
    if (gate.recordId === null || words.some(isTitle)) continue
    if (
      dismissed.aliasKeys.has(dismissedKey({ kind: 'alias', recordId: gate.recordId, alias: key }))
    ) {
      continue
    }
    questions.push({
      ...base,
      kind: 'nickname',
      recordId: gate.recordId,
      recordName: nameOf.get(gate.recordId) ?? null
    })
  }
  return questions
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, NAME_QUESTIONS_MAX)
}

/** A nickname as an answer carries it: as long as any other name (`record:setAliases`). */
const NicknameAnswer = z.string().trim().min(1).max(RECORD_ALIAS_MAX)

/** An answer to a question, as `names:answer` takes it. */
export const NameAnswer = z.discriminatedUnion('kind', [
  /** A new name: make a record of it in this category. */
  z.object({ kind: z.literal('addAs'), name: RecordName, categoryId: z.string() }),
  /** A new name: it is not a name (a `name` dismissal). */
  z.object({ kind: z.literal('notAName'), name: RecordName }),
  /** A nickname: Yes, add it to the record (origin `confirmed`). */
  z.object({ kind: z.literal('yes'), name: NicknameAnswer, recordId: z.string() }),
  /** A nickname: No (an `alias` dismissal). */
  z.object({ kind: z.literal('no'), name: NicknameAnswer, recordId: z.string() })
])
export type NameAnswer = z.infer<typeof NameAnswer>

/** What an answer did (`names:answer`): a record made or given a nickname, a tombstone, or the gate's warning. */
export const NameAnswerResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), record: StoryRecord }),
  z.object({ kind: z.literal('dismissed'), dismissed: Dismissed }),
  z.object({ kind: z.literal('gate'), gate: TwinGateBlocked })
])
export type NameAnswerResult = z.infer<typeof NameAnswerResult>
