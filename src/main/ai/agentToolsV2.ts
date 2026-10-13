import {
  AGENT_LOOKUP_CHARS,
  AGENT_PASSAGE_RESULTS,
  AGENT_RESULT_CHARS,
  type AgentStep,
  type AgentTool
} from '@shared/agent'
import { CARD_MAP_NOTE, renderToolCard } from '@shared/memory/cardText'
import { searchableText } from '@shared/search'
import { listAuthorTodos } from '../memory/authorTodoStore'
import { promptCard } from '../memory/reading/cardContext'
import { searchMemoryPassages } from '../memory/passageIndexer'
import { getRecord } from '../memory/recordStore'
import {
  passageMark,
  recordByNameV2,
  recordsOf,
  recordState,
  type RecordState
} from '../scribe/tools'
import { getNode } from '../tree/treeStore'
import { sceneHead } from './agentRefs'
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
 * `cards` finds a record's scenes by the name scan and reads their v2 cards (F-16.20). Since P3
 * slice 4 the story-memory reads these use (the record a name points at, the scenes naming it,
 * a record's state) live with Ms Scribe's navigator tools (`scribe/tools.ts`, P3-D18); this file
 * renders them for agent.v8 until the switch-over (F-16.31).
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

/** What a v2 tool says of an Idea or left-out scene in a card's place. */
export const UNREAL_SCENE_NOTE =
  '[idea] An Idea scene or one left out of the book (never happened): it has no card.'

/** The POV scenes' line: "POV in: 1.1 (place: the quay, time: dusk, year: 1814); 1.2". */
function povLines(project: AgentProject, state: RecordState): string {
  if (state.pov.length === 0) return ''
  return `POV in: ${state.pov
    .map((row) => {
      const details = [
        row.place === '' ? '' : `place: ${row.place}`,
        row.time === '' ? '' : `time: ${row.time}`,
        row.year === null ? '' : `year: ${row.year}`
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
 * the paragraph). A name no record answers says what to try instead. The record is read once
 * (`recordState`, shared with the navigator's `state`, P3-D18).
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
  const state = recordState(project, record)
  const nowRef = project.time.nowId === null ? undefined : project.refOf.get(project.time.nowId)
  const lines = [
    `${record.name} (${record.kind})` +
      (state.others.length > 0 ? `; also ${state.others.join(', ')}` : '') +
      (nowRef === undefined ? '; as of the end of the book' : `; as of ${nowRef} (now)`)
  ]
  const pinned = state.pinned
    .filter((paragraph) => !paragraph.notCanon)
    .map((paragraph) => paragraph.text)
    .join(' / ')
  if (pinned !== '') lines.push(`Pinned [canon]: ${pinned}`)
  const ideas = state.ideas.map((paragraph) => paragraph.text).join(' / ')
  if (ideas !== '') lines.push(`Ideas [idea]: ${ideas}`)
  const pov = povLines(project, state)
  if (pov !== '') lines.push(pov)
  const named = state.named
  if (named.length === 0) {
    lines.push('Named in no scene of the book yet.')
  } else {
    const first = named[0]!
    const last = named.at(-1)!
    const where = (each: { nodeId: string; paras: number[] }, end: boolean): string => {
      const para = end ? each.paras.at(-1) : each.paras[0]
      return `${project.refOf.get(each.nodeId) ?? '?'}${para === undefined ? '' : ` ¶${para}`}`
    }
    lines.push(
      `Named in ${named.length} scene${named.length === 1 ? '' : 's'} (${state.upToNow} up to now): ` +
        `first ${where(first, false)}, last ${where(last, true)}`
    )
    // F-16.20: the card of the last scene up to now where it is Here (the POV, on the page by a
    // verified quote, or + also here): a map, never quoted. A scene that only names it says
    // nothing of where it was, so only its line is given, with no place, time or POV.
    const seenCard = state.seen === null ? null : promptCard(project.db, state.seen)
    if (state.seen !== null && seenCard !== null) {
      lines.push(renderToolCard(`Last seen ${sceneHead(project, state.seen)}:`, seenCard))
    }
    const namedCard = state.lastNamed === null ? null : promptCard(project.db, state.lastNamed)
    if (state.lastNamed !== null && namedCard !== null) {
      lines.push(
        `Last named in ${sceneHead(project, state.lastNamed)} (not Here there):\n` +
          `Map (${CARD_MAP_NOTE}): ${namedCard.line.trim()}`
      )
    }
  }
  if (state.unreal.length > 0) {
    lines.push(
      `[idea] Also named in Idea or left-out scenes (never happened): ${state.unreal
        .map((nodeId) => project.refOf.get(nodeId) ?? '?')
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
