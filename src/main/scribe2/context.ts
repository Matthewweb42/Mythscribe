import { estimateTokens } from '@shared/ai'
import {
  SCRIBE_FORCED_BOOK_TOKENS,
  SCRIBE_MAP_NOTES_CHARS,
  SCRIBE_MAP_SYNOPSIS_CHARS,
  SCRIBE_MOMENT_NOTES_CHARS,
  SCRIBE_NOTES_TOKENS,
  SCRIBE_PICK_BOOK_TOKENS,
  SCRIBE_TEMPLATE_FOLDERS_MAX,
  SCRIBE_TEMPLATE_SECTIONS_MAX,
  SCRIBE_WHOLE_BOOK_TOKENS,
  type ScribePageKind
} from '@shared/scribe2'
import { headTruncate } from '../ai/context/chatContext'

/**
 * What Ms Scribe sees with every message in a story memory v1 project (notes redesign phase 1,
 * plan "How Ms Scribe gets the right context"), built here from what `source.ts` gathered, in the
 * order the provider caches it: her rules (the prompt's), every note page, the book map, the book
 * (whole when everything fits under `SCRIBE_WHOLE_BOOK_TOKENS`, or when the author asks for the
 * whole book; else the scenes picked for the question), then the moment (the open scene in full,
 * its notes, the selection), then the conversation (the prompt's). Pure: no database, no clock.
 */

/** One page she reads: a note page, a story-bible sheet, or a Library upload (until phase 4). */
export interface ScribePage {
  /** `p1`, `p2`, … in the order given. */
  ref: string
  id: string
  kind: ScribePageKind
  title: string
  /** The folder path of a note page ("Characters › Minor"); '' at the top or for a sheet. */
  folder: string
  text: string
}

/**
 * A Notes folder whose new pages follow a template (notes fixes, 2026-10-15), as the notes block
 * names it: the folder's path and the template's headings.
 */
export interface ScribeFolderTemplate {
  /** "Characters", "Characters › Minor". */
  folder: string
  sections: string[]
}

/** One manuscript scene in reading order. */
export interface ScribeScene {
  /** `n1`, `n2`, … as the agent's tools number the tree. */
  ref: string
  nodeId: string
  /** `Chapter › Scene`, or the scene's own title outside a chapter. */
  title: string
  synopsis: string
  notes: string
  /** The stored scene summary (AI), used in the map only where there is no synopsis. */
  summary: string
  text: string
}

export interface ScribeContextInput {
  /** The rules' estimated tokens, counted toward the whole-book switch. */
  rulesTokens: number
  pages: ScribePage[]
  /** Every manuscript scene in reading order. */
  scenes: ScribeScene[]
  /** The open scene's node id, or null (none open, or not a manuscript scene). */
  currentId: string | null
  selection: string
  /** The author's message (and the attached passage, if any). */
  question: string
  /** "Whole book" asked for: the book goes whole (up to `SCRIBE_FORCED_BOOK_TOKENS`). */
  wholeBook: boolean
  /** Node ids the full-text index matched for the question, best first. */
  searchHits: string[]
  /** Names to look for in the question and the open scene (page titles, sheet names and aliases). */
  names: string[]
  /** The folders with a template, listed once at the end of the notes block. */
  folderTemplates: readonly ScribeFolderTemplate[]
}

export interface ScribeContext {
  notes: string
  map: string
  book: string
  /** What the book block is: the whole book, or the scenes picked for this question. */
  bookMode: 'whole' | 'picked'
  moment: string
  /** The scenes whose full text went along (the moment's scene included). */
  sentScenes: string[]
  /** The pages whose full text went along. */
  sentPages: string[]
  /** The whole-book estimate the switch compared with `SCRIBE_WHOLE_BOOK_TOKENS`. */
  wholeEstimate: number
}

const tokens = (text: string): number => estimateTokens(text)

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * How many times `name` stands as a word in `text` (`caseless` for the author's typing); a name
 * under three characters never counts.
 */
export function nameCount(text: string, name: string, caseless: boolean): number {
  const trimmed = name.trim()
  if (trimmed.length < 3) return 0
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(trimmed)}(?=$|[^\\p{L}\\p{N}])`,
    caseless ? 'giu' : 'gu'
  )
  return [...text.matchAll(pattern)].length
}

/** Whether `name` stands as a word in `text` (`caseless` for the author's typing). */
export function namesIn(text: string, name: string, caseless: boolean): boolean {
  return nameCount(text, name, caseless) > 0
}

/** The shortest word of a page title that counts as a name on its own ("Tash" in "Tash — powers"). */
export const PAGE_NAME_WORD_MIN = 4

/** Capitalised words of four letters or more a title may hold that are not names. */
const NOT_NAMES = new Set([
  'about',
  'after',
  'also',
  'before',
  'from',
  'have',
  'into',
  'more',
  'only',
  'over',
  'some',
  'than',
  'that',
  'their',
  'them',
  'then',
  'there',
  'they',
  'this',
  'what',
  'when',
  'where',
  'which',
  'will',
  'with',
  'your'
])

/**
 * The names a note page answers to (notes redesign, 2026-10-15): its title, and each capitalised
 * word of the title of `PAGE_NAME_WORD_MIN` letters or more ("Tash" in "Tash — powers"), each once.
 */
export function pageNames(title: string): string[] {
  const whole = title.trim()
  const words = whole
    .split(/[^\p{L}\p{N}]+/u)
    .filter(
      (word) =>
        word.length >= PAGE_NAME_WORD_MIN &&
        /^\p{Lu}/u.test(word) &&
        !NOT_NAMES.has(word.toLowerCase())
    )
  const names: string[] = []
  const seen = new Set<string>()
  for (const name of [whole, ...words]) {
    const key = name.toLowerCase()
    if (name === '' || seen.has(key)) continue
    seen.add(key)
    names.push(name)
  }
  return names
}

/** One text a page may be named in, read caselessly when it is the author's typing. */
export interface NamingText {
  text: string
  caseless: boolean
}

/**
 * The pages `texts` name (`pageNames`, matched as Ms Scribe matches names), most often named
 * first, ties in the order given; a page named nowhere is left out.
 */
export function pagesNamedIn<P extends { title: string }>(
  pages: readonly P[],
  texts: readonly NamingText[]
): P[] {
  return pages
    .map((page, index) => ({
      page,
      index,
      count: pageNames(page.title).reduce(
        (sum, name) =>
          sum +
          texts.reduce((each, { text, caseless }) => each + nameCount(text, name, caseless), 0),
        0
      )
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map((entry) => entry.page)
}

/** The names of `names` that stand in `text`, each once. */
export function namesFound(text: string, names: readonly string[], caseless: boolean): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const name of names) {
    const key = name.trim().toLowerCase()
    if (seen.has(key)) continue
    if (namesIn(text, name, caseless)) {
      found.push(name.trim())
      seen.add(key)
    }
  }
  return found
}

function pageBlock(page: ScribePage): string {
  const where =
    page.kind === 'note' ? 'note' : page.kind === 'sheet' ? 'story-bible sheet' : 'Library upload'
  const folder = page.folder === '' ? '' : `, in ${page.folder}`
  return `## ${page.ref} ${page.title} (${where}${folder})\n${page.text.trim() || '(empty)'}`
}

function pageLine(page: ScribePage): string {
  const where = page.kind === 'note' ? 'note' : page.kind === 'sheet' ? 'sheet' : 'upload'
  return `${page.ref} ${page.title} (${where}${page.folder === '' ? '' : `, ${page.folder}`})`
}

/**
 * Every page whole while they fit in `SCRIBE_NOTES_TOKENS`; past it, every page's line, then the
 * pages named in the question or the open scene whole first, then the rest in order while they fit.
 */
export function buildNotesBlock(
  pages: readonly ScribePage[],
  wanted: ReadonlySet<string>,
  budget = SCRIBE_NOTES_TOKENS
): { text: string; sent: string[] } {
  if (pages.length === 0) return { text: 'There are no note pages yet.', sent: [] }
  const blocks = pages.map(pageBlock)
  const whole = blocks.join('\n\n')
  if (tokens(whole) <= budget) return { text: whole, sent: pages.map((page) => page.id) }
  const list = `Every page (open one with open_note):\n${pages.map(pageLine).join('\n')}`
  let used = tokens(list)
  const order = [
    ...pages.filter((page) => wanted.has(page.id)),
    ...pages.filter((page) => !wanted.has(page.id))
  ]
  const sent = new Set<string>()
  for (const page of order) {
    const cost = tokens(pageBlock(page)) + 1
    if (used + cost > budget) continue
    used += cost
    sent.add(page.id)
  }
  const shown = pages.filter((page) => sent.has(page.id)).map(pageBlock)
  return {
    text: shown.length === 0 ? list : `${list}\n\n${shown.join('\n\n')}`,
    sent: pages.filter((page) => sent.has(page.id)).map((page) => page.id)
  }
}

/**
 * The folders with a template and their headings, once, for the end of the notes block (notes
 * fixes, 2026-10-15: she knows a folder's shape before she writes a page in it); '' for none.
 * Stable while the templates and folder names are.
 */
export function folderTemplatesBlock(templates: readonly ScribeFolderTemplate[]): string {
  const listed = templates
    .filter((entry) => entry.sections.length > 0)
    .slice(0, SCRIBE_TEMPLATE_FOLDERS_MAX)
  if (listed.length === 0) return ''
  const lines = listed.map((entry) => {
    const sections = entry.sections.slice(0, SCRIBE_TEMPLATE_SECTIONS_MAX).join(', ')
    const more = entry.sections.length > SCRIBE_TEMPLATE_SECTIONS_MAX ? ', …' : ''
    return `${entry.folder} → template: ${sections}${more}`
  })
  return `Folder templates:\n${lines.join('\n')}`
}

/** One line per scene in reading order: title, synopsis (or the stored summary), notes. */
export function buildBookMap(scenes: readonly ScribeScene[]): string {
  if (scenes.length === 0) return 'The book has no scenes yet.'
  return scenes
    .map((scene) => {
      const parts = [`${scene.ref} ${scene.title}`]
      const synopsis = flat(scene.synopsis)
      const summary = flat(scene.summary)
      if (synopsis !== '') {
        parts.push(`synopsis: ${headTruncate(synopsis, SCRIBE_MAP_SYNOPSIS_CHARS)}`)
      } else if (summary !== '') {
        parts.push(`summary (AI): ${headTruncate(summary, SCRIBE_MAP_SYNOPSIS_CHARS)}`)
      }
      const notes = flat(scene.notes)
      if (notes !== '') parts.push(`notes: ${headTruncate(notes, SCRIBE_MAP_NOTES_CHARS)}`)
      return parts.join(' | ')
    })
    .join('\n')
}

function sceneBlock(scene: ScribeScene): string {
  return `### ${scene.ref} ${scene.title}\n${scene.text.trim() || '(empty)'}`
}

/**
 * The scenes picked for a question when the book does not go whole, in priority order: those
 * naming a name the question names, the full-text hits, the open scene's neighbours (two before,
 * one after), then those naming a name the open scene names. The open scene itself is the
 * moment's. Each is taken whole while it fits in `budget`; the pick is returned in reading order.
 */
export function pickScenes(
  scenes: readonly ScribeScene[],
  input: Pick<ScribeContextInput, 'currentId' | 'question' | 'searchHits' | 'names'>,
  budget = SCRIBE_PICK_BOOK_TOKENS
): ScribeScene[] {
  const byId = new Map(scenes.map((scene) => [scene.nodeId, scene]))
  const index = scenes.findIndex((scene) => scene.nodeId === input.currentId)
  const current = index < 0 ? undefined : scenes[index]
  const naming = (names: readonly string[]): ScribeScene[] =>
    names.length === 0
      ? []
      : scenes.filter((scene) => names.some((name) => namesIn(scene.text, name, false)))
  const asked = namesFound(input.question, input.names, true)
  const neighbours =
    index < 0
      ? []
      : [scenes[index - 1], scenes[index + 1], scenes[index - 2]].filter(
          (scene): scene is ScribeScene => scene !== undefined
        )
  const here = current === undefined ? [] : namesFound(current.text, input.names, false)
  const order = [
    ...naming(asked),
    ...input.searchHits.flatMap((id) => {
      const scene = byId.get(id)
      return scene === undefined ? [] : [scene]
    }),
    ...neighbours,
    ...naming(here)
  ]
  const picked = new Set<string>()
  let used = 0
  for (const scene of order) {
    if (scene.nodeId === input.currentId || picked.has(scene.nodeId)) continue
    const cost = tokens(sceneBlock(scene)) + 1
    if (used + cost > budget) continue
    used += cost
    picked.add(scene.nodeId)
  }
  return scenes.filter((scene) => picked.has(scene.nodeId))
}

function momentBlock(current: ScribeScene | undefined, inBook: boolean, selection: string): string {
  if (current === undefined) {
    const lines = ['No scene is open.']
    if (selection.trim() !== '') lines.push(`Selected passage:\n"${selection.trim()}"`)
    return lines.join('\n')
  }
  const lines = [`The author is in ${current.ref} ${current.title}.`]
  const notes = current.notes.trim()
  lines.push(
    `Its notes: ${notes === '' ? '(none)' : headTruncate(notes, SCRIBE_MOMENT_NOTES_CHARS)}`
  )
  lines.push(
    inBook
      ? `Its text is in the book above (${current.ref}).`
      : `Its text:\n${current.text.trim() || '(empty)'}`
  )
  if (selection.trim() !== '') lines.push(`Selected passage:\n"${selection.trim()}"`)
  return lines.join('\n')
}

/**
 * The context for one message. The whole book goes along when the whole request (rules, notes,
 * map, every scene, the moment) is estimated under `SCRIBE_WHOLE_BOOK_TOKENS`, or when the author
 * asked for it (then up to `SCRIBE_FORCED_BOOK_TOKENS`, the scenes past it listed as left out);
 * otherwise the picked scenes (`pickScenes`).
 */
export function buildScribeContext(input: ScribeContextInput): ScribeContext {
  const current = input.scenes.find((scene) => scene.nodeId === input.currentId)
  const wantedNames = new Set(
    [
      ...namesFound(input.question, input.names, true),
      ...(current === undefined ? [] : namesFound(current.text, input.names, false))
    ].map((name) => name.toLowerCase())
  )
  const wantedPages = new Set(
    input.pages
      .filter((page) => wantedNames.has(page.title.trim().toLowerCase()))
      .map((page) => page.id)
  )
  const pagesBlock = buildNotesBlock(input.pages, wantedPages)
  const templates = folderTemplatesBlock(input.folderTemplates)
  const notes = {
    text: templates === '' ? pagesBlock.text : `${pagesBlock.text}\n\n${templates}`,
    sent: pagesBlock.sent
  }
  const map = buildBookMap(input.scenes)
  const wholeBook = input.scenes.map(sceneBlock).join('\n\n')
  const wholeMoment = momentBlock(current, true, input.selection)
  const wholeEstimate =
    input.rulesTokens + tokens(notes.text) + tokens(map) + tokens(wholeBook) + tokens(wholeMoment)

  if (input.scenes.length > 0 && (input.wholeBook || wholeEstimate <= SCRIBE_WHOLE_BOOK_TOKENS)) {
    const kept: ScribeScene[] = []
    let used = 0
    for (const scene of input.scenes) {
      const cost = tokens(sceneBlock(scene)) + 1
      if (used + cost > SCRIBE_FORCED_BOOK_TOKENS) break
      used += cost
      kept.push(scene)
    }
    const left = input.scenes.slice(kept.length)
    const tail =
      left.length === 0
        ? ''
        : `\n\n(Left out for length: ${left.map((scene) => scene.ref).join(', ')}; open them with open_scene.)`
    const inBook = current !== undefined && kept.includes(current)
    const sent = kept.map((scene) => scene.nodeId)
    if (current !== undefined && !inBook) sent.push(current.nodeId)
    return {
      notes: notes.text,
      map,
      book: `${kept.map(sceneBlock).join('\n\n')}${tail}`,
      bookMode: 'whole',
      moment: momentBlock(current, inBook, input.selection),
      sentScenes: sent,
      sentPages: notes.sent,
      wholeEstimate
    }
  }

  const picked = pickScenes(input.scenes, input)
  return {
    notes: notes.text,
    map,
    book:
      picked.length === 0
        ? 'No other scene was picked for this question; open scenes with open_scene.'
        : picked.map(sceneBlock).join('\n\n'),
    bookMode: 'picked',
    moment: momentBlock(current, false, input.selection),
    sentScenes: [
      ...picked.map((scene) => scene.nodeId),
      ...(current === undefined ? [] : [current.nodeId])
    ],
    sentPages: notes.sent,
    wholeEstimate
  }
}
