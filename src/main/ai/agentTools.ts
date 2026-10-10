import {
  AGENT_BULK_MAX,
  AGENT_BRIEF_MAX,
  AGENT_CARDS_MAX,
  AGENT_EDIT_TEXT_MAX,
  AGENT_LOOKUP_CHARS,
  AGENT_PASSAGE_RESULTS,
  AGENT_TOOLS_V6,
  AGENT_WORDS_DEFAULT,
  AGENT_WORDS_MAX,
  AGENT_WORDS_MIN,
  AGENT_READ_CHARS,
  AGENT_RESULT_CHARS,
  AGENT_SEARCH_RESULTS,
  AGENT_TITLE_MAX,
  AgentTool,
  type AgentEdit,
  type AgentStep
} from '@shared/agent'
import { normalizeForMatch } from '@shared/critique'
import {
  ALWAYS_SHOWN_CATEGORIES,
  categoryFieldLabel,
  categoryOf,
  isCategoryField,
  type StoryCategory
} from '@shared/categories'
import { ENTITY_NAME_MAX, toEntityNameKey } from '@shared/entities'
import { sheetAt, type Fact, type FactStatus } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import { passageParagraphs } from '@shared/mentions'
import { RELATION_INVERSE_LABEL, RELATION_LABEL, relationTypeOf } from '@shared/relations'
import { renderCard } from '@shared/sceneCard'
import { SCENE_SYNOPSIS_MAX, parseStoredSceneMeta } from '@shared/sceneMeta'
import { STORY_MAP_NOW_MARK, sceneProgress } from '@shared/storyTime'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, toTagName, type TagCategory } from '@shared/tags'
import { THREAD_KIND, THREAD_STATUS_LABEL, deriveThreads, type ThreadView } from '@shared/threads'
import { TODO_KINDS, TODO_KIND_NOUN, TodoKind } from '@shared/todo'
import type { NodeRow } from '../db/schema'
import { getSummary } from '../document/summaryStore'
import { listCategories } from '../entity/categoryStore'
import { clearOptions, type ClearWanted } from '../knowledge/bibleClear'
import { isEmptySheet } from '../organise/organiseProject'
import { listDocumentTags } from '../tag/documentTagStore'
import { listEntities } from '../entity/entityStore'
import { allFactsForEntities, factsForEntities, listFactsForEntity } from '../entity/factStore'
import { sceneCardFor } from '../knowledge/sceneCard'
import { searchPassages } from '../search/passageIndex'
import { nodesInTreeOrder } from '../search/searchStore'
import { listMentionsForTag, mentionParagraphsForTag } from '../tag/mentionStore'
import { findTagByNameOrAlias, getTag, listTags } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { listTodo } from '../knowledge/todoStore'
import { documentJson, documentText } from '../voice/profile'
import { headTruncate } from './context/chatContext'
import { rankCandidates, sceneTitles } from './context/queryContext'
import { notesText } from './context/scenePanel'
import { positionNote, storyTime, type StoryTime } from './context/storyTime'

/**
 * The project as one agent run sees it (F-5.22): every node in tree order under a short ref
 * (`n1`, `n2`, … — cheaper than ids and impossible to half-remember), the chat's names for
 * them, and the story-bible sheets. Built once per run; the refs hold for the whole run.
 */
export interface AgentProject {
  db: TreeDb
  rows: NodeRow[]
  byId: Map<string, NodeRow>
  refOf: Map<string, string>
  byRef: Map<string, NodeRow>
  /** `Chapter › Scene`, as the Query answers name scenes. */
  titleOf: (nodeId: string) => string
  entities: Entity[]
  /** F-5.23: where now is, so every scene a tool returns says whether it has happened yet. */
  time: StoryTime
}

/**
 * Loads the project for one run. `activeId` is the node the author has selected: it puts now at
 * that scene (F-5.23), or, outside the manuscript, at the latest written scene.
 */
export function loadAgentProject(db: TreeDb, activeId: string | null = null): AgentProject {
  const all = listNodes(db)
  const rows = nodesInTreeOrder(all)
  const refOf = new Map<string, string>()
  const byRef = new Map<string, NodeRow>()
  rows.forEach((row, index) => {
    const ref = `n${index + 1}`
    refOf.set(row.id, ref)
    byRef.set(ref, row)
  })
  return {
    db,
    rows,
    byId: new Map(rows.map((row) => [row.id, row])),
    refOf,
    byRef,
    titleOf: sceneTitles(db),
    entities: listEntities(db),
    time: storyTime(db, activeId, all)
  }
}

/**
 * F-5.23: what agent.v5's `search` says about the sheets it names (the tools agent.v6 runs mark
 * every record, note, and fact with its status instead, `statusMark`).
 */
export const SHEETS_ARE_PLANS =
  "the author's notes and plans: true of who and what things are, but an event told only here " +
  'has not happened yet'

/** A node by the ref the model wrote (`n3`, also `N3` or a bare `3`), or undefined. */
export function nodeByRef(project: AgentProject, ref: unknown): NodeRow | undefined {
  if (typeof ref !== 'string') return undefined
  const key = ref.trim().toLowerCase()
  return project.byRef.get(/^\d+$/.test(key) ? `n${key}` : key)
}

/**
 * The sheet a name points at: the exact name first, then an exact alias (F-4.14), then the only
 * one whose name holds it.
 */
export function sheetByName(project: AgentProject, name: unknown): Entity | undefined {
  if (typeof name !== 'string' || name.trim() === '') return undefined
  const key = toEntityNameKey(name)
  const exact = project.entities.find((entity) => toEntityNameKey(entity.name) === key)
  if (exact) return exact
  const aliased = project.entities.find((entity) =>
    entity.aliases.some((alias) => toEntityNameKey(alias) === key)
  )
  if (aliased) return aliased
  const partial = project.entities.filter((entity) => toEntityNameKey(entity.name).includes(key))
  return partial.length === 1 ? partial[0] : undefined
}

const isDocument = (row: NodeRow | undefined): row is NodeRow =>
  row?.kind === 'document' && row.parentId !== null

const levelOf = (row: NodeRow): string =>
  row.sectionType !== null ? 'section' : (row.hierarchyLevel ?? row.kind)

const cap = (text: string): string => headTruncate(text, AGENT_RESULT_CHARS)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** What one tool call produced: the line the chat shows and the text the model reads next. */
export interface ToolOutcome {
  step: AgentStep
  result: string
}

/**
 * Runs one read tool. Never throws for the model's mistakes: an unknown tool, a ref that names
 * nothing, or a sheet nobody wrote comes back as a result saying so, and the model tries again.
 */
export function runAgentTool(
  project: AgentProject,
  activeId: string | null,
  name: unknown,
  args: Record<string, unknown>,
  tools: readonly AgentTool[] = AGENT_TOOLS_V6
): ToolOutcome {
  const tool = AgentTool.safeParse(name)
  if (!tool.success || !tools.includes(tool.data)) {
    return {
      step: { tool: 'outline', label: 'Looking around…' },
      result: `There is no tool "${str(name)}". Use one of the tools listed.`
    }
  }
  switch (tool.data) {
    case 'search':
      return search(project, activeId, str(args.query))
    case 'outline':
      return { step: { tool: 'outline', label: 'Reading the outline…' }, result: outline(project) }
    case 'read_scene':
      return readScene(project, args.id, args.from, args.para)
    case 'read_notes':
      return readNotes(project, args.id)
    case 'read_summary':
      return readSummary(project, args.id)
    case 'read_sheet':
      return readSheet(project, args.name)
    case 'list_sheets':
      return str(args.field).trim() === ''
        ? listSheets(project, str(args.kind))
        : listSheetField(project, str(args.kind), str(args.field), args.empty === true)
    case 'tags':
      return { step: { tool: 'tags', label: 'Reading the tags…' }, result: tags(project) }
    case 'todo':
      return {
        step: { tool: 'todo', label: 'Reading the To do list…' },
        result: todo(project, args.kind)
      }
    case 'lookup':
      return lookup(project, args.name)
    case 'cards':
      return cards(project, args.ids, args.name)
    case 'find_passages':
      return findPassages(project, str(args.query))
  }
}

/**
 * F-5.24: how a v6 result marks where a source stands (D7): `[canon]` the story as written,
 * `[plan]` the author's intent not on the page yet, `[idea]` a maybe. The prompt's status rule
 * reads the same three words.
 */
export function statusMark(status: FactStatus): string {
  return `[${status}]`
}

/** The record a name points at: its sheet by name or alias (`sheetByName`), else its tag's record. */
export function recordByName(project: AgentProject, name: unknown): Entity | undefined {
  const sheet = sheetByName(project, name)
  if (sheet !== undefined || typeof name !== 'string') return sheet
  const tagId = findTagByNameOrAlias(project.db, toTagName(name))
  return tagId === undefined ? undefined : project.entities.find((e) => e.tagId === tagId)
}

/** A scene's index in reading order; -1 for an undated statement, past the end for one outside it. */
function readingIndex(project: AgentProject, nodeId: string | null): number {
  if (nodeId === null) return -1
  const at = project.time.order.indexOf(nodeId)
  return at === -1 ? project.time.order.length : at
}

/** Now's index in reading order; with no now, the end of the book. */
function nowIndex(project: AgentProject): number {
  const at = project.time.nowId === null ? -1 : project.time.order.indexOf(project.time.nowId)
  return at === -1 ? project.time.order.length : at
}

/** The refs of the scenes behind a value, in order, without repeats. */
function refsOf(project: AgentProject, nodeIds: readonly (string | null)[]): string {
  const refs = [
    ...new Set(
      nodeIds.flatMap((id) => {
        const ref = id === null ? undefined : project.refOf.get(id)
        return ref === undefined ? [] : [ref]
      })
    )
  ]
  return refs.length > 0 ? ` (${refs.join(', ')})` : ''
}

/**
 * The record at now, in brief (F-5.24, at most `AGENT_LOOKUP_CHARS`): the name, category, status,
 * and other names; each filled field as the author wrote it with what the scenes state up to now
 * (`sheetAt`); its relationships up to now; its threads (a thread record's own status, else the
 * open threads moved in scenes that name it); where the book names it (scenes, first and last
 * with the paragraph); and the card of the last scene up to now that names it. A name no record
 * answers says what to try instead.
 */
function lookup(project: AgentProject, nameArg: unknown): ToolOutcome {
  const name = str(nameArg).trim()
  const step: AgentStep = {
    tool: 'lookup',
    label: name === '' ? 'Looking up a name…' : `Looking up ${headTruncate(name, 60)}…`
  }
  if (name === '') return { step, result: 'lookup needs a "name".' }
  const entity = recordByName(project, name)
  if (entity === undefined) {
    return {
      step,
      result: `No record is called "${name}". Try find_passages for the words, or list_sheets.`
    }
  }
  const now = nowIndex(project)
  const nowRef = project.time.nowId === null ? undefined : project.refOf.get(project.time.nowId)
  const category = categoryOf(entity.kind, listCategories(project.db))
  const lines = [
    `${entity.name} (${category.noun.toLowerCase()}) ${statusMark(entity.status)}` +
      (entity.aliases.length > 0 ? `; also ${entity.aliases.join(', ')}` : '') +
      (nowRef === undefined ? '; as of the end of the book' : `; as of ${nowRef} (now)`)
  ]

  // Fields: the author's text, then what the scenes state up to now.
  for (const field of sheetAt({
    facts: factsForEntities(project.db, [entity.id]),
    fields: entity.fields,
    attributes: category.fields.map((each) => each.id),
    order: project.time.order,
    position: project.time.nowId
  })) {
    const stated = (
      field.mode === 'replace' ? (field.current === null ? [] : [field.current]) : field.details
    )
      .filter((value) => value.value.trim() !== (field.baseline ?? '').trim())
      .map(
        (value) =>
          `${value.value}${value.status === 'canon' ? '' : ` ${statusMark(value.status)}`}` +
          refsOf(
            project,
            value.sources.map((source) => source.nodeId)
          )
      )
    const parts = [...(field.baseline === null ? [] : [field.baseline]), ...stated]
    if (parts.length === 0) continue
    lines.push(`${categoryFieldLabel(category, field.attribute)}: ${parts.join('; ')}`)
  }

  // Relationships up to now, both directions.
  const byId = new Map(project.entities.map((each) => [each.id, each.name]))
  const relations = listFactsForEntity(project.db, entity.id).flatMap((fact) => {
    const type = relationTypeOf(fact.attribute)
    if (type === null || fact.hidden || readingIndex(project, fact.nodeId) > now) return []
    const subject = fact.entityId === entity.id
    const other = byId.get((subject ? fact.objectEntityId : fact.entityId) ?? '')
    if (other === undefined) return []
    const label = subject ? RELATION_LABEL[type] : RELATION_INVERSE_LABEL[type]
    const said = fact.value.trim() === '' ? '' : ` “${fact.value.trim()}”`
    const mark = fact.status === 'canon' ? '' : ` ${statusMark(fact.status)}`
    return [`${label} ${other}${said}${mark}${refsOf(project, [fact.nodeId])}`]
  })
  if (relations.length > 0) lines.push(`Relations: ${relations.join('; ')}`)

  // Where the book names it, in reading order.
  const mentions =
    entity.tagId === null
      ? []
      : listMentionsForTag(project.db, entity.tagId)
          .map((mention) => ({ ...mention, at: readingIndex(project, mention.nodeId) }))
          .filter((mention) => mention.at < project.time.order.length)
          .sort((a, b) => a.at - b.at)
  const threads = threadLines(
    project,
    entity,
    mentions.filter((m) => m.at <= now).map((m) => m.nodeId)
  )
  if (threads !== '') lines.push(threads)
  if (mentions.length === 0) {
    lines.push('Named in no scene yet.')
  } else {
    const paragraphs =
      entity.tagId === null
        ? new Map<string, number[]>()
        : mentionParagraphsForTag(project.db, entity.tagId)
    const where = (nodeId: string, last: boolean): string => {
      const paras = paragraphs.get(nodeId) ?? []
      const para = last ? paras.at(-1) : paras[0]
      return `${project.refOf.get(nodeId) ?? '?'}${para === undefined ? '' : ` ¶${para}`}`
    }
    const first = mentions[0]!
    const last = mentions.at(-1)!
    const upToNow = mentions.filter((m) => m.at <= now).length
    lines.push(
      `Named in ${mentions.length} scene${mentions.length === 1 ? '' : 's'} (${upToNow} up to now): ` +
        `first ${where(first.nodeId, false)}, last ${where(last.nodeId, true)}`
    )
    const seen = [...mentions].reverse().find((m) => m.at <= now)
    const card = seen === undefined ? null : sceneCardFor(project.db, seen.nodeId)
    if (seen !== undefined && card !== null) {
      lines.push(renderCard(`Last seen ${sceneHead(project, seen.nodeId)}:`, card))
    }
  }
  return { step, result: headTruncate(lines.join('\n'), AGENT_LOOKUP_CHARS) }
}

/** `n7 Chapter 1 › The ferry landing (before now: has happened)`, as the v6 tools head a scene. */
function sceneHead(project: AgentProject, nodeId: string): string {
  return `${project.refOf.get(nodeId) ?? '?'} ${project.titleOf(nodeId)} (${positionNote(project.time, nodeId)})`
}

/** The threads as of now: thread events stated after now are left out (`deriveThreads`). */
function threadsAtNow(project: AgentProject, records: readonly Entity[]): ThreadView[] {
  const now = nowIndex(project)
  const facts = allFactsForEntities(
    project.db,
    records.map((record) => record.id)
  ).filter((fact: Fact) => readingIndex(project, fact.nodeId) <= now)
  return deriveThreads(
    records.map((record) => ({ id: record.id, name: record.name, origin: record.origin })),
    facts,
    project.time.order
  )
}

/**
 * The lookup's thread line: a thread record's own status at now (with its open question, setup,
 * and payoff), else the open threads with an event in a scene up to now that names the record
 * (most shared scenes first, at most 3). '' for none.
 */
function threadLines(project: AgentProject, entity: Entity, named: readonly string[]): string {
  if (entity.kind === THREAD_KIND) {
    const view = threadsAtNow(project, [entity])[0]
    if (view === undefined) return ''
    const parts = [`Thread: ${THREAD_STATUS_LABEL[view.status].toLowerCase()}`]
    if (view.question !== '') parts.push(`question: ${view.question}`)
    if (view.setup !== null) parts.push(`set up${refsOf(project, [view.setup.nodeId])}`)
    if (view.payoff !== null) parts.push(`paid off${refsOf(project, [view.payoff.nodeId])}`)
    return parts.join('; ')
  }
  if (named.length === 0) return ''
  const inScenes = new Set(named)
  const open = threadsAtNow(
    project,
    project.entities.filter((each) => each.kind === THREAD_KIND)
  )
    .filter((view) => view.status === 'open')
    .map((view) => ({
      view,
      shared: view.events.filter((event) => event.nodeId !== null && inScenes.has(event.nodeId))
        .length
    }))
    .filter((each) => each.shared > 0)
    .sort((a, b) => b.shared - a.shared)
    .slice(0, 3)
  if (open.length === 0) return ''
  return `Open threads: ${open
    .map(({ view }) => {
      const question = view.question === '' ? '' : `: ${headTruncate(view.question, 100)}`
      return `${view.name}${question}${refsOf(project, [view.setup?.nodeId ?? null])}`
    })
    .join('; ')}`
}

/**
 * Scene cards (F-5.24, at most `AGENT_CARDS_MAX`, about 100 tokens each): the scenes `ids` names
 * (a list of refs, or one string of them), else the scenes in reading order that name the record
 * `name`. A scene with no card yet reads as its stored summary's first sentence, or says so.
 */
function cards(project: AgentProject, idsArg: unknown, nameArg: unknown): ToolOutcome {
  const refs = (
    Array.isArray(idsArg) ? idsArg : typeof idsArg === 'string' ? idsArg.split(/[\s,]+/) : []
  ).filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
  let nodeIds: string[]
  let more = 0
  if (refs.length > 0) {
    nodeIds = [
      ...new Set(
        refs.flatMap((ref) => {
          const row = nodeByRef(project, ref)
          return row?.kind === 'document' && row.parentId !== null ? [row.id] : []
        })
      )
    ]
  } else {
    const entity = recordByName(project, nameArg)
    if (entity === undefined) {
      const name = str(nameArg).trim()
      return {
        step: { tool: 'cards', label: 'Reading scene cards…' },
        result:
          name === ''
            ? 'cards needs "ids" (scene ids) or a "name".'
            : `No record is called "${name}". Try find_passages, or name the scene ids.`
      }
    }
    const named =
      entity.tagId === null
        ? []
        : listMentionsForTag(project.db, entity.tagId)
            .map((mention) => ({ id: mention.nodeId, at: readingIndex(project, mention.nodeId) }))
            .filter((each) => each.at < project.time.order.length)
            .sort((a, b) => a.at - b.at)
            .map((each) => each.id)
    nodeIds = named
    if (nodeIds.length === 0) {
      return {
        step: { tool: 'cards', label: 'Reading scene cards…' },
        result: `No scene names ${entity.name} yet.`
      }
    }
  }
  if (nodeIds.length > AGENT_CARDS_MAX) {
    more = nodeIds.length - AGENT_CARDS_MAX
    nodeIds = nodeIds.slice(0, AGENT_CARDS_MAX)
  }
  const step: AgentStep = {
    tool: 'cards',
    label: `Reading ${nodeIds.length} scene card${nodeIds.length === 1 ? '' : 's'}…`
  }
  if (nodeIds.length === 0) return { step, result: 'Those ids name no scene; read the outline.' }
  const blocks = nodeIds.map((nodeId) => {
    const head = sceneHead(project, nodeId)
    const card = sceneCardFor(project.db, nodeId)
    if (card !== null) return renderCard(head, card)
    const summary = getSummary(project.db, nodeId)?.summary.trim() ?? ''
    return `${head}\n${summary === '' ? 'No card yet; read the scene.' : headTruncate(summary, 300)}`
  })
  const tail = more > 0 ? `\n…and ${more} more scenes; name their ids for their cards.` : ''
  return { step, result: cap(`${blocks.join('\n\n')}${tail}`) }
}

/**
 * The manuscript paragraphs that best match `query` (F-5.24, the local passage index, at most
 * `AGENT_PASSAGE_RESULTS`): `n7 ¶3 (position): snippet`. A snippet is the paragraph's own words
 * (cut with "…"), so the words between the cuts are quotable as they stand; `read_scene` with
 * `"para"` reads the whole paragraph.
 */
function findPassages(project: AgentProject, query: string): ToolOutcome {
  const step: AgentStep = { tool: 'find_passages', label: 'Finding passages…' }
  if (query.trim() === '') return { step, result: 'find_passages needs a "query".' }
  const hits = searchPassages(project.db, query, AGENT_PASSAGE_RESULTS).filter((hit) =>
    project.refOf.has(hit.nodeId)
  )
  if (hits.length === 0) {
    return { step, result: 'No passage matches. Try other words, or look the name up.' }
  }
  const lines = hits.map(
    (hit) =>
      `${project.refOf.get(hit.nodeId)} ¶${hit.para} (${positionNote(project.time, hit.nodeId)}): ` +
      hit.snippet.replace(/\s+/g, ' ').trim()
  )
  return { step, result: cap(lines.join('\n')) }
}

/** The most To do items one call lists. */
export const AGENT_TODO_ITEMS = 30

/**
 * The open To do list (F-9.16, agent.v5), grouped by kind in the list's order, one line per item:
 * `[Gap] Mara: why (n3)`, the ref naming the item's scene when it has one. A known `kind` keeps
 * that kind only; anything else lists all. At most `AGENT_TODO_ITEMS` lines within the result cap.
 * The items are what the book leaves open, as the list states them: the agent reports them, it
 * never resolves one.
 */
function todo(project: AgentProject, kind: unknown): string {
  const wanted = TodoKind.safeParse(kind)
  const items = listTodo(project.db).items.filter(
    (item) => !wanted.success || item.kind === wanted.data
  )
  if (items.length === 0) {
    return wanted.success
      ? `The To do list has no open ${TODO_KIND_NOUN[wanted.data].toLowerCase()} items.`
      : 'The To do list is empty: nothing is left to figure out right now.'
  }
  const ordered = TODO_KINDS.flatMap((each) => items.filter((item) => item.kind === each))
  const lines = ordered.slice(0, AGENT_TODO_ITEMS).map((item) => {
    const ref = item.nodeId === null ? undefined : project.refOf.get(item.nodeId)
    return `[${TODO_KIND_NOUN[item.kind]}] ${item.subject}: ${item.why}${ref === undefined ? '' : ` (${ref})`}`
  })
  const more =
    ordered.length > AGENT_TODO_ITEMS ? `\n…and ${ordered.length - AGENT_TODO_ITEMS} more.` : ''
  return cap(`Open To do items:\n${lines.join('\n')}${more}`)
}

function search(project: AgentProject, activeId: string | null, query: string): ToolOutcome {
  const step: AgentStep = { tool: 'search', label: `Searching “${headTruncate(query, 80)}”…` }
  if (query.trim() === '') return { step, result: 'Search needs a "query".' }
  const ranked = rankCandidates(project.db, { question: query, nodeId: activeId }).ranked.filter(
    (candidate) => candidate.score > 0
  )
  const lines = ranked.slice(0, AGENT_SEARCH_RESULTS).map((candidate) => {
    const ref = project.refOf.get(candidate.nodeId) ?? '?'
    const about = candidate.summary?.summary ?? headTruncate(candidate.text, 200)
    const when = positionNote(project.time, candidate.nodeId)
    return `${ref} ${candidate.title} (${when}): ${headTruncate(about, 300)}`
  })
  const key = toEntityNameKey(query)
  const sheets = project.entities
    .filter((entity) => {
      const name = toEntityNameKey(entity.name)
      return name !== '' && (key.includes(name) || name.includes(key))
    })
    .map((entity) => `${entity.name} (${entity.kind})`)
  if (lines.length === 0 && sheets.length === 0) {
    return { step, result: 'No scene matches. Try other words, or read the outline.' }
  }
  const parts = []
  if (lines.length > 0) parts.push(`Scenes:\n${lines.join('\n')}`)
  if (sheets.length > 0) parts.push(`Sheets (${SHEETS_ARE_PLANS}): ${sheets.join(', ')}`)
  return { step, result: cap(parts.join('\n')) }
}

function outline(project: AgentProject): string {
  const depth = new Map<string, number>()
  const lines: string[] = []
  for (const row of project.rows) {
    const level = row.parentId === null ? 0 : (depth.get(row.parentId) ?? 0) + 1
    depth.set(row.id, level)
    const words = row.kind === 'document' ? `, ${row.wordCount.toLocaleString('en-US')} words` : ''
    // F-5.23: each manuscript document's progress (F-11.1d) and the mark on now.
    const inStory = row.kind === 'document' && project.time.positionOf(row.id) !== null
    const progress = inStory
      ? `, ${sceneProgress(row.wordCount, parseStoredSceneMeta(row.sceneMeta).status)}`
      : ''
    const now = project.time.nowId === row.id ? ` ${STORY_MAP_NOW_MARK}` : ''
    lines.push(
      `${'  '.repeat(level)}${project.refOf.get(row.id) ?? '?'} ${row.title} (${levelOf(row)}${words}${progress})${now}`
    )
  }
  return cap(lines.join('\n'))
}

/** A document by ref for the read tools, or the result that says why not. */
function documentFor(
  project: AgentProject,
  ref: unknown
): { row: NodeRow; title: string } | { error: string } {
  const row = nodeByRef(project, ref)
  if (row === undefined) return { error: `${str(ref) || 'That'} is not an id; read the outline.` }
  if (row.parentId === null) return { error: `${str(ref)} is a section; read the outline.` }
  return { row, title: project.titleOf(row.id) || row.title }
}

function readScene(
  project: AgentProject,
  ref: unknown,
  fromArg: unknown,
  paraArg?: unknown
): ToolOutcome {
  const found = documentFor(project, ref)
  if ('error' in found) {
    return { step: { tool: 'read_scene', label: 'Looking for a scene…' }, result: found.error }
  }
  const { row, title } = found
  const step: AgentStep = { tool: 'read_scene', label: `Reading ${title}…` }
  if (row.kind !== 'document') {
    return { step, result: `${str(ref)} is a folder; read the outline for what is inside.` }
  }
  const text = documentText(row)
  if (text.trim() === '') return { step, result: `${title} is empty.` }
  const para =
    typeof paraArg === 'number' ? paraArg : typeof paraArg === 'string' ? Number(paraArg) : NaN
  if (Number.isFinite(para)) return readParagraphs(project, row, title, Math.floor(para), step)
  const from = Math.max(
    0,
    Math.min(typeof fromArg === 'number' ? Math.floor(fromArg) : 0, text.length)
  )
  const to = Math.min(text.length, from + AGENT_READ_CHARS)
  const when = positionNote(project.time, row.id)
  const head = `${project.refOf.get(row.id)} ${title} (${when}), characters ${from}–${to} of ${text.length}:`
  const more = to < text.length ? `\n(continues; read on with "from":${to})` : ''
  return { step, result: `${head}\n${text.slice(from, to)}${more}` }
}

/**
 * F-5.24: a scene from paragraph `para` on (the index `find_passages` and `lookup` name), whole
 * paragraphs up to `AGENT_READ_CHARS`, with where to read on.
 */
function readParagraphs(
  project: AgentProject,
  row: NodeRow,
  title: string,
  para: number,
  step: AgentStep
): ToolOutcome {
  const json = documentJson(row)
  const paragraphs = json === null ? [] : passageParagraphs(json)
  if (paragraphs.length === 0) return { step, result: `${title} has no paragraphs to read.` }
  const start = Math.max(0, Math.min(para, paragraphs.length - 1))
  const taken: string[] = []
  let used = 0
  let end = start
  for (; end < paragraphs.length; end++) {
    const piece = paragraphs[end]!.text
    if (taken.length > 0 && used + piece.length > AGENT_READ_CHARS) break
    taken.push(piece.slice(0, AGENT_READ_CHARS))
    used += piece.length + 2
  }
  const when = positionNote(project.time, row.id)
  const head = `${project.refOf.get(row.id)} ${title} (${when}), ¶${start}–¶${end - 1} of ${paragraphs.length}:`
  const more = end < paragraphs.length ? `\n(continues; read on with "para":${end})` : ''
  return { step, result: `${head}\n${taken.join('\n\n')}${more}` }
}

function readNotes(project: AgentProject, ref: unknown): ToolOutcome {
  const found = documentFor(project, ref)
  if ('error' in found) {
    return { step: { tool: 'read_notes', label: 'Looking for notes…' }, result: found.error }
  }
  const { row, title } = found
  const meta = parseStoredSceneMeta(row.sceneMeta)
  const synopsis = meta.synopsis.trim()
  const notes = notesText(row.notes, row.id)
  const parts = [
    // F-5.24: the notes' status (`SceneMeta.notesStatus`, plan unless the author says otherwise).
    `${title}, the author's notes ${statusMark(meta.notesStatus)}:`,
    `Synopsis: ${synopsis || '(none)'}`,
    `Notes:\n${notes || '(none)'}`
  ]
  return {
    step: { tool: 'read_notes', label: `Reading the notes of ${title}…` },
    result: cap(parts.join('\n'))
  }
}

function readSummary(project: AgentProject, ref: unknown): ToolOutcome {
  const found = documentFor(project, ref)
  if ('error' in found) {
    return { step: { tool: 'read_summary', label: 'Looking for a summary…' }, result: found.error }
  }
  const { row, title } = found
  const step: AgentStep = { tool: 'read_summary', label: `Reading the summary of ${title}…` }
  const summary = getSummary(project.db, row.id)
  if (summary === null) return { step, result: `${title} has no summary yet; read the scene.` }
  const points = summary.keyPoints.map((point) => `- ${point}`).join('\n')
  const when = positionNote(project.time, row.id)
  return {
    step,
    result: cap(
      `${title} (${when}):\n${summary.summary}${points ? `\nKey points:\n${points}` : ''}`
    )
  }
}

function readSheet(project: AgentProject, name: unknown): ToolOutcome {
  const entity = sheetByName(project, name)
  if (entity === undefined) {
    return {
      step: { tool: 'read_sheet', label: `Looking for ${headTruncate(str(name), 60)}…` },
      result: `No sheet is called "${str(name)}"; list the sheets.`
    }
  }
  const lines = [`${entity.name} (${entity.kind}) ${statusMark(entity.status)}`]
  const fields = categoryOf(entity.kind, listCategories(project.db)).fields
  for (const field of fields) {
    const value = entity.fields[field.id]?.trim() ?? ''
    lines.push(`${field.id} (${field.label}): ${value || '(empty)'}`)
  }
  const body = entity.body?.trim() ?? ''
  if (body) lines.push(`Page:\n${body}`)
  // F-9.13: what the scenes state, dated, as of now: quoted, so citable; later scenes left out.
  const dated = sheetAt({
    facts: factsForEntities(project.db, [entity.id]),
    fields: {},
    attributes: fields.map((field) => field.id),
    order: project.time.order,
    position: project.time.nowId
  }).flatMap((field) =>
    (field.mode === 'replace'
      ? field.current === null
        ? []
        : [field.current]
      : field.details
    ).map((value) => {
      const where = value.sources
        .flatMap((source) => (source.nodeId === null ? [] : [project.refOf.get(source.nodeId)]))
        .filter((ref): ref is string => ref !== undefined)
      const status = value.status === 'canon' ? '' : ` ${statusMark(value.status)}`
      return `${field.attribute}: ${value.value}${status}${where.length ? ` (${where.join(', ')})` : ''}`
    })
  )
  if (dated.length > 0) lines.push('Stated in the scenes so far:', ...dated)
  return {
    step: { tool: 'read_sheet', label: `Reading ${entity.name}’s sheet…` },
    result: cap(lines.join('\n'))
  }
}

/**
 * The category a `kind` argument names (F-9.11): an id, a name, or a singular, any case; null
 * for none (then every category in use is listed).
 */
function categoryArg(categories: readonly StoryCategory[], kindArg: string): StoryCategory | null {
  const key = kindArg.trim().toLowerCase()
  if (key === '') return null
  return (
    categories.find(
      (c) => c.id === key || c.name.toLowerCase() === key || c.noun.toLowerCase() === key
    ) ?? null
  )
}

function listSheets(project: AgentProject, kindArg: string): ToolOutcome {
  const categories = listCategories(project.db)
  const asked = categoryArg(categories, kindArg)
  // Every category in use, and the two the sidebar always shows (F-9.11).
  const shown =
    asked !== null
      ? [asked]
      : categories.filter(
          (c) =>
            ALWAYS_SHOWN_CATEGORIES.includes(c.id) || project.entities.some((e) => e.kind === c.id)
        )
  const lines = shown.map((each) => {
    const names = project.entities.filter((e) => e.kind === each.id).map((e) => e.name)
    return `${each.name} (${each.id}): ${names.length > 0 ? names.join(', ') : '(none)'}`
  })
  return {
    step: {
      tool: 'list_sheets',
      label: asked !== null ? `Listing the ${asked.name}…` : 'Listing the sheets…'
    },
    result: cap(lines.join('\n'))
  }
}

/**
 * F-5.25 (agent.v7): `list_sheets {"kind","field","empty"}`, one field across the sheets: each
 * sheet's value of it (a field id or its label, any case), or with `empty` only the sheets where
 * it is blank. A category without that field is left out.
 */
function listSheetField(
  project: AgentProject,
  kindArg: string,
  fieldArg: string,
  emptyOnly: boolean
): ToolOutcome {
  const categories = listCategories(project.db)
  const asked = categoryArg(categories, kindArg)
  const shown = asked !== null ? [asked] : categories
  const key = fieldArg.trim().toLowerCase()
  const lines: string[] = []
  for (const category of shown) {
    const field = category.fields.find(
      (f) => f.id.toLowerCase() === key || f.label.toLowerCase() === key
    )
    if (field === undefined) continue
    const rows = project.entities
      .filter((e) => e.kind === category.id)
      .map((e) => ({ name: e.name, value: (e.fields[field.id] ?? '').trim() }))
      .filter((row) => !emptyOnly || row.value === '')
    if (rows.length === 0) continue
    lines.push(`${category.name}, ${field.label}:`)
    for (const row of rows) lines.push(`- ${row.name}: ${row.value === '' ? '(empty)' : row.value}`)
  }
  return {
    step: { tool: 'list_sheets', label: `Listing ${fieldArg.trim()} across the sheets…` },
    result: cap(
      lines.length > 0
        ? lines.join('\n')
        : `No sheet ${emptyOnly ? 'leaves' : 'has'} a field called "${fieldArg.trim()}"${emptyOnly ? ' empty' : ''}.`
    )
  }
}

function tags(project: AgentProject): string {
  const all = listTags(project.db)
  const lines = TAG_CATEGORIES.map((category) => {
    const names = all.filter((tag) => tag.category === category).map((tag) => tag.name)
    return names.length > 0 ? `${TAG_CATEGORY_LABEL[category]}: ${names.join(', ')}` : null
  }).filter((line): line is string => line !== null)
  return cap(lines.length > 0 ? lines.join('\n') : 'No tags yet.')
}

/** How many times `find` occurs in `text`, both normalized the way quotes are matched. */
export function occurrencesOf(text: string, find: string): number {
  const needle = normalizeForMatch(find)
  if (needle === '') return 0
  const haystack = normalizeForMatch(text)
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count++
  }
  return count
}

/** One edit as the model wrote it, or the reason it cannot be offered. */
export type ResolvedEdit = { edit: AgentEdit } | { error: string }

const text = (value: unknown, max = AGENT_EDIT_TEXT_MAX): string =>
  typeof value === 'string' ? value.trim().slice(0, max) : ''

/** The length a drafted insertion asks for: the model's number (or numeric string), clamped; the default without one. */
export function draftWords(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  if (!Number.isFinite(n) || n <= 0) return AGENT_WORDS_DEFAULT
  return Math.min(AGENT_WORDS_MAX, Math.max(AGENT_WORDS_MIN, Math.round(n)))
}

/**
 * Turns one edit the model wrote into a typed `AgentEdit` against the project as it is now, or
 * says why not: an id that names nothing, a passage the document does not hold exactly once, a
 * level the parent cannot take. The renderer checks again when it applies, since the book may
 * have moved on by then.
 */
export function resolveAgentEdit(project: AgentProject, raw: unknown): ResolvedEdit {
  if (typeof raw !== 'object' || raw === null) return { error: 'not an object' }
  const edit = raw as Record<string, unknown>
  const kind = str(edit.edit)
  const nameOf = (row: NodeRow): string => project.titleOf(row.id) || row.title
  const documentArg = (): NodeRow | string => {
    const row = nodeByRef(project, edit.id)
    return isDocument(row) ? row : `${str(edit.id) || 'the id'} is not a document`
  }
  const unique = (row: NodeRow, passage: string, what: string): string | null => {
    const n = occurrencesOf(documentText(row), passage)
    return n === 1
      ? null
      : n === 0
        ? `${what} is not in ${nameOf(row)}`
        : `${what} occurs ${n} times`
  }

  switch (kind) {
    case 'text': {
      const row = documentArg()
      if (typeof row === 'string') return { error: row }
      const find = text(edit.find)
      // agent.v2: a brief without a replacement asks the app to draft one (2026-10-07); a
      // replacement the model wrote anyway (or a cut, `"replace":""`) is taken as it is.
      const brief = typeof edit.replace === 'string' ? '' : text(edit.brief, AGENT_BRIEF_MAX)
      const replace =
        typeof edit.replace === 'string' ? edit.replace.slice(0, AGENT_EDIT_TEXT_MAX) : ''
      if (!find) return { error: 'no "find"' }
      const problem = unique(row, find, 'the passage')
      if (problem) return { error: problem }
      if (brief === '' && normalizeForMatch(find) === normalizeForMatch(replace)) {
        return { error: 'no change' }
      }
      return {
        edit: {
          kind: 'text',
          nodeId: row.id,
          title: nameOf(row),
          find,
          replace: replace.trim(),
          brief
        }
      }
    }
    case 'insert': {
      const row = documentArg()
      if (typeof row === 'string') return { error: row }
      const after = text(edit.after)
      const body = text(edit.text)
      const brief = body === '' ? text(edit.brief, AGENT_BRIEF_MAX) : ''
      if (!body && !brief) return { error: 'no "brief"' }
      // A drafted insertion keeps an "after" the scene does not hold once: the renderer places it
      // at the caret instead and says so (2026-10-07). Prose the model wrote itself must fit.
      if (after && brief === '') {
        const problem = unique(row, after, 'the "after" passage')
        if (problem) return { error: problem }
      }
      return {
        edit: {
          kind: 'insert',
          nodeId: row.id,
          title: nameOf(row),
          after,
          text: body,
          brief,
          words: brief === '' ? 0 : draftWords(edit.words)
        }
      }
    }
    case 'synopsis': {
      const row = documentArg()
      if (typeof row === 'string') return { error: row }
      const after = text(edit.text, SCENE_SYNOPSIS_MAX)
      const before = parseStoredSceneMeta(row.sceneMeta).synopsis
      if (after === before.trim()) return { error: 'no change' }
      return { edit: { kind: 'synopsis', nodeId: row.id, title: nameOf(row), before, after } }
    }
    case 'notes': {
      const row = nodeByRef(project, edit.id)
      if (!row?.parentId) return { error: 'not a document or folder' }
      const add = text(edit.text)
      if (!add) return { error: 'no "text"' }
      return { edit: { kind: 'notes', nodeId: row.id, title: nameOf(row), add } }
    }
    case 'sheet': {
      const entity = sheetByName(project, edit.name)
      if (entity === undefined) return { error: `no sheet called "${str(edit.name)}"` }
      const field = str(edit.field).trim()
      const category = categoryOf(entity.kind, listCategories(project.db))
      if (!isCategoryField(category, field))
        return { error: `"${field}" is not a ${category.noun} field` }
      const label = categoryFieldLabel(category, field)
      const before = entity.fields[field] ?? ''
      const after = text(edit.text)
      if (after === before.trim()) return { error: 'no change' }
      return {
        edit: { kind: 'sheet', entityId: entity.id, name: entity.name, field, label, before, after }
      }
    }
    case 'create': {
      const level = edit.level === 'chapter' ? 'chapter' : edit.level === 'scene' ? 'scene' : null
      if (level === null) return { error: 'level must be scene or chapter' }
      const parent = nodeByRef(project, edit.in)
      if (parent?.kind !== 'folder') return { error: '"in" is not a folder' }
      const afterRow = str(edit.after) === '' ? undefined : nodeByRef(project, edit.after)
      if (str(edit.after) !== '' && afterRow?.parentId !== parent.id) {
        return { error: '"after" is not inside "in"' }
      }
      const title = text(edit.title, AGENT_TITLE_MAX)
      if (!title) return { error: 'no "title"' }
      return {
        edit: {
          kind: 'create',
          level,
          parentId: parent.id,
          parentTitle: nameOf(parent),
          afterId: afterRow?.id ?? null,
          title,
          text: level === 'scene' ? text(edit.text) : ''
        }
      }
    }
    case 'rename': {
      const row = nodeByRef(project, edit.id)
      if (!row?.parentId) return { error: 'not a renamable id' }
      const after = text(edit.title, AGENT_TITLE_MAX)
      if (!after || after === row.title) return { error: 'no new title' }
      return { edit: { kind: 'rename', nodeId: row.id, title: row.title, after } }
    }
    case 'move': {
      if (edit.ids !== undefined || edit.from !== undefined) return resolveMoveMany(project, edit)
      const row = nodeByRef(project, edit.id)
      const parent = nodeByRef(project, edit.in)
      if (!row?.parentId) return { error: 'not a movable id' }
      if (parent?.kind !== 'folder') return { error: '"in" is not a folder' }
      const afterRow = str(edit.after) === '' ? undefined : nodeByRef(project, edit.after)
      if (str(edit.after) !== '' && afterRow?.parentId !== parent.id) {
        return { error: '"after" is not inside "in"' }
      }
      return {
        edit: {
          kind: 'move',
          nodeId: row.id,
          title: nameOf(row),
          parentId: parent.id,
          parentTitle: nameOf(parent),
          afterId: afterRow?.id ?? null
        }
      }
    }
    case 'split': {
      const row = documentArg()
      if (typeof row === 'string') return { error: row }
      const at = text(edit.at)
      if (!at) return { error: 'no "at"' }
      const problem = unique(row, at, 'the "at" passage')
      if (problem) return { error: problem }
      const newTitle = text(edit.title, AGENT_TITLE_MAX) || `${row.title} (continued)`
      return { edit: { kind: 'split', nodeId: row.id, title: nameOf(row), at, newTitle } }
    }
    case 'merge': {
      const row = documentArg()
      if (typeof row === 'string') return { error: row }
      const into = nodeByRef(project, edit.into)
      if (!isDocument(into) || into.id === row.id)
        return { error: '"into" is not another document' }
      return {
        edit: {
          kind: 'merge',
          nodeId: row.id,
          title: nameOf(row),
          intoId: into.id,
          intoTitle: nameOf(into)
        }
      }
    }
    case 'tag': {
      if (edit.ids !== undefined) return resolveTagMany(project, edit)
      const row = documentArg()
      if (typeof row === 'string') return { error: row }
      const typed = toTagName(str(edit.tag))
      if (!typed) return { error: 'no "tag"' }
      // F-4.14: an alias names its tag, so `#rynna` tags with `rynna-falsire`.
      const known = findTagByNameOrAlias(project.db, typed)
      const tag = known === undefined ? typed : (getTag(project.db, known)?.name ?? typed)
      const add = edit.add !== false
      if (!add && known === undefined) return { error: `no tag #${tag}` }
      return { edit: { kind: 'tag', nodeId: row.id, title: nameOf(row), tag, add } }
    }
    case 'delete': {
      if (typeof edit.sheet === 'string') {
        const entity = sheetByName(project, edit.sheet)
        if (entity === undefined) return { error: `no sheet called "${edit.sheet}"` }
        return { edit: { kind: 'delete', target: 'sheet', id: entity.id, name: entity.name } }
      }
      if (typeof edit.tag === 'string') {
        const tag = toTagName(edit.tag)
        const id = findTagByNameOrAlias(project.db, tag)
        if (id === undefined) return { error: `no tag #${tag}` }
        return { edit: { kind: 'delete', target: 'tag', id, name: tag } }
      }
      const row = nodeByRef(project, edit.id)
      if (!row?.parentId) return { error: 'not a deletable id' }
      return { edit: { kind: 'delete', target: 'node', id: row.id, name: nameOf(row) } }
    }
    case 'clear':
      return resolveClear(project, edit)
    case 'rename_tag':
      return resolveTagRename(project, edit)
    case 'rename_sheet':
    case 'recategorise':
      return resolveSheetPatch(project, edit, kind)
    case 'merge_sheets':
      return resolveSheetMerge(project, edit)
    case 'create_sheet':
      return resolveSheetCreate(project, edit)
    default:
      return { error: `unknown edit "${kind}"` }
  }
}

/** Whether a model's argument means "all of it": `"all"`, `true`, or `["all"]`. */
const meansAll = (value: unknown): boolean =>
  value === true ||
  (typeof value === 'string' && value.trim().toLowerCase() === 'all') ||
  (Array.isArray(value) && value.some((each) => meansAll(each)))

/** The names a model's argument lists: one string or an array of them. */
const namesIn = (value: unknown): string[] =>
  (Array.isArray(value) ? value : [value]).filter(
    (each): each is string => typeof each === 'string' && each.trim() !== ''
  )

/**
 * F-5.25 (agent.v7): a clear of the story bible, read leniently. `sheets` and `tags` are `"all"`
 * or names (a category's id, name, or singular, any case: "characters", "Places", "thread"; a tag
 * category's id or label); `library` and `notes` are true for all. The edit lists every kind the
 * project has, ticked where the request named it, so the author can tick more or fewer.
 */
function resolveClear(project: AgentProject, edit: Record<string, unknown>): ResolvedEdit {
  const categories = listCategories(project.db)
  const sheetIds = new Set<string>()
  for (const name of namesIn(edit.sheets)) {
    const key = name.trim().toLowerCase()
    const found =
      categoryArg(categories, key) ??
      categories.find(
        (c) => `${c.noun.toLowerCase()}s` === key || c.name.toLowerCase() === `${key}s`
      )
    if (found !== undefined) sheetIds.add(found.id)
  }
  const tagIds = new Set<TagCategory>()
  for (const name of namesIn(edit.tags)) {
    const key = name.trim().toLowerCase()
    const found = TAG_CATEGORIES.find(
      (c) => c.toLowerCase() === key || TAG_CATEGORY_LABEL[c].toLowerCase() === key
    )
    if (found !== undefined) tagIds.add(found)
  }
  const wanted: ClearWanted = {
    sheets: meansAll(edit.sheets) ? 'all' : sheetIds,
    tags: meansAll(edit.tags) ? 'all' : tagIds,
    library: meansAll(edit.library),
    notes: meansAll(edit.notes)
  }
  const options = clearOptions(project.db, wanted)
  if (options.length === 0) return { error: 'the story bible is already empty' }
  if (!options.some((option) => option.checked)) return { error: 'nothing of those kinds' }
  return { edit: { kind: 'clear', options } }
}

/** The manuscript's documents in reading order (the front and end matter left out). */
function manuscriptDocuments(project: AgentProject): NodeRow[] {
  // The project's rows leave the three section roots out (`nodesInTreeOrder`); read them here.
  const all = new Map(listNodes(project.db).map((row) => [row.id, row]))
  const sectionOf = (row: NodeRow): string | null => {
    let at: NodeRow | undefined = row
    while (at?.parentId) at = all.get(at.parentId)
    return at?.sectionType ?? null
  }
  return project.rows.filter((row) => isDocument(row) && sectionOf(row) === 'manuscript')
}

/** Whether `row` is `ancestor` or sits anywhere under it. */
function isUnder(project: AgentProject, row: NodeRow, ancestor: NodeRow): boolean {
  let at: NodeRow | undefined = row
  while (at !== undefined) {
    if (at.id === ancestor.id) return true
    at = at.parentId === null ? undefined : project.byId.get(at.parentId)
  }
  return false
}

/**
 * The documents a bulk tag names (F-5.25): `"all"` for every manuscript document, a folder's ref
 * for the documents under it, or a list of refs (a folder among them stands for its documents).
 */
function documentsNamed(project: AgentProject, ids: unknown): NodeRow[] | string {
  if (meansAll(ids)) return manuscriptDocuments(project)
  const refs: unknown[] = Array.isArray(ids) ? ids : [ids]
  const out = new Map<string, NodeRow>()
  for (const ref of refs) {
    const row = nodeByRef(project, ref)
    if (!row?.parentId) return `${str(ref) || 'an id'} is not in the binder`
    if (isDocument(row)) {
      out.set(row.id, row)
      continue
    }
    for (const doc of project.rows) {
      if (isDocument(doc) && isUnder(project, doc, row)) out.set(doc.id, doc)
    }
  }
  return [...out.values()]
}

/** F-5.25: `{"edit":"tag","ids","tag","add"}`, one tag on (or off) many documents at once. */
function resolveTagMany(project: AgentProject, edit: Record<string, unknown>): ResolvedEdit {
  const docs = documentsNamed(project, edit.ids)
  if (typeof docs === 'string') return { error: docs }
  const typed = toTagName(str(edit.tag))
  if (!typed) return { error: 'no "tag"' }
  const known = findTagByNameOrAlias(project.db, typed)
  const tag = known === undefined ? typed : (getTag(project.db, known)?.name ?? typed)
  const add = edit.add !== false
  if (!add && known === undefined) return { error: `no tag #${tag}` }
  // Only the documents it changes, so the card's count is what happens.
  const has = (row: NodeRow): boolean =>
    known !== undefined && listDocumentTags(project.db, row.id).some((t) => t.id === known)
  const changed = docs.filter((row) => (add ? !has(row) : has(row)))
  if (changed.length === 0) return { error: 'no document would change' }
  if (changed.length > AGENT_BULK_MAX) return { error: `more than ${AGENT_BULK_MAX} documents` }
  return {
    edit: {
      kind: 'tagMany',
      nodes: changed.map((row) => ({
        nodeId: row.id,
        title: project.titleOf(row.id) || row.title
      })),
      tag,
      add
    }
  }
}

/**
 * F-5.25: `{"edit":"move","ids":[…],"in"}` or `{"edit":"move","from","in"}` (every child of a
 * folder), many items to the end of one folder in the order given. Never a section, and never a
 * folder into itself or under itself.
 */
function resolveMoveMany(project: AgentProject, edit: Record<string, unknown>): ResolvedEdit {
  const parent = nodeByRef(project, edit.in)
  if (parent?.kind !== 'folder') return { error: '"in" is not a folder' }
  const rows: NodeRow[] = []
  if (edit.from !== undefined) {
    const from = nodeByRef(project, edit.from)
    if (from?.kind !== 'folder') return { error: '"from" is not a folder' }
    rows.push(...project.rows.filter((row) => row.parentId === from.id))
  } else {
    const refs: unknown[] = Array.isArray(edit.ids) ? edit.ids : [edit.ids]
    for (const ref of refs) {
      const row = nodeByRef(project, ref)
      if (!row?.parentId) return { error: `${str(ref) || 'an id'} is not a movable id` }
      if (!rows.includes(row)) rows.push(row)
    }
  }
  if (rows.some((row) => isUnder(project, parent, row))) {
    return { error: 'cannot move a folder into itself' }
  }
  if (rows.length === 0) return { error: 'nothing to move' }
  if (rows.length > AGENT_BULK_MAX) return { error: `more than ${AGENT_BULK_MAX} items` }
  const nameOf = (row: NodeRow): string => project.titleOf(row.id) || row.title
  return {
    edit: {
      kind: 'moveMany',
      nodes: rows.map((row) => ({ nodeId: row.id, title: nameOf(row) })),
      parentId: parent.id,
      parentTitle: nameOf(parent)
    }
  }
}

/** F-5.25: `{"edit":"rename_tag","tag","title"}`, through the tag bank's own rename. */
function resolveTagRename(project: AgentProject, edit: Record<string, unknown>): ResolvedEdit {
  const typed = toTagName(str(edit.tag))
  const id = findTagByNameOrAlias(project.db, typed)
  const held = id === undefined ? undefined : getTag(project.db, id)
  if (held === undefined) return { error: `no tag #${typed}` }
  const after = toTagName(str(edit.title))
  if (!after || after === held.name) return { error: 'no new name' }
  if (findTagByNameOrAlias(project.db, after) !== undefined) return { error: `#${after} exists` }
  return { edit: { kind: 'tagRename', tagId: held.id, name: held.name, after } }
}

/** The category a model's word names (id, name, singular, or plural; any case), or undefined. */
function categoryNamed(
  categories: readonly StoryCategory[],
  value: unknown
): StoryCategory | undefined {
  const key = str(value).trim().toLowerCase()
  if (key === '') return undefined
  return (
    categoryArg(categories, key) ??
    categories.find((c) => `${c.noun.toLowerCase()}s` === key || c.name.toLowerCase() === `${key}s`)
  )
}

const sameName = (a: string, b: string): boolean => toEntityNameKey(a) === toEntityNameKey(b)

/**
 * F-5.25: `{"edit":"rename_sheet","name","title"}` renames one sheet; `{"edit":"recategorise",
 * "sheets":[names] or "from","to"}` moves sheets (or a whole category's) into another category.
 */
function resolveSheetPatch(
  project: AgentProject,
  edit: Record<string, unknown>,
  kind: string
): ResolvedEdit {
  const categories = listCategories(project.db)
  if (kind === 'rename_sheet') {
    const sheet = sheetByName(project, edit.name)
    if (sheet === undefined) return { error: `no sheet called "${str(edit.name)}"` }
    const rename = text(edit.title, ENTITY_NAME_MAX)
    if (!rename || sameName(rename, sheet.name)) return { error: 'no new name' }
    const taken = project.entities.some(
      (e) => e.id !== sheet.id && e.kind === sheet.kind && sameName(e.name, rename)
    )
    if (taken) return { error: `a sheet called "${rename}" exists` }
    return {
      edit: {
        kind: 'sheetPatch',
        sheets: [{ entityId: sheet.id, name: sheet.name, kind: sheet.kind }],
        rename,
        to: null,
        toName: null
      }
    }
  }
  const to = categoryNamed(categories, edit.to)
  if (to === undefined) return { error: `no category "${str(edit.to)}"` }
  const sheets: Entity[] = []
  if (edit.from !== undefined) {
    const from = categoryNamed(categories, edit.from)
    if (from === undefined) return { error: `no category "${str(edit.from)}"` }
    sheets.push(...project.entities.filter((e) => e.kind === from.id))
  } else {
    for (const name of namesIn(edit.sheets)) {
      const sheet = sheetByName(project, name)
      if (sheet === undefined) return { error: `no sheet called "${name}"` }
      if (!sheets.includes(sheet)) sheets.push(sheet)
    }
  }
  const moving = sheets.filter((sheet) => sheet.kind !== to.id)
  if (moving.length === 0) return { error: 'no sheet would move' }
  if (moving.length > AGENT_BULK_MAX) return { error: `more than ${AGENT_BULK_MAX} sheets` }
  const clash = moving.find((sheet) =>
    project.entities.some((e) => e.kind === to.id && sameName(e.name, sheet.name))
  )
  if (clash !== undefined) return { error: `${to.name} already has a sheet called "${clash.name}"` }
  return {
    edit: {
      kind: 'sheetPatch',
      sheets: moving.map((sheet) => ({ entityId: sheet.id, name: sheet.name, kind: sheet.kind })),
      rename: null,
      to: to.id,
      toName: to.name
    }
  }
}

/** F-5.25: `{"edit":"merge_sheets","sheets":[names],"into"}`, the story bible's own merge. */
function resolveSheetMerge(project: AgentProject, edit: Record<string, unknown>): ResolvedEdit {
  const target = sheetByName(project, edit.into)
  if (target === undefined) return { error: `no sheet called "${str(edit.into)}"` }
  const sources: Entity[] = []
  for (const name of namesIn(edit.sheets)) {
    const sheet = sheetByName(project, name)
    if (sheet === undefined) return { error: `no sheet called "${name}"` }
    if (sheet.id !== target.id && !sources.includes(sheet)) sources.push(sheet)
  }
  if (sources.length === 0) return { error: 'nothing to merge' }
  if (sources.length > AGENT_BULK_MAX) return { error: `more than ${AGENT_BULK_MAX} sheets` }
  return {
    edit: {
      kind: 'sheetMerge',
      target: { id: target.id, name: target.name },
      sources: sources.map((sheet) => ({ id: sheet.id, name: sheet.name })),
      withText: sources.some((sheet) => !isEmptySheet(sheet))
    }
  }
}

/** F-5.25: `{"edit":"create_sheet","name","category"}`, a new empty sheet. */
function resolveSheetCreate(project: AgentProject, edit: Record<string, unknown>): ResolvedEdit {
  const category = categoryNamed(listCategories(project.db), edit.category)
  if (category === undefined) return { error: `no category "${str(edit.category)}"` }
  const name = text(edit.name, ENTITY_NAME_MAX)
  if (!name) return { error: 'no "name"' }
  const taken = project.entities.some((e) => e.kind === category.id && sameName(e.name, name))
  if (taken) return { error: `a sheet called "${name}" exists` }
  return {
    edit: { kind: 'sheetCreate', category: category.id, categoryName: category.noun, name }
  }
}
