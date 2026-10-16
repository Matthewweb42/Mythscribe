import { describeEdit, type AgentEdit, type AgentStep } from '@shared/agent'
import { NOTEBOOK_SECTION_TITLE, NOTEBOOK_TITLE_MAX, type NotebookItem } from '@shared/notebook'
import { SCRIBE_MAX_STRUCTURE } from '@shared/scribe2'
import { AppError } from '../ipc/errors'
import {
  createNotebookItem,
  listNotebook,
  moveNotebookItem,
  updateNotebookItem
} from '../notebook/notebookStore'
import type { TreeDb } from '../tree/treeStore'
import { nodeByRef, resolveAgentEdit, type ToolOutcome } from '../ai/agentTools'
import { headTruncate } from '../ai/context/chatContext'
import { folderPath } from './source'
import type { ScribeRun } from './tools'

/**
 * Ms Scribe's structure tools (notes structure part C, `scribe.v5`, 2026-10-16), for Write and
 * Vibe. In Notes, `create_folder`, `move_note` and `rename_note` change the notebook at once
 * through its store, each change carrying what its Undo needs (the old place, the old title), and
 * `delete_note` only asks: a pending change the author's Delete applies. In the manuscript every
 * tool builds the chat agent's own edit and resolves it with `resolveAgentEdit` (never a second
 * implementation); the chat applies the non-deletions at once with their Undo (`agentApply.ts`),
 * and a merge or a deletion waits for Delete. No tool writes scene text: a new scene is empty.
 * Every change counts toward `SCRIBE_MAX_STRUCTURE`, each item moved once.
 */

const str = (value: unknown): string => (typeof value === 'string' ? value : '')
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const key = (text: string): string => flat(text).toLowerCase()

/** Names that mean the top of Notes: Documents, since the notes binder (2026-10-16). */
const TOP = new Set(['', 'top', 'notes', '/', 'root', 'the top'])

/** The Documents section's root in a listing (where the top's things go); null before it exists. */
function documentsRoot(items: readonly NotebookItem[]): NotebookItem | null {
  return items.find((item) => item.role === 'documents' && item.parentId === null) ?? null
}

/** A section root's refusal for a tool, or null for an ordinary item. */
function sectionRefusal(item: NotebookItem, change: string): string | null {
  return item.role == null
    ? null
    : `${NOTEBOOK_SECTION_TITLE[item.role]} is one of the Notes sections; it cannot be ${change}`
}

/** How much one change counts toward the cap: one, or each item it moves. */
export function structureWeight(edit: AgentEdit): number {
  switch (edit.kind) {
    case 'notebookFolder':
    case 'notebookRename':
    case 'notebookDelete':
    case 'rename':
    case 'move':
    case 'split':
    case 'merge':
    case 'delete':
      return 1
    case 'notebookMove':
      return edit.items.length
    case 'moveMany':
      return edit.nodes.length
    case 'create':
      return 1 + edit.moveIn.length
    default:
      return 0
  }
}

/** The structure changes this message has made so far. */
export function structureUsed(run: ScribeRun): number {
  return run.changes.reduce((sum, change) => sum + structureWeight(change.proposal.edit), 0)
}

function capLeft(run: ScribeRun, needed: number): string | null {
  const used = structureUsed(run)
  return used + needed > SCRIBE_MAX_STRUCTURE
    ? `Refused: at most ${SCRIBE_MAX_STRUCTURE} structure changes a message (${used} made); answer now and say what is left.`
    : null
}

function done(run: ScribeRun, edit: AgentEdit, applied: boolean): void {
  run.changes.push({ proposal: { edit, violation: null }, applied })
}

/** The pieces of a folder path ("Characters › Minor", "Characters/Minor"). */
const segments = (name: string): string[] =>
  name
    .split(/›|\/|>/)
    .map(flat)
    .filter((part) => part !== '')

const childFolder = (
  items: readonly NotebookItem[],
  parentId: string | null,
  title: string
): NotebookItem | undefined =>
  items.find(
    (item) => item.kind === 'folder' && item.parentId === parentId && key(item.title) === key(title)
  )

/**
 * Where a path starts: the top when its first part names a top-level folder (a section, "Outline ›
 * Beats"), else Documents ("Characters › Minor" is "Documents › Characters › Minor").
 */
function pathStart(items: readonly NotebookItem[], first: string): NotebookItem | null {
  return childFolder(items, null, first) !== undefined ? null : documentsRoot(items)
}

/**
 * The folder a name or path names: Documents for the top (null before the sections exist),
 * undefined for none. A path walks down from the top, or from Documents when its first part is
 * not a section (`pathStart`); one name is a section first, else the shallowest folder of that
 * name.
 */
export function findFolder(
  items: readonly NotebookItem[],
  name: string
): NotebookItem | null | undefined {
  if (TOP.has(key(name))) return documentsRoot(items)
  const parts = segments(name)
  if (parts.length > 1) {
    let at: NotebookItem | null = pathStart(items, parts[0] ?? '')
    for (const part of parts) {
      const next = childFolder(items, at?.id ?? null, part)
      if (next === undefined) return undefined
      at = next
    }
    return at
  }
  const title = parts[0] ?? ''
  const matches = items.filter((item) => item.kind === 'folder' && key(item.title) === key(title))
  const depth = (item: NotebookItem): number => segments(folderPath(items, item.parentId)).length
  return [...matches].sort((a, b) => depth(a) - depth(b))[0]
}

/**
 * The folder a name or path names, made when missing (each missing part of a path, under the
 * deepest part found); `onMade` hears each new folder with the listing from before it was made.
 * Documents for the top (`findFolder`); a path that is not under a section is made in Documents.
 * Shared by Ms Scribe's tools and Sort with Ms Scribe (notes structure B).
 */
export function ensureFolderPath(
  db: TreeDb,
  name: string,
  onMade: (made: NotebookItem, before: readonly NotebookItem[]) => void
): NotebookItem | null {
  let items = listNotebook(db)
  const found = findFolder(items, name)
  if (found !== undefined) return found
  const parts = segments(name).map((part) => part.slice(0, NOTEBOOK_TITLE_MAX))
  let at: NotebookItem | null = pathStart(items, parts[0] ?? '')
  for (const part of parts) {
    const existing = childFolder(items, at?.id ?? null, part)
    if (existing !== undefined) {
      at = existing
      continue
    }
    const made = createNotebookItem(db, { parentId: at?.id ?? null, kind: 'folder', title: part })
    onMade(made, items)
    items = listNotebook(db)
    at = items.find((item) => item.id === made.id) ?? null
  }
  return at
}

/**
 * The folder a name or path names, made when missing (`ensureFolderPath`), each new folder a
 * `notebookFolder` change of the run. Null for the top.
 */
export function ensureFolder(run: ScribeRun, name: string): NotebookItem | null {
  return ensureFolderPath(run.db, name, (made) => {
    run.notebookChanged([made.id])
    done(
      run,
      {
        kind: 'notebookFolder',
        folderId: made.id,
        title: made.title,
        // Read after the make: a first make can bring the sections with it.
        parent: folderPath(listNotebook(run.db), made.parentId)
      },
      true
    )
  })
}

/** A Notes page (by ref or title) or folder (by title or path) the model named, or why not. */
function itemArg(
  run: ScribeRun,
  items: readonly NotebookItem[],
  ref: unknown
): NotebookItem | string {
  const raw = flat(str(ref))
  if (raw === '') return 'name a page (p2) or a folder (by title)'
  const asRef = /^\d+$/.test(raw) ? `p${raw}` : raw.toLowerCase()
  const page =
    run.pages.find((p) => p.ref === asRef) ??
    run.pages.find((p) => p.kind === 'note' && key(p.title) === key(raw))
  if (page !== undefined) {
    if (page.kind !== 'note') return `${page.title} is read-only (not a note page)`
    const item = items.find((each) => each.id === page.id)
    if (item !== undefined) return item
  }
  const folder = findFolder(items, raw)
  if (folder !== undefined && folder !== null) return folder
  const byTitle = items.find((item) => key(item.title) === key(raw))
  return byTitle ?? `no page or folder is “${raw}”; list the notes`
}

/** The ids a tool names: `ids` (a list or one) or `id`. */
function idsOf(args: Record<string, unknown>): unknown[] {
  if (Array.isArray(args.ids)) return args.ids
  if (args.ids !== undefined) return [args.ids]
  return args.id === undefined ? [] : [args.id]
}

/** Whether `id` is `ancestor` or sits under it. */
function within(items: readonly NotebookItem[], id: string | null, ancestor: string): boolean {
  const byId = new Map(items.map((item) => [item.id, item]))
  const seen = new Set<string>()
  for (let at = id; at !== null && !seen.has(at);) {
    if (at === ancestor) return true
    seen.add(at)
    at = byId.get(at)?.parentId ?? null
  }
  return false
}

/** Her pages' titles and folders as the notebook now holds them, so later tools name them right. */
function refreshPages(run: ScribeRun): void {
  const items = listNotebook(run.db)
  const byId = new Map(items.map((item) => [item.id, item]))
  for (const page of run.pages) {
    const item = byId.get(page.id)
    if (page.kind !== 'note' || item === undefined) continue
    page.title = item.title
    page.folder = folderPath(items, item.parentId)
  }
}

const failed = (step: AgentStep, err: unknown): ToolOutcome => {
  if (err instanceof AppError) return { step, result: err.message }
  throw err
}

function createFolder(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const title = flat(str(args.title)).slice(0, NOTEBOOK_TITLE_MAX)
  const step: AgentStep = { tool: 'create_folder', label: `Making the folder ${title || '…'}…` }
  if (title === '') return { step, result: 'create_folder needs a "title".' }
  const parentName = flat(str(args.parent))
  const items = listNotebook(run.db)
  // A parent that does not exist yet is made too (decided by Claude).
  const parentFound = findFolder(items, parentName)
  if (parentFound !== undefined && childFolder(items, parentFound?.id ?? null, title)) {
    return { step, result: `${title} already exists there.` }
  }
  const missing = parentFound === undefined ? segments(parentName).length : 0
  const refused = capLeft(run, 1 + missing)
  if (refused !== null) return { step, result: refused }
  try {
    const parent = parentFound === undefined ? ensureFolder(run, parentName) : parentFound
    const made = createNotebookItem(run.db, { parentId: parent?.id ?? null, kind: 'folder', title })
    run.notebookChanged([made.id])
    const fresh = listNotebook(run.db)
    done(
      run,
      {
        kind: 'notebookFolder',
        folderId: made.id,
        title: made.title,
        parent: folderPath(fresh, made.parentId)
      },
      true
    )
    return { step, result: `Made the folder ${folderPath(fresh, made.id)}.` }
  } catch (err) {
    return failed(step, err)
  }
}

function moveNote(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'move_note', label: 'Moving notes…' }
  const ids = idsOf(args)
  if (ids.length === 0) return { step, result: 'move_note needs "ids" (pages or folders).' }
  if (args.to === undefined) return { step, result: 'move_note needs "to" (a folder, or "top").' }
  const items = listNotebook(run.db)
  const moving: NotebookItem[] = []
  for (const id of ids) {
    const item = itemArg(run, items, id)
    if (typeof item === 'string') return { step, result: `Nothing moved: ${item}.` }
    const fixed = sectionRefusal(item, 'moved')
    if (fixed !== null) return { step, result: `Nothing moved: ${fixed}.` }
    if (!moving.some((each) => each.id === item.id)) moving.push(item)
  }
  const toName = flat(str(args.to))
  const target = findFolder(items, toName)
  if (target !== undefined && target !== null) {
    const loop = moving.find((item) => within(items, target.id, item.id))
    if (loop !== undefined) {
      return { step, result: `Nothing moved: ${loop.title} cannot go inside itself.` }
    }
  }
  const staying = moving.filter(
    (item) => target !== undefined && item.parentId === (target?.id ?? null)
  )
  const toMove = moving.filter((item) => !staying.includes(item))
  if (toMove.length === 0) return { step, result: 'Already there; nothing moved.' }
  const refused = capLeft(run, toMove.length + (target === undefined ? segments(toName).length : 0))
  if (refused !== null) return { step, result: refused }
  try {
    const folder = target === undefined ? ensureFolder(run, toName) : target
    const parentId = folder?.id ?? null
    const siblings = listNotebook(run.db).filter(
      (item) => item.parentId === parentId && !toMove.some((each) => each.id === item.id)
    )
    const first = str(args.position).toLowerCase() === 'first'
    const positions = siblings.map((item) => item.position)
    const start = first
      ? (positions.length === 0 ? 0 : Math.min(...positions)) - toMove.length
      : (positions.length === 0 ? -1 : Math.max(...positions)) + 1
    const moved: Extract<AgentEdit, { kind: 'notebookMove' }>['items'] = []
    toMove.forEach((item, i) => {
      moveNotebookItem(run.db, { id: item.id, parentId, position: start + i })
      moved.push({
        id: item.id,
        title: item.title,
        folder: item.kind === 'folder',
        fromParentId: item.parentId,
        fromPosition: item.position
      })
    })
    run.notebookChanged(toMove.map((item) => item.id))
    refreshPages(run)
    const parentTitle = folder === null ? 'Notes' : folder.title
    done(run, { kind: 'notebookMove', items: moved, parentId, parentTitle }, true)
    const kept =
      staying.length === 0 ? '' : ` (${staying.map((item) => item.title).join(', ')} already there)`
    return {
      step: { tool: 'move_note', label: `Moving into ${parentTitle}…` },
      result: `Moved ${toMove.map((item) => item.title).join(', ')} into ${parentTitle}${kept}.`
    }
  } catch (err) {
    return failed(step, err)
  }
}

function renameNote(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const title = flat(str(args.title)).slice(0, NOTEBOOK_TITLE_MAX)
  const step: AgentStep = { tool: 'rename_note', label: `Renaming to ${title || '…'}…` }
  if (title === '') return { step, result: 'rename_note needs the new "title".' }
  const item = itemArg(run, listNotebook(run.db), args.id)
  if (typeof item === 'string') return { step, result: `Not renamed: ${item}.` }
  const fixed = sectionRefusal(item, 'renamed')
  if (fixed !== null) return { step, result: `Not renamed: ${fixed}.` }
  if (item.title === title) return { step, result: 'Nothing changed.' }
  const refused = capLeft(run, 1)
  if (refused !== null) return { step, result: refused }
  try {
    updateNotebookItem(run.db, { id: item.id, title })
    run.notebookChanged([item.id])
    refreshPages(run)
    done(
      run,
      {
        kind: 'notebookRename',
        id: item.id,
        folder: item.kind === 'folder',
        title: item.title,
        after: title
      },
      true
    )
    return { step, result: `Renamed ${item.title} to “${title}”.` }
  } catch (err) {
    return failed(step, err)
  }
}

function deleteNote(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'delete_note', label: 'Asking to delete a note…' }
  const items = listNotebook(run.db)
  const item = itemArg(run, items, args.id)
  if (typeof item === 'string') return { step, result: `Not asked: ${item}.` }
  const fixed = sectionRefusal(item, 'deleted')
  if (fixed !== null) return { step, result: `Not asked: ${fixed}.` }
  if (
    run.changes.some(
      (c) => c.proposal.edit.kind === 'notebookDelete' && c.proposal.edit.id === item.id
    )
  ) {
    return { step, result: 'Already asked.' }
  }
  const refused = capLeft(run, 1)
  if (refused !== null) return { step, result: refused }
  const pages = items.filter(
    (each) => each.kind === 'page' && each.id !== item.id && within(items, each.id, item.id)
  ).length
  done(
    run,
    {
      kind: 'notebookDelete',
      id: item.id,
      title: item.title,
      folder: item.kind === 'folder',
      pages
    },
    false
  )
  return {
    step: { tool: 'delete_note', label: `Asking to delete ${item.title}…` },
    result: `Asked her to delete ${item.title}; nothing is deleted until she presses Delete.`
  }
}

/** The manuscript's folders by ref, for a name that matched none. */
function chaptersLine(run: ScribeRun): string {
  const folders = run.project.rows
    .filter((row) => row.kind === 'folder')
    .map(
      (row) => `${run.project.refOf.get(row.id) ?? '?'} ${run.project.titleOf(row.id) || row.title}`
    )
  return folders.length === 0
    ? 'The book has no chapters; "manuscript" is its top.'
    : headTruncate(`Chapters: ${folders.join(', ')}; "manuscript" is the top.`, 1_500)
}

/**
 * A node the model named, as a ref the agent's edits take: a ref (`n3`), "manuscript" (a folder
 * wanted), or a title (a scene's "Chapter › Scene" or its own, a chapter's), when one node has it.
 */
function nodeArg(
  run: ScribeRun,
  ref: unknown,
  want: 'folder' | 'document' | 'any'
): string | { error: string } {
  const raw = flat(str(ref))
  if (raw === '') return { error: 'no id' }
  if (want !== 'document' && key(raw) === 'manuscript') return 'manuscript'
  const byRef = nodeByRef(run.project, raw)
  if (byRef !== undefined) return raw
  const fits = run.project.rows.filter(
    (row) =>
      (want === 'any' || (want === 'folder' ? row.kind === 'folder' : row.kind === 'document')) &&
      (key(run.project.titleOf(row.id)) === key(raw) || key(row.title) === key(raw))
  )
  const only = fits.length === 1 ? fits[0] : undefined
  if (only !== undefined) return run.project.refOf.get(only.id) ?? raw
  if (fits.length > 1) return { error: `${fits.length} items are called “${raw}”; use the ref` }
  return {
    error:
      want === 'document'
        ? `no scene is “${raw}”; see the book map`
        : `nothing is called “${raw}”. ${chaptersLine(run)}`
  }
}

/** Resolves one of the agent's edits; a pending change of the run, or why not. */
function offerTree(
  run: ScribeRun,
  step: AgentStep,
  raw: Record<string, unknown>,
  moveIn: Extract<AgentEdit, { kind: 'create' }>['moveIn'] = []
): ToolOutcome {
  const resolved = resolveAgentEdit(run.project, raw)
  if ('error' in resolved) return { step, result: `Not done: ${resolved.error}.` }
  const edit: AgentEdit =
    resolved.edit.kind === 'create' ? { ...resolved.edit, text: '', moveIn } : resolved.edit
  const refused = capLeft(run, structureWeight(edit))
  if (refused !== null) return { step, result: refused }
  done(run, edit, false)
  const said = describeEdit(edit)
  return {
    step,
    result:
      edit.kind === 'merge' || edit.kind === 'delete'
        ? `Asked her: ${said}. Nothing goes until she presses Delete.`
        : `Done: ${said} (she can undo it).`
  }
}

/** The documents a new chapter takes in, by ref or title; never the chapter's own parent. */
function moveInOf(
  run: ScribeRun,
  value: unknown
): Extract<AgentEdit, { kind: 'create' }>['moveIn'] | { error: string } {
  const refs: unknown[] = Array.isArray(value) ? value : value === undefined ? [] : [value]
  const out: Extract<AgentEdit, { kind: 'create' }>['moveIn'] = []
  for (const ref of refs) {
    const named = nodeArg(run, ref, 'any')
    if (typeof named !== 'string') return named
    const row = nodeByRef(run.project, named)
    if (row === undefined) return { error: `${str(ref)} cannot move` }
    if (!out.some((each) => each.nodeId === row.id)) {
      out.push({ nodeId: row.id, title: run.project.titleOf(row.id) || row.title })
    }
  }
  return out
}

/** A chapter made earlier in this message (not in the tree yet) by its title. */
function pendingChapter(
  run: ScribeRun,
  title: string
): Extract<AgentEdit, { kind: 'create' }> | undefined {
  for (const change of run.changes) {
    const edit = change.proposal.edit
    if (edit.kind === 'create' && edit.level === 'chapter' && key(edit.title) === key(title)) {
      return edit
    }
  }
  return undefined
}

function createChapter(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const title = flat(str(args.title))
  const step: AgentStep = { tool: 'create_chapter', label: `Making the chapter ${title || '…'}…` }
  const parent = nodeArg(run, args.in ?? 'manuscript', 'folder')
  if (typeof parent !== 'string') return { step, result: `Not done: ${parent.error}.` }
  const after = args.after === undefined ? '' : nodeArg(run, args.after, 'folder')
  if (typeof after !== 'string') return { step, result: `Not done: ${after.error}.` }
  const moveIn = moveInOf(run, args.scenes)
  if ('error' in moveIn) return { step, result: `Not done: ${moveIn.error}.` }
  return offerTree(
    run,
    step,
    { edit: 'create', level: 'chapter', in: parent, after, title },
    moveIn
  )
}

function createScene(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const title = flat(str(args.title))
  const step: AgentStep = { tool: 'create_scene', label: `Making the scene ${title || '…'}…` }
  const after = args.after === undefined ? '' : nodeArg(run, args.after, 'document')
  if (typeof after !== 'string') return { step, result: `Not done: ${after.error}.` }
  let parent: string | { error: string }
  if (args.in !== undefined) parent = nodeArg(run, args.in, 'folder')
  else if (after !== '') {
    const row = nodeByRef(run.project, after)
    const up = row?.parentId == null ? undefined : run.project.byId.get(row.parentId)
    parent = up === undefined ? 'manuscript' : (run.project.refOf.get(up.id) ?? 'manuscript')
  } else return { step, result: 'create_scene needs "in" (a chapter) or "after" (a scene).' }
  if (typeof parent !== 'string') return { step, result: `Not done: ${parent.error}.` }
  return offerTree(run, step, { edit: 'create', level: 'scene', in: parent, after, title })
}

function moveScene(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'move_scene', label: 'Moving scenes…' }
  const ids = idsOf(args)
  if (ids.length === 0) return { step, result: 'move_scene needs "ids".' }
  const toName = flat(str(args.to))
  if (toName === '') return { step, result: 'move_scene needs "to" (a chapter, or "manuscript").' }
  const refs: string[] = []
  for (const id of ids) {
    const named = nodeArg(run, id, 'any')
    if (typeof named !== 'string') return { step, result: `Not done: ${named.error}.` }
    refs.push(named)
  }
  // A chapter made earlier in this message is not in the tree yet: the scenes go in with it.
  const target = nodeArg(run, toName, 'folder')
  const made = typeof target === 'string' ? undefined : pendingChapter(run, toName)
  if (made !== undefined) {
    const moveIn = moveInOf(run, refs)
    if ('error' in moveIn) return { step, result: `Not done: ${moveIn.error}.` }
    const added = moveIn.filter((node) => !made.moveIn.some((each) => each.nodeId === node.nodeId))
    const refused = capLeft(run, added.length)
    if (refused !== null) return { step, result: refused }
    made.moveIn.push(...added)
    return {
      step,
      result: `Done: they go into the new chapter ${made.title} as it is made (she can undo it).`
    }
  }
  if (typeof target !== 'string') return { step, result: `Not done: ${target.error}.` }
  if (args.after !== undefined && refs.length === 1) {
    const after = nodeArg(run, args.after, 'any')
    if (typeof after !== 'string') return { step, result: `Not done: ${after.error}.` }
    return offerTree(run, step, { edit: 'move', id: refs[0], in: target, after })
  }
  return offerTree(run, step, { edit: 'move', ids: refs, in: target })
}

function renameScene(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'rename_scene', label: 'Renaming…' }
  const id = nodeArg(run, args.id, 'any')
  if (typeof id !== 'string') return { step, result: `Not done: ${id.error}.` }
  return offerTree(run, step, { edit: 'rename', id, title: args.title })
}

function splitScene(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'split_scene', label: 'Splitting a scene…' }
  const id = nodeArg(run, args.id, 'document')
  if (typeof id !== 'string') return { step, result: `Not done: ${id.error}.` }
  return offerTree(run, step, { edit: 'split', id, at: args.at, title: args.title })
}

function mergeScenes(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'merge_scenes', label: 'Asking to merge scenes…' }
  const id = nodeArg(run, args.id, 'document')
  if (typeof id !== 'string') return { step, result: `Not done: ${id.error}.` }
  const into = nodeArg(run, args.into, 'document')
  if (typeof into !== 'string') return { step, result: `Not done: ${into.error}.` }
  return offerTree(run, step, { edit: 'merge', id, into })
}

function deleteScene(run: ScribeRun, args: Record<string, unknown>): ToolOutcome {
  const step: AgentStep = { tool: 'delete_scene', label: 'Asking to delete…' }
  const id = nodeArg(run, args.id, 'any')
  if (typeof id !== 'string' || id === 'manuscript') {
    return {
      step,
      result: `Not asked: ${typeof id === 'string' ? 'the manuscript stays' : id.error}.`
    }
  }
  return offerTree(run, step, { edit: 'delete', id })
}

/** The structure tools by name (`SCRIBE_STRUCTURE_TOOLS`). */
export const STRUCTURE_TOOLS = {
  create_folder: createFolder,
  move_note: moveNote,
  rename_note: renameNote,
  delete_note: deleteNote,
  create_chapter: createChapter,
  create_scene: createScene,
  move_scene: moveScene,
  rename_scene: renameScene,
  split_scene: splitScene,
  merge_scenes: mergeScenes,
  delete_scene: deleteScene
} as const satisfies Record<string, (run: ScribeRun, args: Record<string, unknown>) => ToolOutcome>
