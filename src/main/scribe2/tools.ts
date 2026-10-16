import { docToText } from '@shared/docText'
import { NOTEBOOK_TITLE_MAX, notebookDocFromText, notebookPlain } from '@shared/notebook'
import {
  layoutOnTemplate,
  myTemplatePages,
  templateDoc,
  templateForFolder,
  type TemplateLayout
} from '@shared/notebookTemplates'
import {
  SCRIBE_DIFF_CHARS,
  SCRIBE_MAX_WRITES,
  SCRIBE_NOTE_TEXT_MAX,
  SCRIBE_READ_CHARS,
  SCRIBE_SEARCH_RESULTS,
  SCRIBE_TOOLS,
  type ScribeAccess,
  type ScribeTool
} from '@shared/scribe2'
import type { AgentEdit, AgentStep } from '@shared/agent'
import type { TiptapNodeT } from '@shared/tiptap'
import { AppError } from '../ipc/errors'
import {
  createNotebookItem,
  getNotebookPage,
  listNotebook,
  updateNotebookItem
} from '../notebook/notebookStore'
import { searchPassages } from '../search/passageIndex'
import type { TreeDb } from '../tree/treeStore'
import { documentText, type VoiceProfile } from '../voice/profile'
import { offerEdit, type AgentProposal } from '../ai/agent'
import { nodeByRef, type AgentProject, type ToolOutcome } from '../ai/agentTools'
import { headTruncate } from '../ai/context/chatContext'
import type { ScribePage, ScribeScene } from './context'

/**
 * Ms Scribe's tools in a story memory v1 project (notes redesign phase 1, `scribe.v1`). The read
 * tools search the book, read a scene, list and read the pages. The write tools are the mode's
 * (`ScribeAccess`): `edit_note` and `create_note` write the notebook at once through its store
 * (Ms Scribe's write keeps the page as it was, which the chat's Undo restores), and
 * `propose_prose_edit` only offers a change to the book, resolved and voice-checked as the chat
 * agent's are, for the author to accept. A tool never throws for the model's mistakes.
 */

/** One run's state: what she may do, what she wrote, what she read. */
export interface ScribeRun {
  db: TreeDb
  project: AgentProject
  pages: ScribePage[]
  scenes: ScribeScene[]
  access: ScribeAccess
  /** Prose suggestions this message may make (`scribeProseMax`: three in Vibe). */
  proseMax: number
  profile: VoiceProfile | null
  /** Note edits applied (already in the notebook) and prose suggestions offered, in order. */
  changes: { proposal: AgentProposal; applied: boolean }[]
  /** Scenes and pages she opened or edited (their ids), for the answer's sources. */
  used: Set<string>
  /** Told after every notebook write, with the ids written (`notebook:changed`). */
  notebookChanged: (ids: string[]) => void
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

const isTool = (name: unknown): name is ScribeTool =>
  typeof name === 'string' && (SCRIBE_TOOLS as readonly string[]).includes(name)

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

/** The page a ref (`p2`, `P2`, `2`) or an exact title names, or undefined. */
export function pageByRef(run: ScribeRun, ref: unknown): ScribePage | undefined {
  const key = str(ref).trim().toLowerCase()
  if (key === '') return undefined
  const asRef = /^\d+$/.test(key) ? `p${key}` : key
  return (
    run.pages.find((page) => page.ref === asRef) ??
    run.pages.find((page) => page.title.trim().toLowerCase() === key)
  )
}

/** The changed stretch of a page, with a little around it, cut to `SCRIBE_DIFF_CHARS` each side. */
export function diffWindow(before: string, after: string): { before: string; after: string } {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let end = 0
  while (
    end < before.length - start &&
    end < after.length - start &&
    before[before.length - 1 - end] === after[after.length - 1 - end]
  ) {
    end++
  }
  const from = Math.max(0, start - 120)
  const cut = (text: string): string => {
    const piece = text.slice(from, Math.max(from, text.length - Math.max(0, end - 120)))
    return piece.length > SCRIBE_DIFF_CHARS ? `${piece.slice(0, SCRIBE_DIFF_CHARS - 1)}…` : piece
  }
  return { before: cut(before), after: cut(after) }
}

const blockText = (block: TiptapNodeT): string => docToText({ type: 'doc', content: [block] })

/** "## Powers:" and "powers" name the same line. */
const lineKey = (text: string): string =>
  flat(text)
    .replace(/^#+\s*/, '')
    .replace(/[:：]\s*$/, '')
    .toLowerCase()

/**
 * The top-level blocks of a section: from the block whose text is `section` to the next heading
 * of its level or higher (a heading), or to the next empty paragraph or heading (a plain line).
 * Null when no block reads as `section`.
 */
export function sectionRange(
  blocks: readonly TiptapNodeT[],
  section: string
): { start: number; end: number } | null {
  const key = lineKey(section)
  if (key === '') return null
  const start = blocks.findIndex((block) => lineKey(blockText(block)) === key)
  if (start < 0) return null
  const head = blocks[start]
  const level = head?.type === 'heading' ? Number(head.attrs?.level ?? 1) : null
  let end = start + 1
  for (; end < blocks.length; end++) {
    const block = blocks[end]
    if (block === undefined) break
    if (block.type === 'heading') {
      if (level === null || Number(block.attrs?.level ?? 1) <= level) break
    } else if (level === null && blockText(block).trim() === '') {
      break
    }
  }
  return { start, end }
}

/** A page's new content for one `edit_note`: whole, a section, or appended. */
export function editedContent(
  content: TiptapNodeT | null,
  text: string,
  section: string | null,
  append: boolean
): TiptapNodeT | { error: string } {
  const blocks = content?.content ?? []
  const added = notebookDocFromText(text).content ?? []
  if (section === null) {
    if (!append) return notebookDocFromText(text)
    return { type: 'doc', content: [...blocks, ...added] }
  }
  const range = sectionRange(blocks, section)
  if (range === null) return { error: `No line reads “${section}” on that page; read it again.` }
  const next = append
    ? [...blocks.slice(0, range.end), ...added, ...blocks.slice(range.end)]
    : [...blocks.slice(0, range.start + 1), ...added, ...blocks.slice(range.end)]
  return { type: 'doc', content: next }
}

function searchBook(run: ScribeRun, query: string): ToolOutcome {
  const step: AgentStep = { tool: 'search_book', label: `Searching “${headTruncate(query, 80)}”…` }
  if (query.trim() === '') return { step, result: 'search_book needs a "query".' }
  const byId = new Map(run.scenes.map((scene) => [scene.nodeId, scene]))
  const hits = searchPassages(run.db, query, SCRIBE_SEARCH_RESULTS).filter((hit) =>
    byId.has(hit.nodeId)
  )
  if (hits.length === 0) return { step, result: 'No passage matches. Try other words.' }
  const lines = hits.map((hit) => {
    const scene = byId.get(hit.nodeId)
    return `${scene?.ref ?? '?'} ${scene?.title ?? ''} ¶${hit.para}: ${flat(hit.snippet)}`
  })
  return { step, result: lines.join('\n') }
}

function openScene(run: ScribeRun, ref: unknown, fromArg: unknown): ToolOutcome {
  const row = nodeByRef(run.project, ref)
  const scene = row === undefined ? undefined : run.scenes.find((s) => s.nodeId === row.id)
  if (row?.kind !== 'document') {
    return {
      step: { tool: 'open_scene', label: 'Looking for a scene…' },
      result: `${str(ref) || 'That'} is not a scene; see the book map.`
    }
  }
  const title = scene?.title ?? (run.project.titleOf(row.id) || row.title)
  const step: AgentStep = { tool: 'open_scene', label: `Reading ${title}…` }
  run.used.add(row.id)
  const text = scene?.text ?? documentText(row)
  if (text.trim() === '') return { step, result: `${title} is empty.` }
  const from = Math.max(
    0,
    Math.min(typeof fromArg === 'number' ? Math.floor(fromArg) : 0, text.length)
  )
  const to = Math.min(text.length, from + SCRIBE_READ_CHARS)
  const more = to < text.length ? `\n(continues; read on with "from":${to})` : ''
  return {
    step,
    result: `${str(ref)} ${title}, characters ${from}–${to} of ${text.length}:\n${text.slice(from, to)}${more}`
  }
}

/**
 * The author's own templates (note templates, phase 6): page shapes in a Templates folder, never
 * story notes, so they are not among her pages; `list_notes` names them on one line and `open_note`
 * reads one by its title.
 */
function templatesLine(run: ScribeRun): string | null {
  const titles = myTemplatePages(listNotebook(run.db)).map((page) => page.title)
  return titles.length === 0
    ? null
    : `Templates (page shapes, not story notes; open_note by title): ${titles.join(', ')}`
}

function listNotes(run: ScribeRun): ToolOutcome {
  const step: AgentStep = { tool: 'list_notes', label: 'Listing the notes…' }
  const templates = templatesLine(run)
  if (run.pages.length === 0) {
    return {
      step,
      result: ['There are no note pages yet.', ...(templates === null ? [] : [templates])].join(
        '\n'
      )
    }
  }
  const lines = run.pages.map((page) => {
    const kind =
      page.kind === 'note'
        ? 'note'
        : page.kind === 'sheet'
          ? 'sheet, read-only'
          : 'upload, read-only'
    const words = page.text.split(/\s+/).filter(Boolean).length
    return `${page.ref} ${page.title} (${kind}${page.folder === '' ? '' : `, ${page.folder}`}, ${words} words)`
  })
  if (templates !== null) lines.push(templates)
  return { step, result: lines.join('\n') }
}

/** One of the author's templates by its title (caseless), read whole, or null. */
function openTemplate(run: ScribeRun, ref: unknown, fromArg: unknown): ToolOutcome | null {
  const key = flat(str(ref)).toLowerCase()
  if (key === '') return null
  const found = myTemplatePages(listNotebook(run.db)).find(
    (page) => page.title.trim().toLowerCase() === key
  )
  if (found === undefined) return null
  const step: AgentStep = { tool: 'open_note', label: `Reading the template ${found.title}…` }
  const text = getNotebookPage(run.db, found.id).plain
  const from = Math.max(
    0,
    Math.min(typeof fromArg === 'number' ? Math.floor(fromArg) : 0, text.length)
  )
  const to = Math.min(text.length, from + SCRIBE_READ_CHARS)
  const more = to < text.length ? `\n(continues; read on with "from":${to})` : ''
  return {
    step,
    result: `Template ${found.title} (a page shape, not story notes):\n${text.slice(from, to) || '(empty)'}${more}`
  }
}

function openNote(run: ScribeRun, ref: unknown, fromArg: unknown): ToolOutcome {
  const page = pageByRef(run, ref)
  if (page === undefined) {
    const template = openTemplate(run, ref, fromArg)
    if (template !== null) return template
    return {
      step: { tool: 'open_note', label: 'Looking for a page…' },
      result: `No page is ${str(ref) || 'that'}; list the notes.`
    }
  }
  run.used.add(page.id)
  const step: AgentStep = { tool: 'open_note', label: `Reading ${page.title}…` }
  const text = page.text
  const from = Math.max(
    0,
    Math.min(typeof fromArg === 'number' ? Math.floor(fromArg) : 0, text.length)
  )
  const to = Math.min(text.length, from + SCRIBE_READ_CHARS)
  const more = to < text.length ? `\n(continues; read on with "from":${to})` : ''
  return { step, result: `${page.ref} ${page.title}:\n${text.slice(from, to) || '(empty)'}${more}` }
}

function writesLeft(run: ScribeRun): boolean {
  return run.changes.length < SCRIBE_MAX_WRITES
}

function notebookEdit(
  pageId: string,
  title: string,
  created: boolean,
  versionId: string | null,
  section: string | null,
  before: string,
  after: string
): AgentEdit {
  const window = diffWindow(before, after)
  return {
    kind: 'notebook',
    pageId,
    title,
    created,
    versionId,
    section,
    before: window.before,
    after: window.after
  }
}

function editNote(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const page = pageByRef(run, args.id)
  const step: AgentStep = {
    tool: 'edit_note',
    label: page === undefined ? 'Editing a note…' : `Editing ${page.title}…`
  }
  if (page === undefined)
    return { step, result: `No page is ${str(args.id) || 'that'}; list the notes.` }
  if (page.kind !== 'note') {
    return { step, result: `${page.title} is read-only; put it in a note page (create_note).` }
  }
  if (!writesLeft(run)) return { step, result: 'No more writes in this message.' }
  const text = str(args.text).slice(0, SCRIBE_NOTE_TEXT_MAX)
  const section = str(args.section).trim() || null
  const append = args.append === true
  if (text.trim() === '' && (append || section === null)) {
    return { step, result: 'edit_note needs the "text" to write.' }
  }
  try {
    const current = getNotebookPage(run.db, page.id)
    const content = editedContent(current.content, text, section, append)
    if ('error' in content) return { step, result: content.error }
    if (notebookPlain(content) === current.plain) return { step, result: 'Nothing changed.' }
    const { page: written, versionId } = updateNotebookItem(run.db, { id: page.id, content }, 'ai')
    run.notebookChanged([page.id])
    run.used.add(page.id)
    page.text = written.plain
    run.changes.push({
      proposal: {
        edit: notebookEdit(
          page.id,
          page.title,
          false,
          versionId,
          section,
          current.plain,
          written.plain
        ),
        violation: null
      },
      applied: true
    })
    return { step, result: `Edited ${page.ref} ${page.title}.` }
  } catch (err) {
    if (err instanceof AppError) return { step, result: err.message }
    throw err
  }
}

function templateNote(ref: string, name: string, laid: TemplateLayout): string {
  const filled = laid.filled.length === 0 ? 'none' : laid.filled.join(', ')
  const empty =
    laid.empty.length === 0
      ? ''
      : ` Empty: ${laid.empty.join(', ')}; fill what you know with edit_note {"id":"${ref}","section":"<section>","text":"…"}, leave the rest empty.`
  return ` Laid out on the ${name} template; sections filled: ${filled}.${empty}`
}

function createNote(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const title = flat(str(args.title)).slice(0, NOTEBOOK_TITLE_MAX)
  const step: AgentStep = { tool: 'create_note', label: `Making the note ${title || 'page'}…` }
  if (title === '') return { step, result: 'create_note needs a "title".' }
  if (!writesLeft(run)) return { step, result: 'No more writes in this message.' }
  const text = str(args.text).slice(0, SCRIBE_NOTE_TEXT_MAX)
  const folderName = flat(str(args.folder)).toLowerCase()
  const items = listNotebook(run.db)
  const folder =
    folderName === ''
      ? undefined
      : items.find(
          (item) => item.kind === 'folder' && item.title.trim().toLowerCase() === folderName
        )
  try {
    // Note templates (phase 6): a page in a folder with a template follows its sections.
    const shape = folder === undefined ? null : templateForFolder(items, folder.id)
    const laid =
      shape === null
        ? null
        : layoutOnTemplate(
            shape.kind === 'builtIn'
              ? templateDoc(shape.template)
              : getNotebookPage(run.db, shape.pageId).content,
            text
          )
    const shapeName =
      shape === null ? '' : shape.kind === 'builtIn' ? shape.template.name : shape.name
    const page = createNotebookItem(run.db, {
      parentId: folder?.id ?? null,
      kind: 'page',
      title,
      content: laid !== null ? laid.content : text.trim() === '' ? null : notebookDocFromText(text)
    })
    run.notebookChanged([page.id])
    run.used.add(page.id)
    const ref = `p${run.pages.length + 1}`
    run.pages.push({
      ref,
      id: page.id,
      kind: 'note',
      title: page.title,
      folder: folder?.title ?? '',
      text: page.plain
    })
    run.changes.push({
      proposal: {
        edit: notebookEdit(page.id, page.title, true, null, null, '', page.plain),
        violation: null
      },
      applied: true
    })
    const where =
      folder === undefined
        ? folderName === ''
          ? ''
          : ' (no such folder; made at the top)'
        : ` in ${folder.title}`
    return {
      step,
      result: `Created ${ref} ${page.title}${where}.${laid === null ? '' : templateNote(ref, shapeName, laid)}`
    }
  } catch (err) {
    if (err instanceof AppError) return { step, result: err.message }
    throw err
  }
}

function proposeProse(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'propose_prose_edit', label: 'Suggesting a change…' }
  if (!writesLeft(run)) return { step, result: 'No more suggestions in this message.' }
  const offeredSoFar = run.changes.filter((change) => change.proposal.edit.kind !== 'notebook')
  if (offeredSoFar.length >= run.proseMax) {
    return {
      step,
      result: `No more prose suggestions in this message (at most ${run.proseMax}); answer now.`
    }
  }
  const replace = str(args.replace)
  const offered = offerEdit(
    run.project,
    { edit: 'text', id: args.id, find: args.find, replace },
    run.profile
  )
  if ('error' in offered) return { step, result: `Not offered: ${offered.error}.` }
  if (offered.edit.kind === 'text') run.used.add(offered.edit.nodeId)
  run.changes.push({ proposal: offered, applied: false })
  return {
    step: {
      tool: 'propose_prose_edit',
      label: `Suggesting a change to ${offered.edit.kind === 'text' ? offered.edit.title : 'the book'}…`
    },
    result:
      offered.violation === null
        ? 'Offered to the author.'
        : `Offered, flagged by the voice check: ${offered.violation}`
  }
}

/** Runs one tool call; a write tool the message may not use answers why not. */
export function runScribeTool(
  run: ScribeRun,
  name: unknown,
  args: Record<string, unknown>
): ToolOutcome {
  if (!isTool(name)) {
    return {
      step: { tool: 'search_book', label: 'Looking…' },
      result: `There is no tool "${str(name)}". Use ${SCRIBE_TOOLS.join(', ')}.`
    }
  }
  const refused = (why: string): ToolOutcome => ({
    step: { tool: name, label: 'Not in this mode' },
    result: why
  })
  switch (name) {
    case 'search_book':
      return searchBook(run, str(args.query))
    case 'open_scene':
      return openScene(run, args.id, args.from)
    case 'list_notes':
      return listNotes(run)
    case 'open_note':
      return openNote(run, args.id, args.from)
    case 'edit_note':
      return run.access.notes
        ? editNote(run, args)
        : refused('Brainstorm changes nothing; answer instead.')
    case 'create_note':
      return run.access.notes
        ? createNote(run, args)
        : refused('Brainstorm changes nothing; answer instead.')
    case 'propose_prose_edit':
      return run.access.prose
        ? proposeProse(run, args)
        : refused('No prose changes in this mode; answer instead.')
  }
}
