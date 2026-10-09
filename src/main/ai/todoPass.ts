import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { FEATURE_INPUT_BUDGETS, estimateTokens } from '@shared/ai'
import { AI_COST_NOTES } from '@shared/aiCostNotes'
import { categoryFieldLabel, categoryOf, type StoryCategory } from '@shared/categories'
import { PROJECT_NOTES_NAME } from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import { toEntityNameKey } from '@shared/entities'
import type { Entity } from '@shared/ipc/contract'
import { parseStoredSceneMeta } from '@shared/sceneMeta'
import { THREAD_KIND } from '@shared/threads'
import {
  TODO_AI_ITEMS_MAX,
  TODO_AI_RESOLVED_MAX,
  TODO_AI_RULE,
  TODO_AI_TYPES,
  TODO_AI_WHY_MAX,
  TODO_DIGEST_MAX,
  TODO_KIND_NOUN,
  TODO_PASS_CHUNKS_MAX,
  TODO_RULE_KIND,
  TODO_SCENE_LINE_MAX,
  TODO_SETTLED_LISTED_MAX,
  TODO_SUBJECT_MAX,
  TODO_SUGGESTIONS_MAX,
  TODO_SUGGESTION_MAX,
  TODO_SUGGEST_PASSAGES_MAX,
  TODO_SUGGEST_PASSAGE_MAX,
  TODO_SUGGEST_RECORD_MAX,
  clipTodo,
  continuityFindingIdOf,
  foldTodoName,
  parseTodoSuggestions,
  parseTodoTarget,
  sentenceAround,
  todoKey,
  type TodoAiType,
  type TodoCheck,
  type TodoKind,
  type TodoRule,
  type TodoTarget
} from '@shared/todo'
import { todoItem, type TodoItemRow } from '../db/schema'
import { listCategories } from '../entity/categoryStore'
import { listEntities } from '../entity/entityStore'
import { AppError } from '../ipc/errors'
import { estimateCost, type ConversionContext } from '../knowledge/conversion'
import { sceneCardFor } from '../knowledge/sceneCard'
import { listThreads } from '../knowledge/threads'
import { describeField, mentionsByRecord, readBook, type Book } from '../knowledge/todoLocal'
import { listTodo, todoTargetLabel } from '../knowledge/todoStore'
import { getAiSettings, getTodoPassState, setTodoPassState } from '../project/settingsStore'
import { searchPassages } from '../search/passageIndex'
import type { TreeDb } from '../tree/treeStore'
import { documentJson } from '../voice/profile'
import { assertFeatureAllowed } from './dial'
import { buildTodoPrompt, type BuiltTodoPrompt } from './prompts/todo.v1'
import { buildTodoSuggestPrompt } from './prompts/todoSuggest.v1'
import { AiFallbackError } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * The To do list's AI part (F-9.16): the whole-book check (`todo.v1`) and an item's suggestions
 * (`todoSuggest.v1`), both on the fast tier as JSON, costed in the ledger as `todo`. The check runs
 * only when the author clicks Check the whole book (the author's call, 2026-10-09: never on its
 * own); the suggestions are asked once per item when its card is first shown. Both are derived
 * data like the continuity findings (CLAUDE.md, AI rule 1): they are written to `todo_item` only,
 * flag a gap, and offer options the author may choose; they never fill a gap and never touch a
 * scene ("no assuming", 2026-10-08).
 */

/** Open threads the check lists, at most, each line within `THREAD_LINE_MAX` characters. */
const THREADS_MAX = 40
const THREAD_LINE_MAX = 160
/** Open items the check lists as "already listed", at most. */
const LISTED_MAX = 60
/** What a target holds now, as the suggestion request sends it. */
const CURRENT_MAX = 300

/** One written scene as the check sends it: its label (`S12`, by reading position) and line. */
export interface TodoSceneLine {
  label: string
  nodeId: string
  line: string
}

/** Everything one check sends, before it is cut into requests. */
export interface TodoPassInput {
  digest: string[]
  threads: string[]
  scenes: TodoSceneLine[]
  /** The open items' lines; the AI's own carry an id (`A1`) the answer may resolve. */
  listed: string[]
  /** `A1` (lower-cased) → the row id. */
  listedIds: Map<string, string>
  settled: string[]
}

const blank = (entity: Entity, field: string): boolean => (entity.fields[field] ?? '').trim() === ''

/** `Mara (character): blank goals, fears`; `empty` when nothing is filled; no value is ever sent. */
function digestLine(entity: Entity, category: StoryCategory): string {
  const fields = category.fields.filter((field) => field.id !== 'notes')
  const blanks = fields.filter((field) => blank(entity, field.id))
  const head = `${entity.name} (${category.noun})`
  if (fields.length > 0 && blanks.length === fields.length && (entity.body ?? '').trim() === '') {
    return `${head}: empty`
  }
  if (blanks.length === 0) return head
  return `${head}: blank ${blanks.map((field) => field.label.toLocaleLowerCase()).join(', ')}`
}

/** The lines kept, in order, while their joined length stays within `max`. */
function within(lines: readonly string[], max: number): string[] {
  const kept: string[] = []
  let length = 0
  for (const line of lines) {
    const next = length + line.length + (kept.length === 0 ? 0 : 1)
    if (next > max) break
    kept.push(line)
    length = next
  }
  return kept
}

/**
 * What a check would send now: the sheet digest (records the text names, most mentioned first;
 * names and which fields are blank, never their values), the open threads with their questions,
 * one line per written scene that has a card (title, when, POV, what changed), the open items,
 * and the subjects already settled (newest first).
 */
export function buildTodoInput(db: TreeDb): TodoPassInput {
  const book = readBook(db)
  const categories = listCategories(db)
  const entities = listEntities(db)
  const projectNotes = toEntityNameKey(PROJECT_NOTES_NAME)
  const digest = within(
    [...mentionsByRecord(db, book, entities).values()]
      .filter(
        ({ entity }) =>
          entity.kind !== THREAD_KIND &&
          !(entity.kind === 'world' && toEntityNameKey(entity.name) === projectNotes)
      )
      .sort((a, b) => b.total - a.total)
      .map(({ entity }) => clipTodo(digestLine(entity, categoryOf(entity.kind, categories)), 240)),
    TODO_DIGEST_MAX
  )

  const threads = listThreads(db)
    .filter((thread) => thread.status === 'open')
    .slice(0, THREADS_MAX)
    .map((thread) =>
      clipTodo(
        thread.question.trim() === '' ? thread.name : `${thread.name}: ${thread.question}`,
        THREAD_LINE_MAX
      )
    )

  const scenes: TodoSceneLine[] = []
  book.written.forEach((row, index) => {
    const card = sceneCardFor(db, row.id)
    if (card === null) return
    const label = `S${index + 1}`
    const parts = [
      `${label} "${clipTodo(row.title, 60)}"`,
      card.when?.value ?? '',
      card.pov === null ? '' : `POV ${card.pov.value}`,
      card.changed
    ].filter((part) => part.trim() !== '')
    scenes.push({ label, nodeId: row.id, line: clipTodo(parts.join(' · '), TODO_SCENE_LINE_MAX) })
  })

  const listedIds = new Map<string, string>()
  const listed: string[] = []
  for (const item of listTodo(db).items.slice(0, LISTED_MAX)) {
    if (item.source === 'ai' && continuityFindingIdOf(item.id) === null) {
      const id = `A${listedIds.size + 1}`
      listedIds.set(id.toLowerCase(), item.id)
      listed.push(`${id} ${item.rule}: ${item.subject}`)
    } else {
      listed.push(`${item.rule}: ${item.subject}`)
    }
  }

  const settled = db
    .select({ rule: todoItem.rule, subject: todoItem.subject })
    .from(todoItem)
    .where(ne(todoItem.status, 'open'))
    .orderBy(desc(todoItem.updatedAt))
    .limit(TODO_SETTLED_LISTED_MAX)
    .all()
    .map((row) => `${row.rule}: ${row.subject}`)

  return { digest, threads, scenes, listed, listedIds, settled }
}

/** One request of a check: its prompt and the scenes it holds. */
export interface TodoChunk {
  prompt: BuiltTodoPrompt
  scenes: TodoSceneLine[]
}

/**
 * The check cut into requests (CLAUDE.md, token rules 2 and 8): consecutive windows of the scene
 * lines, each with the full digest, threads, and lists, each within `FEATURE_INPUT_BUDGETS.todo`
 * estimated tokens, at most `TODO_PASS_CHUNKS_MAX`. Windows fill from the newest scene back, so a
 * book too long for every window loses its earliest scene lines first. None without a scene line.
 */
export function todoChunks(input: TodoPassInput): TodoChunk[] {
  if (input.scenes.length === 0) return []
  const build = (scenes: readonly TodoSceneLine[]): BuiltTodoPrompt =>
    buildTodoPrompt({
      digest: input.digest,
      threads: input.threads,
      scenes: scenes.map((scene) => scene.line),
      listed: input.listed,
      settled: input.settled
    })
  const tokens = (prompt: BuiltTodoPrompt): number =>
    estimateTokens(prompt.messages.map((message) => message.content).join('\n'))
  const budget = FEATURE_INPUT_BUDGETS.todo ?? 10_000
  const room = Math.max(1, budget - tokens(build([])))
  const windows: TodoSceneLine[][] = []
  let current: TodoSceneLine[] = []
  let used = 0
  for (let at = input.scenes.length - 1; at >= 0; at--) {
    const scene = input.scenes[at]
    if (scene === undefined) continue
    const cost = estimateTokens(scene.line) + 1
    if (current.length > 0 && used + cost > room) {
      windows.push(current)
      if (windows.length >= TODO_PASS_CHUNKS_MAX) {
        current = []
        break
      }
      current = []
      used = 0
    }
    current.push(scene)
    used += cost
  }
  if (current.length > 0) windows.push(current)
  return windows.reverse().map((window) => {
    const scenes = [...window].reverse()
    return { prompt: build(scenes), scenes }
  })
}

/**
 * The hash a check is remembered by: the book part of every request (the digest, the threads, and
 * the scene lines), not the lists of items, which move with every Done and Dismiss. An unchanged
 * book sends nothing.
 */
export function todoBookHash(chunks: readonly TodoChunk[]): string {
  return sha256(JSON.stringify(chunks.map((chunk) => chunk.prompt.messages[1]?.content ?? '')))
}

/** One item the check flagged, ready to store. */
export interface ParsedTodoItem {
  key: string
  kind: TodoKind
  rule: TodoRule
  subject: string
  entityId: string | null
  nodeId: string
  quote: string | null
  why: string
  target: TodoTarget
  suggestions: string[]
}

/** What the parser checks an answer against. */
export interface TodoAnswerContext {
  /** `s12` (lower-cased) → the scene's id, for the labels that were sent. */
  scenes: ReadonlyMap<string, string>
  /** `a1` (lower-cased) → an open AI item's id, for the ids that were sent. */
  listed: ReadonlyMap<string, string>
  /** Every key of the To do table, any status: never flagged again. */
  keys: ReadonlySet<string>
  entities: readonly Entity[]
  categories: readonly StoryCategory[]
  /** The sentence of the scene that names `about`; null when the text does not. */
  quoteOf: (nodeId: string, about: string) => string | null
}

const isAiType = (value: unknown): value is TodoAiType =>
  typeof value === 'string' && (TODO_AI_TYPES as readonly string[]).includes(value)

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

function recordNamed(entities: readonly Entity[], name: string): Entity | undefined {
  const key = toEntityNameKey(name)
  return entities.find(
    (entity) =>
      entity.kind !== THREAD_KIND &&
      [entity.name, ...entity.aliases].some((each) => toEntityNameKey(each) === key)
  )
}

const hasField = (category: StoryCategory, id: string): boolean =>
  category.fields.some((field) => field.id === id)

/**
 * Where an AI item's line goes: a term's record (its description, or its page) or a new world
 * sheet; a rule's record's Rules field; a motivation's character's Goals; else the scene's notes.
 * Null when the place is already filled: the sheet answers it, so it is no gap.
 */
function aiTarget(
  type: TodoAiType,
  about: string,
  nodeId: string,
  context: Pick<TodoAnswerContext, 'entities' | 'categories'>
): { target: TodoTarget; entityId: string | null } | null {
  const notes: TodoTarget = { kind: 'notes', nodeId }
  const entity = recordNamed(context.entities, about)
  const category = entity === undefined ? null : categoryOf(entity.kind, context.categories)
  const field = (id: string): { target: TodoTarget; entityId: string | null } | null => {
    if (entity === undefined || category === null || !hasField(category, id)) {
      return { target: notes, entityId: entity?.id ?? null }
    }
    if (!blank(entity, id)) return null
    return { target: { kind: 'field', entityId: entity.id, field: id }, entityId: entity.id }
  }
  switch (type) {
    case 'term': {
      if (entity === undefined || category === null) {
        return {
          target: { kind: 'newRecord', category: 'world', name: clipTodo(about, TODO_SUBJECT_MAX) },
          entityId: null
        }
      }
      const describe = describeField(category)
      if (entity.template === 'blank' || describe === null) {
        if ((entity.body ?? '').trim() !== '') return null
        return { target: { kind: 'page', entityId: entity.id }, entityId: entity.id }
      }
      return field(describe)
    }
    case 'rule':
      return field('rules')
    case 'motivation':
      return field('goals')
    case 'timeline':
    case 'question':
      return { target: notes, entityId: entity?.id ?? null }
  }
}

/**
 * The model's `{ items, resolved }` against what was sent: PROVIDER (a fallback error) when it is
 * not JSON or has no `items` array; lenient item by item otherwise. An item of an unknown type,
 * with no name, naming a scene that was not sent, whose key the table already holds (in any
 * status), or whose target the sheet already fills is dropped; at most `TODO_AI_ITEMS_MAX` items
 * and `TODO_AI_RESOLVED_MAX` resolved ids (only ids that were sent) are kept.
 */
export function parseTodoAnswer(
  answer: string,
  context: TodoAnswerContext
): { items: ParsedTodoItem[]; resolved: string[] } {
  let json: unknown
  try {
    json = JSON.parse(answer)
  } catch (err) {
    throw new AiFallbackError('The model did not answer in the expected format.', err)
  }
  if (typeof json !== 'object' || json === null) {
    throw new AiFallbackError('The model did not answer in the expected format.')
  }
  const body = json as { items?: unknown; resolved?: unknown }
  if (!Array.isArray(body.items)) {
    throw new AiFallbackError('The model did not answer in the expected format.')
  }
  const items: ParsedTodoItem[] = []
  const seen = new Set(context.keys)
  for (const raw of body.items) {
    if (items.length >= TODO_AI_ITEMS_MAX) break
    if (typeof raw !== 'object' || raw === null) continue
    const entry = raw as Record<string, unknown>
    if (!isAiType(entry.type)) continue
    const about = clipTodo(text(entry.about), TODO_SUBJECT_MAX)
    const nodeId = context.scenes.get(text(entry.scene).toLowerCase())
    if (about === '' || nodeId === undefined) continue
    const rule = TODO_AI_RULE[entry.type]
    const key = todoKey(rule, foldTodoName(about))
    if (seen.has(key)) continue
    const placed = aiTarget(entry.type, about, nodeId, context)
    if (placed === null) continue
    const suggestions = (Array.isArray(entry.suggestions) ? entry.suggestions : [])
      .map((each) => clipTodo(text(each), TODO_SUGGESTION_MAX))
      .filter((each) => each !== '')
      .slice(0, TODO_SUGGESTIONS_MAX)
    seen.add(key)
    items.push({
      key,
      kind: TODO_RULE_KIND[rule],
      rule,
      subject: about,
      entityId: placed.entityId,
      nodeId,
      quote: context.quoteOf(nodeId, about),
      why: clipTodo(text(entry.why), TODO_AI_WHY_MAX) || 'The check found this left open.',
      target: placed.target,
      suggestions
    })
  }
  const resolved = (Array.isArray(body.resolved) ? body.resolved : [])
    .map((each) => context.listed.get(text(each).toLowerCase()))
    .filter((each): each is string => each !== undefined)
  return { items, resolved: [...new Set(resolved)].slice(0, TODO_AI_RESOLVED_MAX) }
}

/** The sentence of a scene that first names `about` (any case); null when it does not. */
export function locateQuote(book: Book, nodeId: string, about: string): string | null {
  const needle = about.toLocaleLowerCase()
  if (needle.trim() === '') return null
  for (const paragraph of book.paragraphsOf(nodeId)) {
    const at = paragraph.text.toLocaleLowerCase().indexOf(needle)
    if (at === -1) continue
    const quote = sentenceAround(paragraph.text, at, at + needle.length)
    return quote === '' ? null : quote
  }
  return null
}

/** What a check did. */
export interface TodoPassResult {
  requested: boolean
  /** Nothing was sent because the book is unchanged since the last check. */
  unchanged: boolean
  added: number
  resolved: number
  costUsd: number
}

/**
 * Check the whole book (F-9.16), only on the author's click: the gate (`todo`, Use AI and its
 * toggle), then one fast-tier JSON request per window (`todoChunks`, at most three). Nothing is
 * sent when the book has no scene card yet or is unchanged since the last check (`todoBookHash`).
 * Each answer is written as it comes: new open AI items (their suggestions with them), and the
 * open AI items the answer resolved deleted. Settled items are never touched or re-added. The
 * pass state remembers when, on what, and at what cost. Never writes a scene.
 */
export async function runTodoPass(
  db: TreeDb,
  deps: AiRequestDeps,
  input: { requestId?: string } = {}
): Promise<TodoPassResult> {
  assertFeatureAllowed(getAiSettings(db), 'todo')
  const built = buildTodoInput(db)
  const chunks = todoChunks(built)
  const none: TodoPassResult = {
    requested: false,
    unchanged: false,
    added: 0,
    resolved: 0,
    costUsd: 0
  }
  if (chunks.length === 0) return none
  const hash = todoBookHash(chunks)
  if (getTodoPassState(db).lastPassHash === hash) return { ...none, unchanged: true }

  const book = readBook(db)
  let added = 0
  let resolved = 0
  let costUsd = 0
  for (const [index, chunk] of chunks.entries()) {
    const result = await runAiRequest(deps, {
      feature: 'todo',
      tier: 'fast',
      messages: chunk.prompt.messages,
      maxTokens: chunk.prompt.maxTokens,
      json: true,
      contextHash: sha256(JSON.stringify(chunk.prompt.messages)),
      promptVersion: chunk.prompt.version,
      // One id per request: a second request under the same id is refused while the first is held.
      ...(input.requestId === undefined
        ? {}
        : { requestId: index === 0 ? input.requestId : `${input.requestId}:${index}` })
    })
    costUsd += result.costUsd
    const stored = storeTodoAnswer(db, result.text, chunk, built, book, deps.now())
    added += stored.added
    resolved += stored.resolved
  }
  setTodoPassState(db, {
    lastPassAt: deps.now().toISOString(),
    lastPassHash: hash,
    lastPassCostUsd: costUsd
  })
  return { requested: true, unchanged: false, added, resolved, costUsd }
}

/** Parses one answer against the table as it is now and writes it, in one transaction. */
function storeTodoAnswer(
  db: TreeDb,
  answer: string,
  chunk: TodoChunk,
  built: TodoPassInput,
  book: Book,
  now: Date
): { added: number; resolved: number } {
  const entities = listEntities(db)
  const categories = listCategories(db)
  return db.transaction((tx) => {
    const keys = new Set(
      tx
        .select({ key: todoItem.key })
        .from(todoItem)
        .all()
        .map((row) => row.key)
    )
    const parsed = parseTodoAnswer(answer, {
      scenes: new Map(chunk.scenes.map((scene) => [scene.label.toLowerCase(), scene.nodeId])),
      listed: built.listedIds,
      keys,
      entities,
      categories,
      quoteOf: (nodeId, about) => locateQuote(book, nodeId, about)
    })
    const at = now.toISOString()
    for (const item of parsed.items) {
      tx.insert(todoItem)
        .values({
          id: randomUUID(),
          key: item.key,
          kind: item.kind,
          rule: item.rule,
          source: 'ai',
          subject: item.subject,
          entityId: item.entityId,
          nodeId: item.nodeId,
          quote: item.quote,
          why: item.why,
          target: JSON.stringify(item.target),
          suggestions: JSON.stringify(item.suggestions),
          suggestedAt: item.suggestions.length > 0 ? at : null,
          status: 'open',
          createdAt: at,
          updatedAt: at
        })
        .run()
    }
    const gone =
      parsed.resolved.length === 0
        ? []
        : tx
            .delete(todoItem)
            .where(
              and(
                inArray(todoItem.id, parsed.resolved),
                eq(todoItem.status, 'open'),
                eq(todoItem.source, 'ai')
              )
            )
            .returning({ id: todoItem.id })
            .all()
    return { added: parsed.items.length, resolved: gone.length }
  })
}

/** What the check's header needs from outside the project: whether AI may run, and the price. */
export interface TodoCheckContext extends Pick<ConversionContext, 'source' | 'model' | 'pricing'> {
  /** Use AI on, the To do toggle on, and a provider set up. */
  allowed: boolean
}

/**
 * The check as the section's header shows it: may it run, when it last ran and at what cost, and
 * what a run would cost now on the configured model (input as it would be sent, output at the
 * cost note's typical size per request); `fresh` when the book is unchanged since the last check,
 * so a click sends nothing.
 */
export function todoCheckView(db: TreeDb, context: TodoCheckContext | null): TodoCheck {
  const state = getTodoPassState(db)
  const idle: TodoCheck = {
    allowed: false,
    lastAt: state.lastPassAt,
    lastCostUsd: state.lastPassCostUsd,
    estimateUsd: null,
    fresh: false
  }
  if (!context?.allowed) return idle
  const chunks = todoChunks(buildTodoInput(db))
  if (chunks.length === 0) return { ...idle, allowed: true }
  if (todoBookHash(chunks) === state.lastPassHash) return { ...idle, allowed: true, fresh: true }
  const tokensIn = chunks.reduce(
    (sum, chunk) =>
      sum + estimateTokens(chunk.prompt.messages.map((message) => message.content).join('\n')),
    0
  )
  const tokensOut = chunks.length * AI_COST_NOTES.todo.typicalOutTokens
  const { costUsd } = estimateCost(context, tokensIn, tokensOut)
  return { ...idle, allowed: true, estimateUsd: costUsd }
}

/** What a stored target holds now, as words; '' for nothing or a new record. */
function currentValue(
  book: Book,
  target: TodoTarget,
  entities: ReadonlyMap<string, Entity>
): string {
  switch (target.kind) {
    case 'field':
      return entities.get(target.entityId)?.fields[target.field] ?? ''
    case 'page':
      return entities.get(target.entityId)?.body ?? ''
    case 'notes':
    case 'brief': {
      const row = book.rows.find((each) => each.id === target.nodeId)
      if (row === undefined) return ''
      if (target.kind === 'brief') return parseStoredSceneMeta(row.sceneMeta).brief[target.field]
      const doc = documentJson({ content: row.notes })
      return doc === null ? '' : docToText(doc)
    }
    case 'newRecord':
    case 'none':
      return ''
  }
}

/** The record's filled fields as `Label: value` lines, cut to `TODO_SUGGEST_RECORD_MAX`. */
function recordText(entity: Entity | undefined, categories: readonly StoryCategory[]): string {
  if (entity === undefined) return ''
  const category = categoryOf(entity.kind, categories)
  const lines = Object.entries(entity.fields)
    .filter(([, value]) => (value ?? '').trim() !== '')
    .map(([id, value]) => `${categoryFieldLabel(category, id)}: ${(value ?? '').trim()}`)
  if ((entity.body ?? '').trim() !== '') lines.push(`Page: ${(entity.body ?? '').trim()}`)
  return lines.length === 0 ? '' : clipTodo(lines.join('; '), TODO_SUGGEST_RECORD_MAX)
}

/**
 * Up to `TODO_SUGGEST_PASSAGES_MAX` paragraphs that name the item, each cut to
 * `TODO_SUGGEST_PASSAGE_MAX`: the record's first, a middle, and its last mention in the written
 * scenes; else the passage index's best matches for the subject; else the item's own passage.
 */
function passagesFor(
  db: TreeDb,
  book: Book,
  row: TodoItemRow,
  entity: Entity | undefined
): string[] {
  const cut = (value: string): string => clipTodo(value, TODO_SUGGEST_PASSAGE_MAX)
  const found: string[] = []
  const push = (value: string | undefined): void => {
    if (value === undefined || value.trim() === '') return
    const clipped = cut(value)
    if (!found.includes(clipped) && found.length < TODO_SUGGEST_PASSAGES_MAX) found.push(clipped)
  }
  const mentions =
    entity === undefined ? undefined : mentionsByRecord(db, book, [entity]).get(entity.id)
  if (mentions !== undefined) {
    const list = mentions.mentions
    const picks = [list[0], list[Math.floor(list.length / 2)], list[list.length - 1]]
    for (const mention of picks) {
      if (mention === undefined) continue
      const from = mention.ranges[0]?.[0]
      const paragraph = book
        .paragraphsOf(mention.nodeId)
        .find((each) => from !== undefined && each.from <= from && from < each.to)
      push(paragraph?.text)
    }
  }
  if (found.length === 0) {
    for (const hit of searchPassages(db, row.subject, TODO_SUGGEST_PASSAGES_MAX)) {
      push(
        book.paragraphsOf(hit.nodeId).find((each) => each.index === hit.para)?.text ?? hit.snippet
      )
    }
  }
  if (found.length === 0) push(row.quote ?? undefined)
  return found
}

/**
 * The model's `{ suggestions }`: PROVIDER (a fallback error) when it is not JSON or holds no
 * usable option; otherwise up to `TODO_SUGGESTIONS_MAX` non-empty strings, each cut to
 * `TODO_SUGGESTION_MAX`, duplicates dropped.
 */
export function parseTodoSuggestAnswer(answer: string): string[] {
  let json: unknown
  try {
    json = JSON.parse(answer)
  } catch (err) {
    throw new AiFallbackError('The model did not answer in the expected format.', err)
  }
  const list =
    typeof json === 'object' &&
    json !== null &&
    Array.isArray((json as { suggestions?: unknown }).suggestions)
      ? (json as { suggestions: unknown[] }).suggestions
      : null
  if (list === null) throw new AiFallbackError('The model did not answer in the expected format.')
  const kept = [
    ...new Set(
      list.map((each) => clipTodo(text(each), TODO_SUGGESTION_MAX)).filter((each) => each !== '')
    )
  ].slice(0, TODO_SUGGESTIONS_MAX)
  if (kept.length === 0) throw new AiFallbackError('The model offered no suggestion.')
  return kept
}

/** What an item's suggestions request answered. */
export interface TodoSuggestOutcome {
  suggestions: string[]
  requested: boolean
  costUsd: number
}

/**
 * An item's suggestions (F-9.16), asked when its card is first shown: the stored ones when the
 * row has them (or came with them, or was asked before); otherwise the gate, then one fast-tier
 * JSON request with the item, where the line would go and what it holds, the record's fields, and
 * up to three passages, its answer stored on the row. VALIDATION for a contradiction of the
 * consistency checker (its fix is in the Continuity panel) or a settled item; NOT_FOUND for an
 * unknown one. Never writes anything but the row's suggestions.
 */
export async function suggestTodo(
  db: TreeDb,
  deps: AiRequestDeps,
  input: { id: string; requestId?: string }
): Promise<TodoSuggestOutcome> {
  if (continuityFindingIdOf(input.id) !== null) {
    throw new AppError('VALIDATION', 'A contradiction has its fix in the Continuity panel', {
      id: input.id
    })
  }
  const row = db.select().from(todoItem).where(eq(todoItem.id, input.id)).get()
  if (row === undefined)
    throw new AppError('NOT_FOUND', 'That To do item is gone', { id: input.id })
  if (row.status !== 'open') {
    throw new AppError('VALIDATION', 'That To do item is already settled', { id: input.id })
  }
  if (row.suggestedAt !== null) {
    return { suggestions: parseTodoSuggestions(row.suggestions), requested: false, costUsd: 0 }
  }
  assertFeatureAllowed(getAiSettings(db), 'todo')
  const categories = listCategories(db)
  const entities = new Map(listEntities(db).map((entity) => [entity.id, entity]))
  const target = parseTodoTarget(row.target)
  const entityId =
    target.kind === 'field' || target.kind === 'page' ? target.entityId : row.entityId
  const entity = entityId === null ? undefined : entities.get(entityId)
  const book = readBook(db)
  const prompt = buildTodoSuggestPrompt({
    kind: TODO_KIND_NOUN[row.kind],
    subject: row.subject,
    why: row.why,
    target: todoTargetLabel(target, {
      entities,
      titles: new Map(book.rows.map((each) => [each.id, each.title])),
      categories
    }),
    current: clipTodo(currentValue(book, target, entities), CURRENT_MAX),
    record: recordText(entity, categories),
    passages: passagesFor(db, book, row, entity)
  })
  const result = await runAiRequest(deps, {
    feature: 'todo',
    tier: 'fast',
    messages: prompt.messages,
    maxTokens: prompt.maxTokens,
    json: true,
    contextHash: sha256(JSON.stringify(prompt.messages)),
    promptVersion: prompt.version,
    ...(input.requestId === undefined ? {} : { requestId: input.requestId })
  })
  const suggestions = parseTodoSuggestAnswer(result.text)
  db.update(todoItem)
    .set({
      suggestions: JSON.stringify(suggestions),
      suggestedAt: deps.now().toISOString(),
      updatedAt: deps.now().toISOString()
    })
    .where(and(eq(todoItem.id, row.id), eq(todoItem.status, 'open')))
    .run()
  return { suggestions, requested: true, costUsd: result.costUsd }
}
