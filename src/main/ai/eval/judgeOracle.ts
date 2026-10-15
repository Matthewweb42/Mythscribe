import { normalizeForMatch } from '@shared/critique'
import type {
  FindingRule,
  FindingSide,
  FindingVariant,
  JudgeVerdict
} from '@shared/memory/findings'
import { normName } from '@shared/memory/names'
import { isAbsence, statesAbsenceAsFact } from '@shared/scribeAnswer'
import { activeDraftId } from '../../draft/draftStore'
import { draftClaims } from '../../memory/reading/claimStore'
import { requestKind } from '../../memory/reading/readingFixture'
import { listTopics } from '../../memory/reading/topicStore'
import { TEST_BOOK_LABELS } from '../../memory/testBook/labels'
import type { TestBookLabels } from '../../memory/testBook/labels.schema'
import type { TestBookProject } from '../../memory/testBook/project'
import { JUDGE_CONFIRM_RULES, JUDGE_SENTINEL } from '../prompts/judge.v1'
import type { AiMessage } from '../providers/types'
import { fakeChatServer, type ChatServer, type ChatServerReply } from './fakeChatServer'
import {
  FINDABLE_CONTRADICTIONS,
  oracleRead,
  oracleVerify,
  overlaps,
  sceneOf
} from './memoryOracle'

/**
 * The contradiction judge's oracle (F-16.27, F-16.30; plan P4 §6.1), for the offline replays and
 * the live contradictions run's offline tests (`findings.eval.ts`). Test support only: nothing in
 * the app imports it.
 *
 * - **Reading a request as it was sent** (`sentJudge`): a `judge.v1` batch ("Pairs:") or the
 *   stronger check's one pair ("Pair:"), each item's question, its A and B lines and its time-skip
 *   hints, from the text alone.
 * - **The oracle judge** (`judgeOracleReply`): `c` for an item that is a labelled contradiction's
 *   pair (its two quotes, one on each side, either way round, and a question of the label's rule
 *   about the label's record), `ok` for everything else; the stronger check likewise. Planted
 *   judges (`JudgePlant`) answer otherwise, for the adversarial replays.
 * - **The labels against stored rows** (`labelMatches`, `negativeHits`): which candidates or
 *   findings a labelled contradiction or a `finding` negative is.
 * - **Absence** (`statesAbsence`): app-composed text that says something did not happen or someone
 *   does not know (P4 rule 5).
 */

export type LabelContradiction = TestBookLabels['contradictions'][number]
export type LabelNegative = TestBookLabels['negatives'][number]

/** One side of a sent item: its bracket (place, order, voice, mode…) and the rest of its line. */
export interface SentSide {
  head: string
  /** "says <value>: <context>". */
  text: string
}

/** One numbered item of a judge request, as sent. */
export interface SentItem {
  n: number
  question: string
  a: SentSide
  b: SentSide
  between: string | null
}

/** A judge request as sent: a batch (both orders are separate requests) or the stronger check. */
export interface SentJudge {
  confirm: boolean
  items: SentItem[]
}

/** Whether a request is `judge.v1`'s (a batch or the stronger check). */
export const isJudgeRequest = (messages: readonly AiMessage[]): boolean =>
  messages[0]?.role === 'system' && messages[0].content.startsWith(JUDGE_SENTINEL)

const SIDE = /^([AB]) \[([^\]]*)\] (.*)$/u

function parseItem(block: string): SentItem | null {
  const lines = block.split('\n')
  const head = /^(\d+)\. (.*)$/u.exec(lines[0] ?? '')
  const side = (label: 'A' | 'B', line: string | undefined): SentSide | null => {
    const match = SIDE.exec(line ?? '')
    return match?.[1] === label ? { head: match[2] ?? '', text: match[3] ?? '' } : null
  }
  const a = side('A', lines[1])
  const b = side('B', lines[2])
  if (head === null || a === null || b === null) return null
  const hint = lines[3]
  return {
    n: Number(head[1]),
    question: head[2] ?? '',
    a,
    b,
    between: hint?.startsWith('Between: ') === true ? hint.slice('Between: '.length) : null
  }
}

/** A judge request read back from its messages; null for any other request. */
export function sentJudge(messages: readonly AiMessage[]): SentJudge | null {
  if (!isJudgeRequest(messages)) return null
  const user = messages.at(-1)?.content ?? ''
  const body = user.replace(/^Pairs?:\n/u, '')
  return {
    confirm: messages[0]?.content === JUDGE_CONFIRM_RULES,
    items: body.split('\n\n').flatMap((block) => {
      const item = parseItem(block)
      return item === null ? [] : [item]
    })
  }
}

/** What a side's line says (the value code read), without the context. */
export function sideSays(side: SentSide): string {
  return /^says (.*?): /u.exec(side.text)?.[1] ?? ''
}

/**
 * The rules an item's question can be (judge.v1's wording, `judgeQuestion`): C1 and C7 share one
 * question; any other question could be any rule.
 */
export function questionRules(question: string): { rule: FindingRule; variant?: FindingVariant }[] {
  if (question.includes("the author's note.")) return [{ rule: 'C6' }]
  if (question.includes('(a plot thread)')) return [{ rule: 'C5' }]
  if (question.includes('stated age falls')) return [{ rule: 'C4', variant: 'falls' }]
  if (/: stated age .*; born /u.test(question)) return [{ rule: 'C4', variant: 'birth' }]
  if (question.includes(' passes on ')) return [{ rule: 'C3' }]
  if (question.includes(' differs between these two appearances.')) {
    return [{ rule: 'C2', variant: 'body' }]
  }
  if (question.includes(' die; the other has ')) return [{ rule: 'C2', variant: 'dead' }]
  if (/ · .*\. Can both be true\?$/u.test(question)) return [{ rule: 'C1' }, { rule: 'C7' }]
  return (['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] as const).map((rule) => ({ rule }))
}

const holds = (text: string, quote: string): boolean =>
  normalizeForMatch(text).includes(normalizeForMatch(quote))

/** The names a labelled record goes by (its name and aliases), folded. */
const labelNames = (recordId: string): string[] => {
  const record = TEST_BOOK_LABELS.records.find((each) => each.id === recordId)
  return record === undefined
    ? []
    : [record.name, ...record.aliases.map((alias) => alias.text)].map(normName)
}

/**
 * The labelled contradiction a sent item is: one label quote on each side (either way round), a
 * question of the label's rule (and variant) that names the label's record; null for none.
 */
export function labelledItem(item: SentItem): LabelContradiction | null {
  const rules = questionRules(item.question)
  const asked = normName(item.question)
  for (const label of FINDABLE_CONTRADICTIONS) {
    const other = label.b?.quote ?? label.note?.quote
    if (other === undefined) continue
    if (
      !rules.some(
        (each) =>
          each.rule === label.rule && (each.variant === undefined || each.variant === label.variant)
      )
    ) {
      continue
    }
    const names = labelNames(label.record)
    if (names.length > 0 && !names.some((name) => asked.includes(name))) continue
    const forward = holds(item.a.text, label.a.quote) && holds(item.b.text, other)
    const backward = holds(item.b.text, label.a.quote) && holds(item.a.text, other)
    if (forward || backward) return label
  }
  return null
}

/**
 * How a planted judge answers (the adversarial replays, plan P4 §6.1): `disagree` says `c` the first
 * time it sees a pair and `ok` the second (the two orders never agree); `unclear` and `allC` answer
 * every item `u` or `c`, the stronger check too; `drop` leaves every second item unanswered; `cut`
 * stops the oracle's reply halfway, cut off at its cap; `proOk` is the oracle with a stronger check
 * that clears everything.
 */
export type JudgePlant = 'disagree' | 'unclear' | 'allC' | 'drop' | 'cut' | 'proOk'

/** What a planted `disagree` judge remembers between the two orders. */
export type JudgeMemory = Map<string, number>

/** An item's identity whichever way round it was sent (its two sides' lines, sorted). */
const pairIdentity = (item: SentItem): string =>
  [item.question, ...[item.a.text, item.b.text].sort()].join('\n')

const WHY_C = 'the two passages disagree'

/** The oracle's verdict on one item (or a plant's). */
function verdictFor(item: SentItem, plant: JudgePlant | null, memory: JudgeMemory): JudgeVerdict {
  if (plant === 'unclear') return 'u'
  if (plant === 'allC') return 'c'
  if (plant === 'disagree') {
    const key = pairIdentity(item)
    const seen = memory.get(key) ?? 0
    memory.set(key, seen + 1)
    return seen % 2 === 0 ? 'c' : 'ok'
  }
  return labelledItem(item) === null ? 'ok' : 'c'
}

/**
 * The judge's reply to a `judge.v1` request: the oracle's (or a plant's) verdicts as JSON, with
 * `finishReason: 'length'` for a cut reply. Null for a request that is not the judge's.
 */
export function judgeOracleReply(
  messages: readonly AiMessage[],
  plant: JudgePlant | null = null,
  memory: JudgeMemory = new Map()
): { text: string; finishReason?: string } | null {
  const sent = sentJudge(messages)
  if (sent === null) return null
  if (sent.confirm) {
    const item = sent.items[0]
    const verdict: JudgeVerdict =
      plant === 'proOk'
        ? 'ok'
        : item === undefined
          ? 'u'
          : plant === 'cut' || plant === 'drop'
            ? verdictFor(item, null, memory)
            : verdictFor(item, plant, memory)
    const why = verdict === 'c' ? WHY_C : verdict === 'ok' ? 'both can be true' : 'not settled'
    return { text: JSON.stringify({ r: verdict, w: why }) }
  }
  const answered = sent.items.filter((item) => plant !== 'drop' || item.n % 2 === 1)
  const own = plant === 'drop' || plant === 'cut' || plant === 'proOk' ? null : plant
  const v = answered.map((item) => {
    const r = verdictFor(item, own, memory)
    return r === 'c' ? { i: item.n, r, w: WHY_C } : { i: item.n, r }
  })
  const text = JSON.stringify({ v })
  if (plant !== 'cut' || v.length < 2) return { text }
  // Cut off halfway through, at the cap: the reply stops mid-entry.
  return { text: text.slice(0, Math.floor(text.length / 2)), finishReason: 'length' }
}

/**
 * The judge oracle behind a fake OpenRouter (`fakeChatServer`), so a live run's whole path is
 * driven offline from `OPENROUTER_API_KEY` alone, nothing spent: the judge's requests answered by
 * the oracle (or `plant()`, read at each request so a test can change it between runs), the
 * reader's and the checker's by the memory oracle (a live reading of the memory, plan P4 §6.2).
 */
export function judgeOracleServer(
  options: {
    plant?: () => JudgePlant | null
    /** Each answered request's reported cost: one figure, or by request (null: none reported). */
    costUsd?: number | null | ((messages: AiMessage[]) => number | null)
    /** An HTTP error status answered from the request after this many (a 429, a 402). */
    failAfter?: { calls: number; status: number }
  } = {}
): ChatServer {
  const memory: JudgeMemory = new Map()
  const server: ChatServer = fakeChatServer((messages): ChatServerReply => {
    const failAfter = options.failAfter
    if (failAfter !== undefined && server.calls.length > failAfter.calls) {
      return { text: 'Rate limit exceeded', status: failAfter.status }
    }
    const costUsd =
      typeof options.costUsd === 'function' ? options.costUsd(messages) : options.costUsd
    const cost = costUsd === undefined ? {} : { costUsd }
    const judged = judgeOracleReply(messages, options.plant?.() ?? null, memory)
    if (judged !== null) {
      return {
        text: judged.text,
        ...cost,
        ...(judged.finishReason === undefined ? {} : { finishReason: judged.finishReason })
      }
    }
    return {
      text:
        requestKind({ messages }) === 'verify'
          ? oracleVerify({ messages })
          : oracleRead({ messages }),
      ...cost
    }
  })
  return server
}

// ---- The labels against stored candidates and findings --------------------------------------

/** What a candidate and a stored finding share: what the labels are matched on. */
export interface Pairing {
  rule: FindingRule
  variant: FindingVariant | null
  recordId: string
  slot: string
  a: FindingSide
  b: FindingSide
}

/** A labelled record's id in the project: a record the book was built with, or a topic it made. */
export function labelRecord(book: TestBookProject, label: string): string | null {
  const made = book.records.get(label)
  if (made !== undefined) return made
  const name = TEST_BOOK_LABELS.records.find((record) => record.id === label)?.name ?? ''
  return (
    listTopics(book.db).find((topic) => normName(topic.label) === normName(name))?.recordId ?? null
  )
}

/** Whether a side is the labelled passage: a claim with that quote there, or a presence there. */
export function sideIs(
  book: TestBookProject,
  side: FindingSide,
  ref: { scene: string; quote: string }
): boolean {
  if (side.kind === 'presence') return sceneOf(book, side.nodeId) === ref.scene
  if (side.kind !== 'claim') return false
  const claim = draftClaims(book.db, activeDraftId(book.db)).find(
    (each) => each.id === side.claimId
  )
  return (
    claim !== undefined &&
    sceneOf(book, claim.nodeId) === ref.scene &&
    overlaps(claim.quote, ref.quote)
  )
}

/** Whether a side is the labelled note line (a Pinned page's or the Research page's). */
export function noteIs(
  book: TestBookProject,
  side: FindingSide,
  note: NonNullable<LabelContradiction['note']>
): boolean {
  if (side.kind !== 'note') return false
  if (note.record !== undefined && side.ownerId !== labelRecord(book, note.record)) return false
  if (note.research !== undefined && side.ownerKind !== 'research') return false
  return normalizeForMatch(note.quote).includes(normalizeForMatch(side.value))
}

/** The candidates or findings a labelled contradiction is, either way round. */
export function labelMatches<T extends Pairing>(
  book: TestBookProject,
  label: LabelContradiction,
  among: readonly T[]
): T[] {
  const recordId = labelRecord(book, label.record)
  return among.filter((candidate) => {
    if (candidate.rule !== label.rule || candidate.recordId !== recordId) return false
    if (label.variant !== undefined && candidate.variant !== label.variant) return false
    const sides = [candidate.a, candidate.b]
    const other = (side: FindingSide): boolean =>
      label.b !== undefined
        ? sideIs(book, side, label.b)
        : label.note !== undefined && noteIs(book, side, label.note)
    return sides.some((side, i) => sideIs(book, side, label.a) && other(sides[1 - i] ?? side))
  })
}

/** The candidates or findings a `finding` negative forbids (or, for a judge trap, asks for). */
export function negativeHits<T extends Pairing>(
  book: TestBookProject,
  negative: LabelNegative,
  among: readonly T[]
): T[] {
  const recordId = negative.record === undefined ? null : labelRecord(book, negative.record)
  return among.filter(
    (candidate) =>
      candidate.rule === negative.rule &&
      (recordId === null || candidate.recordId === recordId) &&
      (negative.slot === undefined ||
        candidate.slot === negative.slot ||
        candidate.slot.startsWith(`${negative.slot}:`)) &&
      [candidate.a, candidate.b].some(
        (side) => side.kind !== 'note' && sceneOf(book, side.nodeId) === negative.scene
      )
  )
}

/** The `finding` negatives: traps (a candidate the judge must rule fine) and the rest (none at all). */
export const FINDING_NEGATIVES = TEST_BOOK_LABELS.negatives.filter(
  (negative): negative is LabelNegative & { rule: FindingRule } =>
    negative.kind === 'finding' && negative.rule !== undefined
)

/** A labelled contradiction as a report names it. */
export const labelText = (each: LabelContradiction): string =>
  `${each.rule}${each.variant === undefined ? '' : ` ${each.variant}`} ${each.record}: ${each.a.quote}`

/** A negative as a report names it. */
export const negativeText = (negative: LabelNegative): string =>
  `${negative.scene} ${negative.rule ?? ''} ${negative.record ?? ''}: ${negative.reason}`

// ---- Absence (P4 rule 5) ---------------------------------------------------------------------

/** An event's absence stated in app-composed words ("no change", "never mentioned again"). */
const EVENT_ABSENCE =
  /\b(?:no\s+(?:change|step|scene|learning|death|mention)s?\b|not\s+(?:shown|mentioned|named|seen)\b|never\s+(?:shown|mentioned|named|seen|appears|happens|returns|again)\b|without\s+(?:a\s+|any\s+)?(?:change|step|mention)\b|nobody\s+learns|no\s+one\s+learns)/iu

/**
 * Whether app-composed text states an absence as a fact: someone does not know, nobody learns, a
 * search found nothing, or an event did not happen. Book quotes are never passed here: only what
 * the app writes (a question, a value, a label, a reason, an ask).
 */
export function statesAbsence(text: string): boolean {
  return statesAbsenceAsFact(text) || isAbsence(text) || EVENT_ABSENCE.test(text)
}
