import { and, asc, eq } from 'drizzle-orm'
import {
  AGENT_LOOKUP_CHARS,
  AGENT_PASSAGE_RESULTS,
  AGENT_RESULT_CHARS,
  type AgentStep,
  type AgentTool
} from '@shared/agent'
import { renderToolCard } from '@shared/memory/cardText'
import { markedParagraphs } from '@shared/memory/pageMarks'
import { normName } from '@shared/memory/names'
import { meaningOf, type MemorySource } from '@shared/memory/sources'
import type { StoryRecord, StoryRecordSummary } from '@shared/memory/records'
import { searchableText } from '@shared/search'
import type { TiptapNodeT } from '@shared/tiptap'
import { nameMention, sceneDetail } from '../db/schema'
import { listAuthorTodos } from '../memory/authorTodoStore'
import { promptCard } from '../memory/reading/cardContext'
import { sceneStatuses, searchMemoryPassages } from '../memory/passageIndexer'
import { getRecord, listRecords } from '../memory/recordStore'
import { getNode } from '../tree/treeStore'
import { nowIndex, readingIndex, sceneHead } from './agentRefs'
import type { AgentProject, ToolOutcome } from './agentTools'
import { headTruncate } from './context/chatContext'
import { positionNote } from './context/storyTime'

/**
 * The chat agent in a story memory v2 project (F-16.4, P1 slice 4): `agent.v8` runs unchanged
 * until P3, so the tools and edits it names that read or write tags and sheets are refused here
 * with one fixed result, and the reads that have a v2 source are re-pointed to it: `lookup` reads
 * a record (names, Pinned canon lines, Ideas, where the book names it, the scenes it is the POV
 * of, and since F-16.20 the v2 card of the last scene up to now that names it), `find_passages`
 * the labelled local passage index (`memory_passage_fts`), `todo` the author's own to-dos, and
 * `cards` finds a record's scenes by the name scan and reads their v2 cards (F-16.20).
 */

/** What every refused tool and edit answers in a v2 project. */
export const AGENT_V2_REFUSED =
  'not available in this project: names and records replaced tags and sheets; use lookup, cards, find_passages or read_scene'

/** The read tools a v2 run refuses (`AGENT_V2_REFUSED`). */
export const AGENT_V2_REFUSED_TOOLS: readonly AgentTool[] = ['tags', 'read_sheet', 'list_sheets']

/**
 * The edits a v2 run refuses: every write to tags, sheets, statuses, To do and summaries, and
 * the upload dialog (Research takes uploads). A `delete` of a sheet or a tag is refused by
 * `refusesV2Edit` too; a node deletion stays.
 */
export const AGENT_V2_REFUSED_EDITS = [
  'tag',
  'rename_tag',
  'sheet',
  'create_sheet',
  'merge_sheets',
  'rename_sheet',
  'recategorise',
  'status',
  'clear',
  'todo',
  'summaries',
  'open'
] as const

/** Whether a v2 run refuses the edit the model wrote. */
export function refusesV2Edit(edit: Record<string, unknown>): boolean {
  const kind = typeof edit.edit === 'string' ? edit.edit : ''
  if ((AGENT_V2_REFUSED_EDITS as readonly string[]).includes(kind)) return true
  return kind === 'delete' && (edit.sheet !== undefined || edit.tag !== undefined)
}

const cap = (text: string): string => headTruncate(text, AGENT_RESULT_CHARS)

/** The marks the v6 rules read: `[canon]` the story as written, `[plan]`, `[idea]` never real. */
export type V2Mark = '[canon]' | '[plan]' | '[idea]'

/** What a labelled passage reads as for the model, by where it is (design §2.2). */
export function passageMark(label: MemorySource): V2Mark {
  const meaning = meaningOf(label, { order: 0, openOrder: 0 })
  // A card line (F-16.18) is a map, never the book: the search leaves cards out unless asked
  // (`DEFAULT_PASSAGE_SOURCES`), and one that reaches here is never marked as canon.
  if (meaning === 'plan' || meaning === 'map') return '[plan]'
  if (meaning === 'never') return '[idea]'
  return '[canon]'
}

/** The run's records, read once. */
function recordsOf(project: AgentProject): StoryRecordSummary[] {
  project.records ??= listRecords(project.db)
  return project.records
}

/**
 * The record a name points at: one whose name or nickname is the name (after `normName`), else
 * the only one whose name holds it.
 */
export function recordByNameV2(
  project: AgentProject,
  name: unknown
): StoryRecordSummary | undefined {
  if (typeof name !== 'string') return undefined
  const norm = normName(name)
  if (norm === '') return undefined
  const records = recordsOf(project)
  const exact = records.filter((each) => each.aliases.some((alias) => alias.norm === norm))
  if (exact.length === 1) return exact[0]
  const main = exact.find((each) => normName(each.name) === norm)
  if (main !== undefined) return main
  const partial = records.filter((each) => normName(each.name).includes(norm))
  return partial.length === 1 ? partial[0] : undefined
}

/**
 * The scenes of the run that name a record for certain, in reading order, with the paragraphs;
 * `real` is false for an Idea scene or one left out of compile (design §2.2: never real).
 */
export function scenesNaming(
  project: AgentProject,
  recordId: string
): { nodeId: string; paras: number[]; real: boolean }[] {
  const rows = project.db
    .select({ nodeId: nameMention.nodeId, para: nameMention.para })
    .from(nameMention)
    .where(and(eq(nameMention.recordId, recordId), eq(nameMention.ambiguous, false)))
    .orderBy(asc(nameMention.para))
    .all()
  const byScene = new Map<string, number[]>()
  for (const row of rows) {
    if (!project.refOf.has(row.nodeId)) continue
    const paras = byScene.get(row.nodeId) ?? []
    if (!paras.includes(row.para)) paras.push(row.para)
    byScene.set(row.nodeId, paras)
  }
  const statuses = sceneStatuses(project.db)
  return [...byScene.entries()]
    .map(([nodeId, paras]) => ({
      nodeId,
      paras,
      real: !statuses.idea.has(nodeId) && !statuses.excluded.has(nodeId)
    }))
    .filter((each) => readingIndex(project, each.nodeId) < project.time.order.length)
    .sort((a, b) => readingIndex(project, a.nodeId) - readingIndex(project, b.nodeId))
}

/** A page's paragraphs the author did not mark Not canon, joined; '' for none. */
function canonText(page: TiptapNodeT | null): string {
  if (page === null) return ''
  return markedParagraphs(page)
    .filter((paragraph) => !paragraph.notCanon)
    .map((paragraph) => paragraph.text.trim())
    .filter((text) => text !== '')
    .join(' / ')
}

/** Every paragraph of a page (Ideas are never canon, marked or not), joined; '' for none. */
function allText(page: TiptapNodeT | null): string {
  if (page === null) return ''
  return markedParagraphs(page)
    .map((paragraph) => paragraph.text.trim())
    .filter((text) => text !== '')
    .join(' / ')
}

/** The scenes the record is the typed POV of, with their typed place and time, in reading order. */
function povLines(project: AgentProject, record: StoryRecord): string {
  const rows = project.db
    .select()
    .from(sceneDetail)
    .where(eq(sceneDetail.povRecordId, record.id))
    .all()
    .filter((row) => project.refOf.has(row.nodeId))
    .sort((a, b) => readingIndex(project, a.nodeId) - readingIndex(project, b.nodeId))
  if (rows.length === 0) return ''
  const names = new Map(recordsOf(project).map((each) => [each.id, each.name]))
  return `POV in: ${rows
    .map((row) => {
      const place =
        row.placeRecordId === null ? row.placeText.trim() : (names.get(row.placeRecordId) ?? '')
      const details = [
        place === '' ? '' : `place: ${place}`,
        row.timeText.trim() === '' ? '' : `time: ${row.timeText.trim()}`,
        row.storyYear === null ? '' : `year: ${row.storyYear}`
      ].filter((part) => part !== '')
      const ref = project.refOf.get(row.nodeId) ?? '?'
      return details.length === 0 ? ref : `${ref} (${details.join(', ')})`
    })
    .join('; ')}`
}

/**
 * `lookup` in v2 (at most `AGENT_LOOKUP_CHARS`): the record's name, category and other names;
 * its Pinned canon paragraphs `[canon]` (Not canon ones left out); its Ideas `[idea]`; the scenes
 * it is the POV of, with their typed details; and where the book names it (first and last, with
 * the paragraph). A name no record answers says what to try instead.
 */
export function lookupV2(project: AgentProject, nameArg: unknown): ToolOutcome {
  const name = typeof nameArg === 'string' ? nameArg.trim() : ''
  const step: AgentStep = {
    tool: 'lookup',
    label: name === '' ? 'Looking up a name…' : `Looking up ${headTruncate(name, 60)}…`
  }
  if (name === '') return { step, result: 'lookup needs a "name".' }
  const summary = recordByNameV2(project, name)
  const record = summary === undefined ? null : getRecord(project.db, summary.id)
  if (record === null) {
    return {
      step,
      result: `No record is called "${name}". Try find_passages for the words, or read_scene.`
    }
  }
  const nowRef = project.time.nowId === null ? undefined : project.refOf.get(project.time.nowId)
  const others = record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text)
  const lines = [
    `${record.name} (${record.kind})` +
      (others.length > 0 ? `; also ${others.join(', ')}` : '') +
      (nowRef === undefined ? '; as of the end of the book' : `; as of ${nowRef} (now)`)
  ]
  const pinned = canonText(record.pinned)
  if (pinned !== '') lines.push(`Pinned [canon]: ${pinned}`)
  const ideas = allText(record.ideas)
  if (ideas !== '') lines.push(`Ideas [idea]: ${ideas}`)
  const pov = povLines(project, record)
  if (pov !== '') lines.push(pov)
  const naming = scenesNaming(project, record.id)
  const named = naming.filter((each) => each.real)
  if (named.length === 0) {
    lines.push('Named in no scene of the book yet.')
  } else {
    const now = nowIndex(project)
    const first = named[0]!
    const last = named.at(-1)!
    const upToNow = named.filter((each) => readingIndex(project, each.nodeId) <= now).length
    const where = (each: { nodeId: string; paras: number[] }, end: boolean): string => {
      const para = end ? each.paras.at(-1) : each.paras[0]
      return `${project.refOf.get(each.nodeId) ?? '?'}${para === undefined ? '' : ` ¶${para}`}`
    }
    lines.push(
      `Named in ${named.length} scene${named.length === 1 ? '' : 's'} (${upToNow} up to now): ` +
        `first ${where(first, false)}, last ${where(last, true)}`
    )
    // F-16.20: the card of the last scene up to now that names it (a map, never quoted).
    const seen = [...named].reverse().find((each) => readingIndex(project, each.nodeId) <= now)
    const card = seen === undefined ? null : promptCard(project.db, seen.nodeId)
    if (seen !== undefined && card !== null) {
      lines.push(renderToolCard(`Last seen ${sceneHead(project, seen.nodeId)}:`, card))
    }
  }
  const unreal = naming.filter((each) => !each.real)
  if (unreal.length > 0) {
    lines.push(
      `[idea] Also named in Idea or left-out scenes (never happened): ${unreal
        .map((each) => project.refOf.get(each.nodeId) ?? '?')
        .join(', ')}`
    )
  }
  return { step, result: headTruncate(lines.join('\n'), AGENT_LOOKUP_CHARS) }
}

/** Where a passage hit is, as the model reads it: a scene ref, a record's page, a Research page. */
function hitPlace(
  project: AgentProject,
  hit: ReturnType<typeof searchMemoryPassages>[number]
): string | null {
  switch (hit.source) {
    case 'scene':
    case 'ideaScene':
    case 'excludedScene':
    case 'sceneNote': {
      const ref = project.refOf.get(hit.ownerId)
      if (ref === undefined) return null
      // Only the book's own scenes sit before or after now; the rest never happened (§2.2).
      if (hit.source === 'scene') {
        return `${ref} ¶${hit.para} (${positionNote(project.time, hit.ownerId)})`
      }
      if (hit.source === 'sceneNote') return `${ref} notes ¶${hit.para} (notes for ${ref}: a plan)`
      const what = hit.source === 'ideaScene' ? 'an Idea scene' : 'left out of the book'
      return `${ref} ¶${hit.para} (${what}: never happened)`
    }
    case 'pinned':
    case 'idea': {
      const record = recordsOf(project).find((each) => each.id === hit.ownerId)
      if (record === undefined) return null
      return `${record.name}'s ${hit.source === 'pinned' ? 'Pinned' : 'Ideas'} ¶${hit.para}`
    }
    case 'note':
    case 'research': {
      const row = getNode(project.db, hit.ownerId)
      if (row === undefined) return null
      return `Research "${searchableText(row.title)}" ¶${hit.para}`
    }
    // A card line (F-16.18) is a map, never a passage to cite: the default search leaves it
    // out, and one that reaches here is not listed.
    case 'card':
      return null
  }
}

/**
 * `find_passages` in v2: the best matches in the local passage index (manuscript, scene notes,
 * Pinned, Ideas, Research; at most `AGENT_PASSAGE_RESULTS`), each marked by what it means: the
 * book, Pinned, notes and Research `[canon]`, scene notes `[plan]`, Ideas, Idea scenes and Not
 * canon text `[idea]`. Research is reached only here, labelled, before P3's own tools.
 */
export function findPassagesV2(project: AgentProject, query: string): ToolOutcome {
  const step: AgentStep = { tool: 'find_passages', label: 'Finding passages…' }
  if (query.trim() === '') return { step, result: 'find_passages needs a "query".' }
  const lines = searchMemoryPassages(project.db, query, { limit: AGENT_PASSAGE_RESULTS * 2 })
    .flatMap((hit) => {
      const place = hitPlace(project, hit)
      if (place === null) return []
      return [`${place} ${passageMark(hit.label)}: ${hit.snippet.replace(/\s+/g, ' ').trim()}`]
    })
    .slice(0, AGENT_PASSAGE_RESULTS)
  if (lines.length === 0) {
    return { step, result: 'No passage matches. Try other words, or look the name up.' }
  }
  return { step, result: cap(lines.join('\n')) }
}

/** The most to-dos one `todo` call lists in v2. */
export const AGENT_V2_TODO_ITEMS = 30

/**
 * `todo` in v2: the author's own open to-dos in her order, `- text (n3; Mara)`, then how many are
 * done. They are hers: the agent reports them and never ticks one (the settle edit is refused).
 */
export function todoV2(project: AgentProject): string {
  const todos = listAuthorTodos(project.db)
  const open = todos.filter((todo) => !todo.done)
  const done = todos.length - open.length
  if (open.length === 0) {
    return done === 0
      ? 'The author has no to-dos.'
      : `The author has no open to-dos (${done} done).`
  }
  const names = new Map(recordsOf(project).map((each) => [each.id, each.name]))
  const lines = open.slice(0, AGENT_V2_TODO_ITEMS).map((todo) => {
    const links = [
      todo.nodeId === null ? undefined : project.refOf.get(todo.nodeId),
      todo.recordId === null ? undefined : names.get(todo.recordId)
    ].filter((link): link is string => link !== undefined)
    return `- ${todo.text}${links.length === 0 ? '' : ` (${links.join('; ')})`}`
  })
  const more =
    open.length > AGENT_V2_TODO_ITEMS ? `\n…and ${open.length - AGENT_V2_TODO_ITEMS} more.` : ''
  const tail = done === 0 ? '' : `\n(${done} done.)`
  return cap(`The author's to-dos:\n${lines.join('\n')}${more}${tail}`)
}
