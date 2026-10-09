import { z } from 'zod'
import { EntityFieldId, EntityKind } from './entities'
import { fieldMode, isFieldFact, type Fact } from './facts'
import type { ThreadView } from './threads'

/**
 * The To do list (F-9.16, phase P3b of the knowledge model): what the book leaves unexplained,
 * contradicted, unfinished, or unstated. Most items are found locally for free (the rules below);
 * the rare book-level AI check adds the gaps only judgement can see. An item never fills a gap
 * itself: it points at a passage, says why it was flagged, and offers suggestions the author may
 * pick from as options, never as facts ("no assuming", the author's rule of 2026-10-08). Picking
 * one only fills an editable line; the author's Add writes it, as their own text, to a sheet, a
 * scene's notes, or its brief. Nothing is ever written to the manuscript.
 *
 * Done and Dismiss are both tombstones keyed by the item's `key`, so a settled item never comes
 * back. The contradictions of the consistency checker (F-13.4) are read live, never copied: their
 * own tombstone is the finding's `dismissed` status.
 */

/** The four kinds the list groups by (the author's, 2026-10-08). */
export const TODO_KINDS = ['undefined', 'contradiction', 'looseEnd', 'gap'] as const
export const TodoKind = z.enum(TODO_KINDS)
export type TodoKind = z.infer<typeof TodoKind>

export const TODO_KIND_LABEL: Readonly<Record<TodoKind, string>> = {
  undefined: 'Undefined',
  contradiction: 'Contradictions',
  looseEnd: 'Loose ends',
  gap: 'Gaps'
}

/** One of a kind, for a card's heading. */
export const TODO_KIND_NOUN: Readonly<Record<TodoKind, string>> = {
  undefined: 'Undefined',
  contradiction: 'Contradiction',
  looseEnd: 'Loose end',
  gap: 'Gap'
}

/**
 * Why an item exists. The local rules: `emptyRecord`, `unknownName`, `continuity` (read from the
 * findings), `factConflict`, `openThread`, `vanished`, `noLimits`, `noGoal`. The AI check's:
 * `term`, `question`, `timeline`, `rule`, `motivation`.
 */
export const TODO_RULES = [
  'emptyRecord',
  'unknownName',
  'term',
  'continuity',
  'factConflict',
  'openThread',
  'vanished',
  'question',
  'noLimits',
  'noGoal',
  'timeline',
  'rule',
  'motivation'
] as const
export const TodoRule = z.enum(TODO_RULES)
export type TodoRule = z.infer<typeof TodoRule>

/** The kind each rule files under. */
export const TODO_RULE_KIND: Readonly<Record<TodoRule, TodoKind>> = {
  emptyRecord: 'undefined',
  unknownName: 'undefined',
  term: 'undefined',
  continuity: 'contradiction',
  factConflict: 'contradiction',
  openThread: 'looseEnd',
  vanished: 'looseEnd',
  question: 'looseEnd',
  noLimits: 'gap',
  noGoal: 'gap',
  timeline: 'gap',
  rule: 'gap',
  motivation: 'gap'
}

export const TODO_SOURCES = ['local', 'ai'] as const
export const TodoSource = z.enum(TODO_SOURCES)
export type TodoSource = z.infer<typeof TodoSource>

/** `open`: waiting; `done`: handled; `dismissed`: not a problem. The last two never return. */
export const TODO_STATUSES = ['open', 'done', 'dismissed'] as const
export const TodoStatus = z.enum(TODO_STATUSES)
export type TodoStatus = z.infer<typeof TodoStatus>

/** The scene brief fields a pick may set (`SceneBrief`'s keys). */
export const TODO_BRIEF_FIELDS = ['goal', 'conflict', 'turn', 'beat', 'after'] as const

/**
 * Where an accepted line goes: a sheet field, a blank sheet's page, a scene's notes, a field of a
 * scene's brief, a new record, or nowhere (an item with only actions). Stored as JSON on the row.
 */
export const TodoTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('field'), entityId: z.string(), field: EntityFieldId }),
  z.object({ kind: z.literal('page'), entityId: z.string() }),
  z.object({ kind: z.literal('notes'), nodeId: z.string() }),
  z.object({ kind: z.literal('brief'), nodeId: z.string(), field: z.enum(TODO_BRIEF_FIELDS) }),
  z.object({ kind: z.literal('newRecord'), category: EntityKind, name: z.string() }),
  z.object({ kind: z.literal('none') })
])
export type TodoTarget = z.infer<typeof TodoTarget>

export const NO_TODO_TARGET: TodoTarget = { kind: 'none' }

/** A stored target as today's; an unreadable cell (a later build's kind) is no target. */
export function parseTodoTarget(raw: string): TodoTarget {
  try {
    const parsed = TodoTarget.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : NO_TODO_TARGET
  } catch {
    return NO_TODO_TARGET
  }
}

/** Longest subject, quote, reason, and suggestion an item carries. */
export const TODO_SUBJECT_MAX = 120
export const TODO_QUOTE_MAX = 240
export const TODO_WHY_MAX = 300
export const TODO_SUGGESTION_MAX = 160
/** At most this many suggestions per item. */
export const TODO_SUGGESTIONS_MAX = 3
/** The longest line the author may add from a card. */
export const TODO_LINE_MAX = 2_000

/** A stored suggestions cell as a list; an unreadable one is none. */
export function parseTodoSuggestions(raw: string): string[] {
  try {
    const json: unknown = JSON.parse(raw)
    if (!Array.isArray(json)) return []
    return json
      .filter((each): each is string => typeof each === 'string' && each.trim() !== '')
      .slice(0, TODO_SUGGESTIONS_MAX)
  } catch {
    return []
  }
}

/** One item as the list shows it. A contradiction of the consistency checker has the id `c:<findingId>`. */
export const TodoItem = z.object({
  id: z.string(),
  kind: TodoKind,
  rule: TodoRule,
  source: TodoSource,
  /** What the item is about: a name, a term, a thread. */
  subject: z.string(),
  entityId: z.string().nullable(),
  /** The scene of the passage; null when the scene was deleted or the item has none. */
  nodeId: z.string().nullable(),
  /** The sentence to select in that scene; null jumps to the scene. */
  quote: z.string().nullable(),
  why: z.string(),
  target: TodoTarget,
  /** Where Add writes, in words ("Mara › Goals / motivations"); '' for no target. */
  targetLabel: z.string(),
  /** Options the author may pick from, never facts; [] until asked for. */
  suggestions: z.array(z.string()),
  /** Whether suggestions were asked for (or came with the item), so they are not asked again. */
  suggested: z.boolean(),
  status: TodoStatus,
  createdAt: z.string()
})
export type TodoItem = z.infer<typeof TodoItem>

/** The prefix of a contradiction's item id: the finding lives in `continuity_finding`. */
export const CONTINUITY_TODO_PREFIX = 'c:'

export function continuityTodoId(findingId: string): string {
  return `${CONTINUITY_TODO_PREFIX}${findingId}`
}

/** The finding behind a contradiction's item id; null for an item of the To do table. */
export function continuityFindingIdOf(id: string): string | null {
  return id.startsWith(CONTINUITY_TODO_PREFIX) ? id.slice(CONTINUITY_TODO_PREFIX.length) : null
}

/** The key a dismissal or a Done is remembered by: `<rule>:<parts>`. */
export function todoKey(rule: TodoRule, ...parts: readonly string[]): string {
  return [rule, ...parts].join(':')
}

/** A name or a term, case and spacing folded, as a key part. */
export function foldTodoName(name: string): string {
  return name.toLowerCase().replace(/\s+/gu, ' ').trim()
}

// ---------------------------------------------------------------------------------------------
// The local rules' numbers (Q5; decided by Claude, unconfirmed). Pure helpers below.
// ---------------------------------------------------------------------------------------------

/** A loose end counts only in a book with at least this many written scenes. */
export const TODO_WRITTEN_SCENES_MIN = 12
/** "Lately" is the last max(this, a quarter) of the written scenes. */
export const TODO_RECENT_SCENES_MIN = 8
export const TODO_RECENT_SHARE = 0.25
/** A record no field explains is flagged once this many scenes mention it. */
export const TODO_EMPTY_RECORD_SCENES = 2
/** A character who vanished was mentioned in at least this many scenes. */
export const TODO_VANISHED_SCENES = 3
/** A magic system, technology, or world item with no stated limits, once this many scenes mention it. */
export const TODO_LIMITS_SCENES = 3
/** A point-of-view character with no stated goal, once this many scenes are told from them. */
export const TODO_POV_SCENES = 2
/** Open local items per rule, and in total; ranked by how often the book mentions them. */
export const TODO_RULE_MAX = 20
export const TODO_LOCAL_MAX = 80

/** How many of the last written scenes count as "lately". */
export function recentWindow(written: number): number {
  return Math.max(TODO_RECENT_SCENES_MIN, Math.ceil(written * TODO_RECENT_SHARE))
}

/**
 * The open threads nothing has moved lately: an open thread with a canon event, none of whose
 * canon events falls in the last `recentWindow` written scenes. None below
 * `TODO_WRITTEN_SCENES_MIN` written scenes. `order` is the written scenes in reading order.
 */
export function staleThreads(
  threads: readonly ThreadView[],
  order: readonly string[]
): ThreadView[] {
  if (order.length < TODO_WRITTEN_SCENES_MIN) return []
  const index = new Map(order.map((id, at) => [id, at]))
  const cut = order.length - recentWindow(order.length)
  return threads.filter((thread) => {
    if (thread.status !== 'open') return false
    const at = thread.events
      .filter((event) => event.status === 'canon' && event.nodeId !== null)
      .map((event) => index.get(event.nodeId ?? '') ?? -1)
      .filter((position) => position >= 0)
    return at.length > 0 && Math.max(...at) < cut
  })
}

/** The written scenes one record is mentioned in. */
export interface RecordMentions {
  entityId: string
  /** Written scene ids, any order. */
  nodeIds: readonly string[]
}

/** A record the book stopped mentioning: its scene count and the last scene it was in. */
export interface VanishedRecord {
  entityId: string
  scenes: number
  lastNodeId: string
}

/**
 * The records mentioned in at least `TODO_VANISHED_SCENES` written scenes and in none of the last
 * `recentWindow`. None below `TODO_WRITTEN_SCENES_MIN` written scenes.
 */
export function vanishedRecords(
  mentions: readonly RecordMentions[],
  order: readonly string[]
): VanishedRecord[] {
  if (order.length < TODO_WRITTEN_SCENES_MIN) return []
  const index = new Map(order.map((id, at) => [id, at]))
  const cut = order.length - recentWindow(order.length)
  const out: VanishedRecord[] = []
  for (const record of mentions) {
    const at = [...new Set(record.nodeIds)]
      .map((id) => index.get(id) ?? -1)
      .filter((position) => position >= 0)
    if (at.length < TODO_VANISHED_SCENES) continue
    const last = Math.max(...at)
    if (last >= cut) continue
    out.push({ entityId: record.entityId, scenes: at.length, lastNodeId: order[last] ?? '' })
  }
  return out
}

/** Two values of one single-valued field that cannot both hold at one scene. */
export interface FactConflict {
  entityId: string
  attribute: string
  /** The scene of the later statement. */
  nodeId: string
  /** The earlier value, then the later one. */
  values: [string, string]
  /** The later statement's passage. */
  quote: string | null
  /** `sameScene`: one scene states two values; `ageDecrease`: an age goes down in reading order. */
  reason: 'sameScene' | 'ageDecrease'
}

const fold = (value: string): string => value.toLowerCase().replace(/\s+/gu, ' ').trim()

/** The first whole number in an age value ("31", "about 40"); null for none. */
export function ageNumber(value: string): number | null {
  const match = /\d+/u.exec(value)
  return match === null ? null : Number(match[0])
}

/**
 * The contradictions the dated facts show by themselves, with no AI: a scene stating two
 * different values of one replace field (`fieldMode`), or an age that is lower than an age stated
 * in an earlier scene. Only visible canon AI field facts of written scenes count (plan and idea
 * statements never decide a value, F-9.13); one conflict per record, field, and scene.
 */
export function factConflicts(facts: readonly Fact[], order: readonly string[]): FactConflict[] {
  const index = new Map(order.map((id, at) => [id, at]))
  const usable = facts.filter(
    (fact) =>
      fact.origin === 'ai' &&
      fact.status === 'canon' &&
      !fact.hidden &&
      isFieldFact(fact) &&
      fieldMode(fact.attribute) === 'replace' &&
      fact.nodeId !== null &&
      index.has(fact.nodeId)
  )
  const out = new Map<string, FactConflict>()
  const keyOf = (entityId: string, attribute: string, nodeId: string): string =>
    `${entityId}\u0000${attribute}\u0000${nodeId}`

  const groups = new Map<string, Fact[]>()
  for (const fact of usable) {
    const key = keyOf(fact.entityId, fact.attribute, fact.nodeId ?? '')
    groups.set(key, [...(groups.get(key) ?? []), fact])
  }
  for (const [key, group] of groups) {
    const first = group[0]
    const later = group.find(
      (fact) => first !== undefined && fold(fact.value) !== fold(first.value)
    )
    if (first === undefined || later === undefined) continue
    out.set(key, {
      entityId: first.entityId,
      attribute: first.attribute,
      nodeId: first.nodeId ?? '',
      values: [first.value, later.value],
      quote: later.quote,
      reason: 'sameScene'
    })
  }

  const ages = new Map<string, Fact[]>()
  for (const fact of usable) {
    if (fact.attribute !== 'age' || ageNumber(fact.value) === null) continue
    ages.set(fact.entityId, [...(ages.get(fact.entityId) ?? []), fact])
  }
  for (const list of ages.values()) {
    const sorted = list
      .map((fact, input) => ({ fact, input }))
      .sort(
        (a, b) =>
          (index.get(a.fact.nodeId ?? '') ?? 0) - (index.get(b.fact.nodeId ?? '') ?? 0) ||
          a.input - b.input
      )
      .map(({ fact }) => fact)
    let highest: Fact | null = null
    for (const fact of sorted) {
      const age = ageNumber(fact.value) ?? 0
      const top = highest === null ? null : ageNumber(highest.value)
      if (
        highest !== null &&
        top !== null &&
        age < top &&
        highest.nodeId !== fact.nodeId &&
        !out.has(keyOf(fact.entityId, 'age', fact.nodeId ?? ''))
      ) {
        out.set(keyOf(fact.entityId, 'age', fact.nodeId ?? ''), {
          entityId: fact.entityId,
          attribute: 'age',
          nodeId: fact.nodeId ?? '',
          values: [highest.value, fact.value],
          quote: fact.quote,
          reason: 'ageDecrease'
        })
      }
      if (top === null || age > top) highest = fact
    }
  }
  return [...out.values()]
}

/** What `isEmptyRecord` reads of a sheet. */
export interface RecordContent {
  fields: Readonly<Partial<Record<string, string>>>
  body: string | null
}

/**
 * Whether a sheet explains nothing: no filled field, an empty page, and no visible field fact the
 * scenes stated for it (`facts` are the record's; plan and idea facts count, they are words the
 * author has).
 */
export function isEmptyRecord(record: RecordContent, facts: readonly Fact[]): boolean {
  if (Object.values(record.fields).some((value) => (value ?? '').trim() !== '')) return false
  if ((record.body ?? '').trim() !== '') return false
  return !facts.some((fact) => !fact.hidden && isFieldFact(fact))
}

/** `text` flattened and cut to `max` characters with an ellipsis. */
export function clipTodo(text: string, max: number): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`
}

/**
 * The sentence of `text` around `[from, to)`, trimmed, as a passage to select: from the end of the
 * previous sentence (., !, ?, or a line break) to the end of this one. A sentence longer than
 * `TODO_QUOTE_MAX` is cut to a window around the range, on word boundaries where it can be. The
 * answer is always a substring of `text`, so the editor finds it verbatim.
 */
export function sentenceAround(text: string, from: number, to: number = from): string {
  const start = Math.max(0, Math.min(from, text.length))
  const end = Math.max(start, Math.min(to, text.length))
  let left = start
  while (left > 0 && !/[.!?\n]/u.test(text[left - 1] ?? '')) left -= 1
  let right = end
  while (right < text.length && !/[.!?\n]/u.test(text[right] ?? '')) right += 1
  while (right < text.length && /[.!?"'”’)\]]/u.test(text[right] ?? '')) right += 1
  let sentence = text.slice(left, right)
  let offset = left
  if (sentence.length > TODO_QUOTE_MAX) {
    const half = Math.floor((TODO_QUOTE_MAX - (end - start)) / 2)
    let windowStart = Math.max(left, start - Math.max(0, half))
    let windowEnd = Math.min(right, windowStart + TODO_QUOTE_MAX)
    const space = text.indexOf(' ', windowStart)
    if (windowStart > left && space !== -1 && space < start) windowStart = space + 1
    const back = text.lastIndexOf(' ', windowEnd)
    if (windowEnd < right && back > end) windowEnd = back
    sentence = text.slice(windowStart, windowEnd)
    offset = windowStart
  }
  const lead = sentence.length - sentence.trimStart().length
  return text.slice(offset + lead, offset + sentence.trimEnd().length)
}

/** How many open items each kind holds. */
export const TodoCounts = z.object({
  undefined: z.number().int().nonnegative(),
  contradiction: z.number().int().nonnegative(),
  looseEnd: z.number().int().nonnegative(),
  gap: z.number().int().nonnegative()
})
export type TodoCounts = z.infer<typeof TodoCounts>

/** What `todo:list` answers: the open items, grouped by kind in `TODO_KINDS` order. */
export const TodoView = z.object({
  items: z.array(TodoItem),
  counts: TodoCounts
})
export type TodoView = z.infer<typeof TodoView>

/** The counts of a list of items. */
export function todoCounts(items: readonly Pick<TodoItem, 'kind'>[]): TodoCounts {
  const counts: TodoCounts = { undefined: 0, contradiction: 0, looseEnd: 0, gap: 0 }
  for (const item of items) counts[item.kind] += 1
  return counts
}

/** Quiet after the last change of the knowledge before the local To do sync runs. */
export const TODO_DEBOUNCE_MS = 5_000
