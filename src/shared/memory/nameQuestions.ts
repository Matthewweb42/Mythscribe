import { z } from 'zod'
import { PROPOSED_ORDINARY_MIN_MENTIONS, STOPLIST, type DocumentWordCounts } from '../proposedTags'
import { Dismissed, dismissedKey } from './dismissed'
import { StoryRecord } from './records'
import { isTitle, normName } from './names'
import { twinGate, TwinGateBlocked, type TwinRosterRecord } from './twinGate'

/**
 * Name questions (F-16.4, design §2.2 rule 6, answer 9): new names and nicknames are asked about
 * once, quietly, in Needs a look. Local: a recurring capitalised word of the manuscript that no
 * record answers to becomes a question. If the twin gate clears it, it is a **new name** ("Hesk:
 * named in 5 scenes"; *Add as* a category · *Not a name*); if the gate ties it to a record, it is
 * a **nickname** ("Is 'Ry' Rynna Falsire?"; *Yes* · *No*). A dismissed one never appears again.
 */

export const NAME_QUESTION_KINDS = ['newName', 'nickname'] as const
export const NameQuestionKind = z.enum(NAME_QUESTION_KINDS)
export type NameQuestionKind = z.infer<typeof NameQuestionKind>

/** Most questions shown at once: the most-named first. */
export const NAME_QUESTIONS_MAX = 10
/** How often a word must stand mid-sentence before it is asked about. */
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

/**
 * The questions to ask, most named first, at most `NAME_QUESTIONS_MAX`. A word qualifies when it
 * stands capitalised mid-sentence at least `NAME_QUESTION_MIN_MID` times (an ordinary word the
 * manuscript also writes in lower case, `PROPOSED_ORDINARY_MIN_MENTIONS` times, as F-4.12b counts
 * it), is not on the stoplist or a title, and is not a word of any record's names.
 */
export function nameQuestions(
  perDocument: readonly DocumentWordCounts[],
  roster: readonly TwinRosterRecord[],
  dismissed: NameQuestionDismissals
): NameQuestion[] {
  const known = new Set(
    roster.flatMap((record) => record.names.flatMap((name) => normName(name).split(' ')))
  )
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
    if (entry.mid < needed || STOPLIST.has(key) || isTitle(key) || known.has(key)) continue
    const norm = normName(entry.display)
    const gate = twinGate(entry.display, roster, dismissed.names)
    const base = {
      name: entry.display,
      norm,
      count: entry.mid + entry.start,
      nodeIds: entry.nodeIds
    }
    if (gate.outcome === 'clear') {
      questions.push({ ...base, kind: 'newName', recordId: null, recordName: null })
      continue
    }
    if (gate.recordId === null) continue
    if (
      dismissed.aliasKeys.has(dismissedKey({ kind: 'alias', recordId: gate.recordId, alias: norm }))
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

/** An answer to a question, as `names:answer` takes it. */
export const NameAnswer = z.discriminatedUnion('kind', [
  /** A new name: make a record of it in this category. */
  z.object({ kind: z.literal('addAs'), name: z.string().trim().min(1), categoryId: z.string() }),
  /** A new name: it is not a name (a `name` dismissal). */
  z.object({ kind: z.literal('notAName'), name: z.string().trim().min(1) }),
  /** A nickname: Yes, add it to the record (origin `confirmed`). */
  z.object({ kind: z.literal('yes'), name: z.string().trim().min(1), recordId: z.string() }),
  /** A nickname: No (an `alias` dismissal). */
  z.object({ kind: z.literal('no'), name: z.string().trim().min(1), recordId: z.string() })
])
export type NameAnswer = z.infer<typeof NameAnswer>

/** What an answer did (`names:answer`): a record made or given a nickname, a tombstone, or the gate's warning. */
export const NameAnswerResult = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('record'), record: StoryRecord }),
  z.object({ kind: z.literal('dismissed'), dismissed: Dismissed }),
  z.object({ kind: z.literal('gate'), gate: TwinGateBlocked })
])
export type NameAnswerResult = z.infer<typeof NameAnswerResult>
