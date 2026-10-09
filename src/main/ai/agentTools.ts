import {
  AGENT_BRIEF_MAX,
  AGENT_EDIT_TEXT_MAX,
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
import { toEntityNameKey } from '@shared/entities'
import { FACT_STATUS_LABEL, sheetAt } from '@shared/facts'
import type { Entity } from '@shared/ipc/contract'
import { SCENE_SYNOPSIS_MAX, parseStoredSceneMeta } from '@shared/sceneMeta'
import { STORY_MAP_NOW_MARK, sceneProgress } from '@shared/storyTime'
import { TAG_CATEGORIES, TAG_CATEGORY_LABEL, toTagName } from '@shared/tags'
import { TODO_KINDS, TODO_KIND_NOUN, TodoKind } from '@shared/todo'
import type { NodeRow } from '../db/schema'
import { getSummary } from '../document/summaryStore'
import { listCategories } from '../entity/categoryStore'
import { listEntities } from '../entity/entityStore'
import { factsForEntities } from '../entity/factStore'
import { nodesInTreeOrder } from '../search/searchStore'
import { findTagByNameOrAlias, getTag, listTags } from '../tag/tagStore'
import { listNodes, type TreeDb } from '../tree/treeStore'
import { listTodo } from '../knowledge/todoStore'
import { documentText } from '../voice/profile'
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
 * F-5.23: what a lookup says about where its source sits in story time. Sheets, notes, and
 * synopses are the author's plans; a scene is before now, now, or after now.
 */
export const NOTES_ARE_PLANS =
  "the author's plans for this document: an event told only here has not happened yet"
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
  args: Record<string, unknown>
): ToolOutcome {
  const tool = AgentTool.safeParse(name)
  if (!tool.success) {
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
      return readScene(project, args.id, args.from)
    case 'read_notes':
      return readNotes(project, args.id)
    case 'read_summary':
      return readSummary(project, args.id)
    case 'read_sheet':
      return readSheet(project, args.name)
    case 'list_sheets':
      return listSheets(project, str(args.kind))
    case 'tags':
      return { step: { tool: 'tags', label: 'Reading the tags…' }, result: tags(project) }
    case 'todo':
      return {
        step: { tool: 'todo', label: 'Reading the To do list…' },
        result: todo(project, args.kind)
      }
  }
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

function readScene(project: AgentProject, ref: unknown, fromArg: unknown): ToolOutcome {
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

function readNotes(project: AgentProject, ref: unknown): ToolOutcome {
  const found = documentFor(project, ref)
  if ('error' in found) {
    return { step: { tool: 'read_notes', label: 'Looking for notes…' }, result: found.error }
  }
  const { row, title } = found
  const synopsis = parseStoredSceneMeta(row.sceneMeta).synopsis.trim()
  const notes = notesText(row.notes, row.id)
  const parts = [
    `${title} (${NOTES_ARE_PLANS}):`,
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
  const lines = [`${entity.name} (${entity.kind}; ${SHEETS_ARE_PLANS})`]
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
      const status = value.status === 'canon' ? '' : ` [${FACT_STATUS_LABEL[value.status]}]`
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
    default:
      return { error: `unknown edit "${kind}"` }
  }
}
