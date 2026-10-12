import type { ReadingOrder } from '@shared/memory/asOf'
import type { Claim } from '@shared/memory/claims'
import { HOW_LABEL, knowsLine, parseHow } from '@shared/memory/knows'
import type { RecordOrigin, StoryRecordSummary } from '@shared/memory/records'
import { threadsAsOf } from '@shared/memory/threadsAsOf'
import {
  isNamedKind,
  topicTerms,
  type TopicFacet,
  type TopicKind,
  type TopicName
} from '@shared/memory/topics'
import type { ThreadMemoryView } from '@shared/memory/views'
import type { TreeDb } from '../../tree/treeStore'
import { listRecords } from '../recordStore'
import { topicsInDraft } from './recordEvidence'
import type { ReaderRoster } from './rosterCache'
import { listTopicQuotes, type TopicQuote } from './topicStore'

/**
 * The secrets and threads as one reading sees them (F-16.22, F-16.23; plan P2b §2.2, §2.4): built
 * once per reading from the records, the active draft's reveals and its claims as of the scene, so
 * the pipeline can say which listed topics the window touches (the user turn's topic lines), how a
 * checker item names a topic (`s3 the sold map: “…”`) and which open topics a new one may repeat
 * (the Same candidates, P2b-D4). Local: nothing here is sent but what these lines say, and nothing
 * here ever says who does not know (P2b rule 9).
 */

/** A secret or thread record as the reading reads it. */
interface TopicRecord {
  recordId: string
  kind: TopicKind
  label: string
  origin: RecordOrigin
}

/** A topic's revealing sentence in the active draft, and where it stands. */
export interface TopicReveal {
  quote: string
  nodeId: string
  ref: string
}

export interface TopicContext {
  /** The kind of a secret or thread record; null for any other record. */
  kindOf(recordId: string): TopicKind | null
  labelOf(recordId: string): string
  /** Its revealing sentence in the active draft: its defining reveal (a live one first), else a merged one. */
  revealOf(recordId: string): TopicReveal | null
  /** A knows or step item's topic as the checker reads it: `s3 the sold map: “Tomas sold the map”`. */
  itemLine(recordId: string): string
  /** The words a topic is compared by (`topicTerms`, names folded to their records). */
  termsOf(label: string, quote: string): string[]
  /**
   * The open topics of `kind` a new one may repeat (P2b-D4): the author's, and the AI's the active
   * draft backs; threads not resolved as of the scene. Secrets carry their holders (the learners of
   * counted knows lines as of the scene).
   */
  open(kind: TopicKind): TopicFacet[]
  /**
   * The user turn's topic lines (P2b §2.2): the listed secrets whose words the window shares or
   * that someone here holds (`s3 the sold map: r7 overheard 9.3 (from r2); r2 knew before 5.1`),
   * and the open threads it names or matches (`t2 Ashby's return: open since 13.1, last 13.6`).
   */
  lines(windowText: string, here: ReadonlySet<string>): string[]
}

export interface TopicContextInput {
  roster: ReaderRoster
  records: readonly StoryRecordSummary[]
  draftId: string
  order: ReadingOrder
  /** The scene read; topics are seen as of it. */
  nodeId: string
  /** The active draft's claims as of the scene (in reading order up to and including it). */
  claims: readonly Claim[]
}

/** Most holders a secret's topic line names. */
const LINE_HOLDERS = 4

/**
 * A topic's revealing sentence in a draft's reveals (`quotes`, read on first need): its defining
 * reveal, a live one first, else a merged one; memoised per topic.
 */
function revealPicker(
  quotes: () => readonly TopicQuote[],
  refOf: (nodeId: string) => string
): (recordId: string) => TopicReveal | null {
  const reveals = new Map<string, TopicReveal | null>()
  return (recordId) => {
    if (reveals.has(recordId)) return reveals.get(recordId) ?? null
    const rank = (quote: TopicQuote): number =>
      (quote.role === 'defining' ? 0 : 2) + (quote.state === 'live' ? 0 : 1)
    const best = quotes()
      .filter((quote) => quote.recordId === recordId)
      .sort((a, b) => rank(a) - rank(b))[0]
    const found =
      best === undefined
        ? null
        : { quote: best.quote, nodeId: best.nodeId, ref: refOf(best.nodeId) }
    reveals.set(recordId, found)
    return found
  }
}

/** How a checker item names a listed topic: `s3 the sold map: “Tomas sold the map”`. */
function itemLiner(
  roster: ReaderRoster,
  labelOf: (recordId: string) => string,
  revealOf: (recordId: string) => TopicReveal | null
): (recordId: string) => string {
  return (recordId) => {
    const short = roster.topicShortOf(recordId) ?? '?'
    const reveal = revealOf(recordId)
    const label = labelOf(recordId)
    return reveal === null ? `${short} ${label}` : `${short} ${label}: “${reveal.quote}”`
  }
}

/**
 * The checker's topic lines alone (the spot checks and *Not right › Not about*, which read a
 * stored knows line or step outside a reading): each topic with its revealing sentence in the
 * draft (`draftId`; none when null).
 */
export function topicItemLines(
  db: TreeDb,
  roster: ReaderRoster,
  draftId: string | null
): Pick<TopicContext, 'itemLine'> {
  const labels = new Map(
    listRecords(db)
      .filter((record) => record.kind === 'secret' || record.kind === 'thread')
      .map((record) => [record.id, record.name])
  )
  let quotes: TopicQuote[] | null = null
  const revealOf = revealPicker(
    () => (quotes ??= draftId === null ? [] : listTopicQuotes(db, draftId)),
    () => ''
  )
  return { itemLine: itemLiner(roster, (recordId) => labels.get(recordId) ?? '', revealOf) }
}

export function topicContext(db: TreeDb, input: TopicContextInput): TopicContext {
  const { roster, order } = input
  const topics = new Map<string, TopicRecord>()
  const names: TopicName[] = []
  for (const record of input.records) {
    if (record.kind === 'secret' || record.kind === 'thread') {
      topics.set(record.id, {
        recordId: record.id,
        kind: record.kind,
        label: record.name,
        origin: record.origin
      })
    } else if (isNamedKind(record.kind)) {
      for (const alias of record.aliases) names.push({ recordId: record.id, text: alias.text })
    }
  }
  const refOf = (nodeId: string): string => order.refs.get(nodeId) ?? '?'

  let quotes: TopicQuote[] | null = null
  const allQuotes = (): TopicQuote[] => (quotes ??= listTopicQuotes(db, input.draftId))
  const revealOf = revealPicker(allQuotes, refOf)

  const termsOf = (label: string, quote: string): string[] => topicTerms(label, quote, names)

  /** Counted knows lines as of the scene, by secret, in reading order (the earliest per learner). */
  let holders: Map<string, Claim[]> | null = null
  const holdersOf = (secretId: string): Claim[] => {
    if (holders === null) {
      holders = new Map()
      const placed = input.claims
        .filter(
          (claim) =>
            claim.slot === 'knows' &&
            claim.state === 'live' &&
            claim.objectId !== null &&
            claim.recordId !== null &&
            knowsLine(claim) === 'counts'
        )
        .sort(
          (a, b) =>
            (order.order.get(a.nodeId) ?? 0) - (order.order.get(b.nodeId) ?? 0) || a.para - b.para
        )
      for (const claim of placed) {
        const key = claim.objectId ?? ''
        const list = holders.get(key) ?? []
        if (!list.some((each) => each.recordId === claim.recordId)) list.push(claim)
        holders.set(key, list)
      }
    }
    return holders.get(secretId) ?? []
  }

  let threads: Map<string, ThreadMemoryView> | null = null
  const threadOf = (recordId: string): ThreadMemoryView | null => {
    if (threads === null) {
      const views = threadsAsOf({
        threads: [...topics.values()].filter((topic) => topic.kind === 'thread'),
        claims: input.claims.filter((claim) => claim.slot === 'thread'),
        quotes: allQuotes(),
        reading: order,
        atId: input.nodeId
      })
      threads = new Map(views.map((view) => [view.recordId, view]))
    }
    return threads.get(recordId) ?? null
  }

  let backed: Set<string> | null = null
  const isBacked = (recordId: string): boolean =>
    (backed ??= topicsInDraft(db, input.draftId)).has(recordId)

  const itemLine = itemLiner(roster, (recordId) => topics.get(recordId)?.label ?? '', revealOf)

  return {
    kindOf: (recordId) => topics.get(recordId)?.kind ?? null,
    labelOf: (recordId) => topics.get(recordId)?.label ?? '',
    revealOf,
    itemLine,
    termsOf,
    open(kind) {
      return [...topics.values()]
        .filter(
          (topic) =>
            topic.kind === kind &&
            (topic.origin !== 'ai' || isBacked(topic.recordId)) &&
            (kind === 'secret' || threadOf(topic.recordId)?.status !== 'resolved')
        )
        .map((topic) => ({
          id: topic.recordId,
          kind: topic.kind,
          terms: termsOf(topic.label, revealOf(topic.recordId)?.quote ?? ''),
          holders:
            kind === 'secret'
              ? holdersOf(topic.recordId).flatMap((claim) =>
                  claim.recordId === null ? [] : [claim.recordId]
                )
              : []
        }))
    },
    lines(windowText, here) {
      const window = new Set(termsOf('', windowText))
      const out: string[] = []
      const listed = [...topics.values()]
        .map((topic) => ({ topic, short: roster.topicShortOf(topic.recordId) }))
        .filter((entry): entry is { topic: TopicRecord; short: string } => entry.short !== null)
      for (const { topic, short } of listed) {
        const matched = termsOf(topic.label, revealOf(topic.recordId)?.quote ?? '').some((term) =>
          window.has(term)
        )
        if (topic.kind === 'secret') {
          const held = holdersOf(topic.recordId)
          if (
            !matched &&
            !held.some((claim) => claim.recordId !== null && here.has(claim.recordId))
          ) {
            continue
          }
          const parts = held.slice(0, LINE_HOLDERS).map((claim) => {
            const how = parseHow(claim.how)
            const from = claim.fromId === null ? '' : ` (from ${roster.shortOf(claim.fromId)})`
            return `${roster.shortOf(claim.recordId ?? '')} ${how === null ? (claim.how ?? '') : HOW_LABEL[how]} ${refOf(claim.nodeId)}${from}`
          })
          const reveal = revealOf(topic.recordId)
          if (parts.length === 0 && reveal !== null) parts.push(`revealed ${reveal.ref}`)
          out.push(
            parts.length === 0
              ? `${short} ${topic.label}`
              : `${short} ${topic.label}: ${parts.join('; ')}`
          )
          continue
        }
        const view = threadOf(topic.recordId)
        if (!matched || view?.status !== 'open' || view.opened === null) continue
        const last =
          view.last !== null && view.last.ref !== view.opened.ref ? `, last ${view.last.ref}` : ''
        out.push(`${short} ${topic.label}: open since ${view.opened.ref}${last}`)
      }
      return out
    }
  }
}
