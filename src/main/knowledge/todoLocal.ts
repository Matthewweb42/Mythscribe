import { categoryFieldLabel, categoryOf, type StoryCategory } from '@shared/categories'
import { PROJECT_NOTES_NAME } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import { toEntityNameKey } from '@shared/entities'
import type { Fact } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import { passageParagraphs, type MentionRange, type TagMentions } from '@shared/mentions'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { SUMMARY_TEXT_MIN } from '@shared/summary'
import { THREAD_KIND } from '@shared/threads'
import {
  TODO_EMPTY_RECORD_SCENES,
  TODO_LIMITS_SCENES,
  TODO_LOCAL_MAX,
  TODO_POV_SCENES,
  TODO_RULE_KIND,
  TODO_RULE_MAX,
  TODO_SUBJECT_MAX,
  TODO_SUGGESTION_MAX,
  TODO_WHY_MAX,
  clipTodo,
  factConflicts,
  isEmptyRecord,
  recentWindow,
  sentenceAround,
  staleThreads,
  todoKey,
  vanishedRecords,
  type TodoKind,
  type TodoRule,
  type TodoTarget
} from '@shared/todo'
import type { NodeRow } from '../db/schema'
import { findingFieldKey, findingFieldKeys } from '../ai/continuityFindingStore'
import { summariesFor } from '../document/summaryStore'
import { listCategories } from '../entity/categoryStore'
import { listEntities } from '../entity/entityStore'
import { factsForEntities } from '../entity/factStore'
import { listAllMentions } from '../tag/mentionStore'
import { listProposedTags } from '../tag/proposedTags'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { documentJson, manuscriptDocuments } from '../voice/profile'
import { listThreads } from './threads'

/**
 * The To do list's local rules (F-9.16): everything the book shows by itself, with no AI and no
 * cost. Reads the stored knowledge (the mention index, the dated facts, the threads, the proposed
 * names, the scene metadata and cards) and answers candidates; `syncLocalTodo` writes them. Never
 * writes anything itself, least of all a scene.
 */

/** One item a local rule found, before it is stored. */
export interface TodoCandidate {
  key: string
  kind: TodoKind
  rule: TodoRule
  subject: string
  entityId: string | null
  nodeId: string | null
  quote: string | null
  why: string
  target: TodoTarget
  /** Options the rule can offer for free (the two stated values of a conflict); usually none. */
  suggestions: string[]
  /** How much the book leans on it (mentions, scenes): the ranking for the caps. */
  rank: number
}

/** The fields a "limits" gap looks at, in the order a target is picked. */
const LIMIT_FIELDS = ['costs', 'limits', 'rules'] as const
/** The categories whose records should state their limits. */
const LIMIT_KINDS = ['magic', 'technology', 'world'] as const
/** Contradictions rank above everything a mention count can reach. */
const CONTRADICTION_RANK = 1_000_000

/** The book as the rules read it: the written scenes in reading order and their documents. */
export interface Book {
  rows: NodeRow[]
  /** Manuscript documents with at least `SUMMARY_TEXT_MIN` characters, not marked idea. */
  written: NodeRow[]
  order: string[]
  titleOf: (nodeId: string) => string
  paragraphsOf: (nodeId: string) => ReturnType<typeof passageParagraphs>
}

export function readBook(db: TreeDb): Book {
  const rows = listNodes(db)
  const docs = manuscriptDocuments(db, rows)
  const json = new Map(docs.map((row) => [row.id, documentJson(row)]))
  const written = docs.filter((row) => {
    if (parseStoredSceneMeta(row.sceneMeta).status === 'idea') return false
    const doc = json.get(row.id)
    return doc !== null && doc !== undefined && docToText(doc).length >= SUMMARY_TEXT_MIN
  })
  const titles = new Map(rows.map((row) => [row.id, row.title]))
  const paragraphs = new Map<string, ReturnType<typeof passageParagraphs>>()
  return {
    rows,
    written,
    order: written.map((row) => row.id),
    titleOf: (nodeId) => titles.get(nodeId) ?? 'a scene',
    paragraphsOf: (nodeId) => {
      const held = paragraphs.get(nodeId)
      if (held !== undefined) return held
      const doc = json.get(nodeId)
      const found = doc === null || doc === undefined ? [] : passageParagraphs(doc)
      paragraphs.set(nodeId, found)
      return found
    }
  }
}

/** The sentence a mention range sits in; null when the range is outside every paragraph. */
function mentionQuote(book: Book, nodeId: string, range: MentionRange | undefined): string | null {
  if (range === undefined) return null
  const [from, to] = range
  const paragraph = book.paragraphsOf(nodeId).find((each) => each.from <= from && from < each.to)
  if (paragraph === undefined) return null
  const quote = sentenceAround(paragraph.text, from - paragraph.from, to - paragraph.from)
  return quote === '' ? null : quote
}

/** The sentence a word first appears in, in one scene; null when it is not there as a word. */
function wordQuote(book: Book, nodeId: string, word: string): string | null {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'u')
  for (const paragraph of book.paragraphsOf(nodeId)) {
    const hit = pattern.exec(paragraph.text)
    if (hit === null) continue
    const quote = sentenceAround(paragraph.text, hit.index, hit.index + hit[0].length)
    return quote === '' ? null : quote
  }
  return null
}

/** One record's mentions in the written scenes, in reading order. */
export interface RecordMentionList {
  entity: Entity
  mentions: TagMentions[]
  total: number
}

export function mentionsByRecord(
  db: TreeDb,
  book: Book,
  entities: readonly Entity[]
): Map<string, RecordMentionList> {
  const index = new Map(book.order.map((id, at) => [id, at]))
  const byTag = new Map<string, TagMentions[]>()
  for (const mention of listAllMentions(db)) {
    if (!index.has(mention.nodeId)) continue
    byTag.set(mention.tagId, [...(byTag.get(mention.tagId) ?? []), mention])
  }
  const out = new Map<string, RecordMentionList>()
  for (const entity of entities) {
    if (entity.tagId === null) continue
    const mentions = (byTag.get(entity.tagId) ?? []).sort(
      (a, b) => (index.get(a.nodeId) ?? 0) - (index.get(b.nodeId) ?? 0)
    )
    if (mentions.length === 0) continue
    out.set(entity.id, {
      entity,
      mentions,
      total: mentions.reduce((sum, mention) => sum + mention.count, 0)
    })
  }
  return out
}

const filled = (entity: Entity, field: string): boolean =>
  (entity.fields[field] ?? '').trim() !== ''

/** The field a record's "what is it?" line goes into. */
export function describeField(category: StoryCategory): string | null {
  const ids = category.fields.map((field) => field.id)
  if (ids.includes('description')) return 'description'
  if (ids.includes('background')) return 'background'
  const multiline = category.fields.find((field) => field.multiline && field.id !== 'notes')
  if (multiline !== undefined) return multiline.id
  return ids.includes('notes') ? 'notes' : null
}

function fieldTarget(category: StoryCategory, entityId: string, field: string): TodoTarget {
  return category.fields.some((each) => each.id === field)
    ? { kind: 'field', entityId, field }
    : { kind: 'none' }
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

function candidate(
  rule: TodoRule,
  parts: readonly string[],
  fields: Omit<TodoCandidate, 'key' | 'kind' | 'rule'>
): TodoCandidate {
  return {
    ...fields,
    key: todoKey(rule, ...parts),
    kind: TODO_RULE_KIND[rule],
    rule,
    subject: clipTodo(fields.subject, TODO_SUBJECT_MAX),
    why: clipTodo(fields.why, TODO_WHY_MAX),
    suggestions: fields.suggestions.map((each) => clipTodo(each, TODO_SUGGESTION_MAX))
  }
}

/**
 * Every item the local rules find now, capped at `TODO_RULE_MAX` per rule and `TODO_LOCAL_MAX` in
 * all, ranked by how much the book leans on each. Records whose status is plan or idea, plan and
 * idea facts, and scenes marked idea are ignored (F-9.13: only canon decides). Keys in `settled`
 * do not count toward the caps (`capCandidates`).
 */
export function localTodoCandidates(
  db: TreeDb,
  settled: ReadonlySet<string> = new Set()
): TodoCandidate[] {
  const book = readBook(db)
  const categories = listCategories(db)
  const entities = listEntities(db).filter((entity) => entity.status === 'canon')
  const byId = new Map(entities.map((entity) => [entity.id, entity]))
  const facts = factsForEntities(
    db,
    entities.map((entity) => entity.id)
  )
  const factsOf = new Map<string, Fact[]>()
  for (const fact of facts)
    factsOf.set(fact.entityId, [...(factsOf.get(fact.entityId) ?? []), fact])
  const stated = (entityId: string, attribute: string): boolean =>
    (factsOf.get(entityId) ?? []).some(
      (fact) => fact.attribute === attribute && fact.status === 'canon'
    )
  const mentions = mentionsByRecord(db, book, entities)
  const window = recentWindow(book.order.length)
  const out: TodoCandidate[] = []

  // Undefined: a record the book keeps naming that nothing explains.
  const notes = book.rows
    .map((row) => {
      const doc = documentJson({ content: row.notes })
      return doc === null ? '' : docToText(doc)
    })
    .join('\n')
    .toLocaleLowerCase()
  const projectNotes = toEntityNameKey(PROJECT_NOTES_NAME)
  for (const { entity, mentions: list, total } of mentions.values()) {
    if (entity.kind === THREAD_KIND) continue
    if (entity.kind === 'world' && toEntityNameKey(entity.name) === projectNotes) continue
    if (list.length < TODO_EMPTY_RECORD_SCENES) continue
    if (!isEmptyRecord(entity, factsOf.get(entity.id) ?? [])) continue
    const names = [entity.name, ...entity.aliases].map((name) => name.toLocaleLowerCase())
    if (names.some((name) => name.trim() !== '' && notes.includes(name))) continue
    const first = list[0]
    if (first === undefined) continue
    const category = categoryOf(entity.kind, categories)
    const field = describeField(category)
    out.push(
      candidate('emptyRecord', [entity.id], {
        subject: entity.name,
        entityId: entity.id,
        nodeId: first.nodeId,
        quote: mentionQuote(book, first.nodeId, first.ranges[0]),
        why: `Named in ${plural(list.length, 'scene')}, but its sheet is empty and your notes do not explain it.`,
        target:
          entity.template === 'blank' || field === null
            ? { kind: 'page', entityId: entity.id }
            : { kind: 'field', entityId: entity.id, field },
        suggestions: [],
        rank: total
      })
    )
  }

  // Undefined: a name the book keeps using that no tag or record stands for (F-4.12b's proposals).
  for (const proposal of listProposedTags(db)) {
    const nodeId = proposal.nodeIds[0] ?? null
    out.push(
      candidate('unknownName', [proposal.name], {
        subject: proposal.display,
        entityId: null,
        nodeId,
        quote: nodeId === null ? null : wordQuote(book, nodeId, proposal.display),
        why: `Used ${plural(proposal.count, 'time')}, but no tag or record says who or what it is.`,
        target: { kind: 'newRecord', category: 'character', name: proposal.display },
        suggestions: [],
        rank: proposal.count
      })
    )
  }

  // Contradictions the dated facts show by themselves, unless the consistency checker has one
  // (open, or dismissed: "Not a problem" there holds here too).
  const checked = findingFieldKeys(db)
  for (const conflict of factConflicts(facts, book.order)) {
    if (checked.has(findingFieldKey(conflict.entityId, conflict.attribute, conflict.nodeId)))
      continue
    const entity = byId.get(conflict.entityId)
    if (entity === undefined) continue
    const category = categoryOf(entity.kind, categories)
    const label = categoryFieldLabel(category, conflict.attribute)
    const [earlier, later] = conflict.values
    out.push(
      candidate('factConflict', [conflict.nodeId, conflict.entityId, conflict.attribute], {
        subject: `${entity.name} · ${label}`,
        entityId: entity.id,
        nodeId: conflict.nodeId,
        quote: conflict.quote,
        why:
          conflict.reason === 'sameScene'
            ? `This scene states two values for ${entity.name}'s ${label.toLocaleLowerCase()}: "${earlier}" and "${later}".`
            : `${entity.name}'s ${label.toLocaleLowerCase()} is "${later}" here, but "${earlier}" in an earlier scene.`,
        target: fieldTarget(category, entity.id, conflict.attribute),
        suggestions: [earlier, later],
        rank: CONTRADICTION_RANK
      })
    )
  }

  // Loose ends: open threads nothing has moved lately.
  for (const thread of staleThreads(listThreads(db), book.order)) {
    const entity = byId.get(thread.entityId)
    if (entity === undefined) continue
    const setup = thread.setup
    const question = thread.question.trim()
    out.push(
      candidate('openThread', [thread.entityId], {
        subject: thread.name,
        entityId: thread.entityId,
        nodeId: setup?.nodeId ?? null,
        quote: setup?.quote ?? null,
        why:
          `Still open, and not moved in the last ${plural(window, 'scene')}.` +
          (question === '' ? '' : ` Open question: ${question}`),
        target: fieldTarget(categoryOf(entity.kind, categories), entity.id, 'payoff'),
        suggestions: [],
        rank: thread.events.length
      })
    )
  }

  // Loose ends: characters the book stopped mentioning.
  const characters = [...mentions.values()].filter(({ entity }) => entity.kind === 'character')
  const lastScene = book.order[book.order.length - 1]
  for (const gone of vanishedRecords(
    characters.map(({ entity, mentions: list }) => ({
      entityId: entity.id,
      nodeIds: list.map((mention) => mention.nodeId)
    })),
    book.order
  )) {
    const record = mentions.get(gone.entityId)
    if (record === undefined || lastScene === undefined) continue
    const last = record.mentions.find((mention) => mention.nodeId === gone.lastNodeId)
    out.push(
      candidate('vanished', [gone.entityId], {
        subject: record.entity.name,
        entityId: gone.entityId,
        nodeId: gone.lastNodeId,
        quote: mentionQuote(book, gone.lastNodeId, last?.ranges[last.ranges.length - 1]),
        why: `In ${plural(gone.scenes, 'scene')}, last in ${book.titleOf(gone.lastNodeId)}, then not in the last ${plural(window, 'scene')}.`,
        target: { kind: 'notes', nodeId: lastScene },
        suggestions: [],
        rank: gone.scenes
      })
    )
  }

  // Gaps: a system of the world whose limits are never stated.
  for (const { entity, mentions: list, total } of mentions.values()) {
    if (!(LIMIT_KINDS as readonly string[]).includes(entity.kind)) continue
    if (list.length < TODO_LIMITS_SCENES) continue
    const category = categoryOf(entity.kind, categories)
    const fields = LIMIT_FIELDS.filter((field) => category.fields.some((each) => each.id === field))
    const field = fields[0]
    if (field === undefined) continue
    if (fields.some((each) => filled(entity, each) || stated(entity.id, each))) continue
    const first = list[0]
    if (first === undefined) continue
    const labels = fields.map((each) => categoryFieldLabel(category, each).toLocaleLowerCase())
    out.push(
      candidate('noLimits', [entity.id], {
        subject: entity.name,
        entityId: entity.id,
        nodeId: first.nodeId,
        quote: mentionQuote(book, first.nodeId, first.ranges[0]),
        why: `Named in ${plural(list.length, 'scene')}, but its ${labels.join(' and ')} are not stated anywhere.`,
        target: { kind: 'field', entityId: entity.id, field },
        suggestions: [],
        rank: total
      })
    )
  }

  // Gaps: a point-of-view character with no stated goal.
  const cards = summariesFor(db, book.order)
  const povScenes = new Map<string, string[]>()
  for (const row of book.written) {
    const pov =
      parseStoredSceneMeta(row.sceneMeta).pov.trim() || (cards.get(row.id)?.card?.pov ?? '').trim()
    if (pov === '') continue
    const key = toEntityNameKey(pov)
    povScenes.set(key, [...(povScenes.get(key) ?? []), row.id])
  }
  for (const entity of entities) {
    if (entity.kind !== 'character') continue
    const keys = [entity.name, ...entity.aliases].map(toEntityNameKey)
    const scenes = [...new Set(keys.flatMap((key) => povScenes.get(key) ?? []))]
    if (scenes.length < TODO_POV_SCENES) continue
    const category = categoryOf(entity.kind, categories)
    if (!category.fields.some((field) => field.id === 'goals')) continue
    if (filled(entity, 'goals') || stated(entity.id, 'goals')) continue
    const firstScene = book.order.find((id) => scenes.includes(id)) ?? null
    out.push(
      candidate('noGoal', [entity.id], {
        subject: entity.name,
        entityId: entity.id,
        nodeId: firstScene,
        quote: null,
        why: `${plural(scenes.length, 'scene')} are told from ${entity.name}'s point of view, but no goal is stated.`,
        target: { kind: 'field', entityId: entity.id, field: 'goals' },
        suggestions: [],
        rank: scenes.length
      })
    )
  }

  return capCandidates(out, settled)
}

/**
 * At most `TODO_RULE_MAX` per rule and `TODO_LOCAL_MAX` in all, the highest ranked first. Keys in
 * `settled` (items the author already marked done or dismissed) are dropped before the caps, so
 * the caps count open items only and the next item of a rule shows once the first are settled.
 */
export function capCandidates(
  candidates: readonly TodoCandidate[],
  settled: ReadonlySet<string> = new Set()
): TodoCandidate[] {
  const ranked = candidates
    .map((each, input) => ({ each, input }))
    .sort((a, b) => b.each.rank - a.each.rank || a.input - b.input)
    .map(({ each }) => each)
  const perRule = new Map<TodoRule, number>()
  const seen = new Set<string>()
  const kept: TodoCandidate[] = []
  for (const each of ranked) {
    if (seen.has(each.key) || settled.has(each.key)) continue
    const count = perRule.get(each.rule) ?? 0
    if (count >= TODO_RULE_MAX) continue
    perRule.set(each.rule, count + 1)
    seen.add(each.key)
    kept.push(each)
    if (kept.length >= TODO_LOCAL_MAX) break
  }
  return kept
}
