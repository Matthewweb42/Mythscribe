import { z } from 'zod'
import { estimateTokens } from '../ai'
import { queryTerms } from '../searchTerms'
import { normName } from './names'
import type { RecordKind } from './records'

/**
 * Secrets and plot threads as story memory v2 keeps them (F-16.22, F-16.23; design §2.5): records
 * of two fixed categories, made silently by the reader whenever a proved claim backs one (each
 * with a defining quote, `topic_quote`), or by the author. They are topics, not names: the name
 * scan, the twin gate, name questions, the spellcheck and Rename in book read only
 * `NAMED_KINDS` (P2b-D2). Pure.
 */

export const TOPIC_KINDS = ['secret', 'thread'] as const
export const TopicKind = z.enum(TOPIC_KINDS)
export type TopicKind = z.infer<typeof TopicKind>

/** Whether a record kind is a topic (a secret or a thread). */
export function isTopicKind(kind: RecordKind | null | undefined): kind is TopicKind {
  return kind === 'secret' || kind === 'thread'
}

/**
 * The category of secrets (P2b-D1): a v2-only built-in, listed in the sidebar once one exists.
 * `recordKindOf('secret')` is `secret`. Threads keep P1's `thread` category.
 */
export const SECRET_CATEGORY_ID = 'secret'
export const THREAD_CATEGORY_ID = 'thread'

/** Each topic kind's category. */
export const TOPIC_CATEGORY: Readonly<Record<TopicKind, string>> = {
  secret: SECRET_CATEGORY_ID,
  thread: THREAD_CATEGORY_ID
}

/** Whether a category holds topics (its category cannot change, P2b-D1). */
export const isTopicCategory = (categoryId: string): boolean =>
  categoryId === SECRET_CATEGORY_ID || categoryId === THREAD_CATEGORY_ID

/**
 * The kinds that are names (P2b-D2): what the name scan, mentions, the twin gate, name questions,
 * the spellcheck and Rename in book read. Secrets and threads are not among them.
 */
export const NAMED_KINDS: readonly RecordKind[] = ['character', 'place', 'thing', 'group', 'term']

export const isNamedKind = (kind: RecordKind | null | undefined): boolean =>
  kind !== null && kind !== undefined && NAMED_KINDS.includes(kind)

/** A thread step (design §2.2 "Slots"). */
export const THREAD_STEPS = ['opens', 'advances', 'resolves'] as const
export const ThreadStep = z.enum(THREAD_STEPS)
export type ThreadStep = z.infer<typeof ThreadStep>

/** The step a reader or checker wrote, read leniently (case, a trailing "s" or "d"), else null. */
export function parseStep(text: string | null | undefined): ThreadStep | null {
  if (typeof text !== 'string') return null
  const word = text.trim().toLowerCase()
  if (word === 'opens' || word === 'open' || word === 'opened') return 'opens'
  if (word === 'advances' || word === 'advance' || word === 'advanced') return 'advances'
  if (word === 'resolves' || word === 'resolve' || word === 'resolved') return 'resolves'
  return null
}

/**
 * The order of steps within one scene (the v1 rank rule, `threadEventRank`): the text's order
 * holds, except that a resolve comes last, so a scene that moves a thread and closes it reads as
 * closing it.
 */
export const stepRank = (step: ThreadStep): number => (step === 'resolves' ? 1 : 0)

/** The slot a thread step's *Not right* key uses: `thread:<threadId>` with the step as the value. */
export const threadNotRightSlot = (threadId: string): string => `thread:${threadId}`

/** The most words a topic's label keeps (`reader.v2` proposes at most 8). */
export const TOPIC_LABEL_MAX_WORDS = 8
/** Past the topics roster's budget, labels shorten to this many words (P2b-D10). */
export const TOPIC_LABEL_SHORT_WORDS = 4
/** The topics roster's share of the reader's cached prefix (P2b-D10). */
export const TOPIC_ROSTER_TOKENS = 400

/** New topics one page may make (P2b-D11); the rest are dropped and counted (`topicCap`). */
export const TOPIC_CAPS: Readonly<Record<TopicKind, number>> = { secret: 3, thread: 2 }

/** A topic's short id prefix in the reader's roster: `s3` a secret, `t2` a thread. */
export const TOPIC_ID_PREFIX: Readonly<Record<TopicKind, string>> = { secret: 's', thread: 't' }

/**
 * A topic's label as stored and shown: whitespace collapsed, outer quotes and punctuation trimmed,
 * cut to `max` words. A leading "the" is kept ("the sold map"), unlike `valueKey`.
 */
export function topicLabel(text: string, max = TOPIC_LABEL_MAX_WORDS): string {
  const words = text
    .normalize('NFC')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .split(' ')
    .filter((word) => word !== '')
  return words
    .slice(0, max)
    .join(' ')
    .replace(/[^\p{L}\p{N}]+$/u, '')
}

/** A topic's line in the reader's roster: `s3 the sold map · secret`. */
export function topicRosterLine(short: string, label: string, kind: TopicKind): string {
  return `${short} ${label} · ${kind}`
}

/** Tokens of a roster's topic lines (the 400-token budget, P2b-D10). */
export const topicLinesTokens = (lines: readonly string[]): number =>
  lines.length === 0 ? 0 : estimateTokens(lines.join('\n'))

/** A roster name as `topicTerms` folds it: one of a record's names (`NAMED_KINDS` only). */
export interface TopicName {
  recordId: string
  text: string
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * The words a topic is compared by (P2b-D4): `queryTerms` over its label and defining quote, with
 * every roster name in them folded to its record (`@<recordId>`), so "Ashby's return" and "Ned's
 * homecoming" share Ashby, and a renamed character still matches. Names are matched whole, the
 * longest first, possessives included; a name with a capital letter only as written.
 */
export function topicTerms(label: string, quote: string, names: readonly TopicName[]): string[] {
  let text = `${label} ${quote}`.replace(/[‘’]/g, "'")
  const records: string[] = []
  const ordered = [...names]
    .filter((name) => normName(name.text) !== '')
    .sort((a, b) => b.text.length - a.text.length)
  for (const name of ordered) {
    const flags = /[\p{Lu}\p{Lt}]/u.test(name.text) ? 'gu' : 'giu'
    const pattern = new RegExp(
      `(?<![\\p{L}\\p{N}])${escapeRegExp(name.text.replace(/[‘’]/g, "'"))}(?:'s)?(?![\\p{L}\\p{N}])`,
      flags
    )
    if (!pattern.test(text)) continue
    pattern.lastIndex = 0
    text = text.replace(pattern, ' ')
    const term = `@${name.recordId}`
    if (!records.includes(term)) records.push(term)
  }
  return [...records, ...queryTerms(text).filter((term) => !records.includes(term))]
}

/** A topic `sameAsCandidates` compares: its id, kind, terms and (for secrets) its holders. */
export interface TopicFacet {
  id: string
  kind: TopicKind
  terms: readonly string[]
  /** For a secret, who holds it (counted knows lines); empty for a thread. */
  holders: readonly string[]
}

/**
 * The open topics a new one might repeat (P2b-D4): those of the same kind sharing at least one
 * term (a content word or a named record) or, for secrets, a holder; the highest overlap first
 * (terms and holders shared, counted together), the given order among equals; at most `max`.
 * The caller passes only open topics (every secret with live evidence; threads not resolved as of
 * the scene).
 */
export function sameAsCandidates(
  fresh: TopicFacet,
  open: readonly TopicFacet[],
  options: { max?: number } = {}
): TopicFacet[] {
  const max = options.max ?? 3
  const terms = new Set(fresh.terms)
  const holders = new Set(fresh.kind === 'secret' ? fresh.holders : [])
  return open
    .flatMap((topic, index) => {
      if (topic.kind !== fresh.kind || topic.id === fresh.id) return []
      const sharedTerms = topic.terms.filter((term) => terms.has(term)).length
      const sharedHolders =
        fresh.kind === 'secret' ? topic.holders.filter((id) => holders.has(id)).length : 0
      const overlap = sharedTerms + sharedHolders
      return overlap > 0 ? [{ topic, overlap, index }] : []
    })
    .sort((a, b) => b.overlap - a.overlap || a.index - b.index)
    .slice(0, max)
    .map((each) => each.topic)
}

/**
 * A label made unique among the records' names (P2b-D1): as it is when no other record holds its
 * norm, else with " (secret)" / " (thread)", then with the scene reference too. `taken` answers
 * whether a norm is held.
 */
export function uniqueTopicLabel(
  label: string,
  kind: TopicKind,
  ref: string | null,
  taken: (norm: string) => boolean
): string {
  const tries = [
    label,
    `${label} (${kind})`,
    ...(ref === null ? [] : [`${label} (${kind}, ${ref})`])
  ]
  for (const each of tries) if (!taken(normName(each))) return each
  let n = 2
  for (;;) {
    const each = `${label} (${kind} ${n})`
    if (!taken(normName(each))) return each
    n += 1
  }
}
