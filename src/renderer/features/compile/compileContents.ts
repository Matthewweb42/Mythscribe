import {
  CompileFormat,
  isValidPattern,
  type CompileScope,
  type Replacement
} from '@shared/compileFormat'
import type { BookItem, CompiledBook, ContentBlock, Inline } from '@shared/compileModel'
import { pageRuns } from '@shared/compilePages'
import type { SectionType } from '@shared/labels'
import type { TreeIndex } from '@renderer/features/manuscript/treeStore'

/**
 * Pure helpers of the compile window (Compile v2, CV3): the quick picks' chapter list, the
 * "Include in compile" checklist, the scope the choices make, and the preview's window of pages.
 */

// ---------------------------------------------------------------------------------------------
// Quick picks

export type ScopeKind = CompileScope['kind']

/** A chapter of the manuscript, listed under the part that holds it (null: no part). */
export interface ChapterGroup {
  partId: string | null
  partTitle: string | null
  chapters: { id: string; title: string }[]
}

/**
 * The manuscript's chapters in reading order, grouped under their parts, for the "Selected
 * chapters" quick pick. Chapters outside any part form a group of their own in place; a scene
 * placed at chapter level (right under the root or a part) is listed like a chapter.
 */
export function chapterGroups(
  index: Pick<TreeIndex, 'byId' | 'childrenOf' | 'rootIds'>
): ChapterGroup[] {
  const groups: ChapterGroup[] = []
  const root = index.rootIds.find((id) => index.byId[id]?.sectionType === 'manuscript')
  if (root === undefined) return groups
  const walk = (parentId: string, part: { id: string; title: string } | null): void => {
    for (const id of index.childrenOf[parentId] ?? []) {
      const node = index.byId[id]
      if (!node) continue
      if (
        node.hierarchyLevel === 'chapter' ||
        (node.hierarchyLevel === 'scene' && (parentId === root || part?.id === parentId))
      ) {
        const last = groups.at(-1)
        const chapter = { id, title: node.title }
        // `undefined` (no group yet) never equals a part id or null.
        if (last?.partId === (part?.id ?? null)) last.chapters.push(chapter)
        else
          groups.push({
            partId: part?.id ?? null,
            partTitle: part?.title ?? null,
            chapters: [chapter]
          })
      } else if (node.hierarchyLevel === 'part') {
        walk(id, { id, title: node.title })
      } else if (node.kind === 'folder') {
        walk(id, part)
      }
    }
  }
  walk(root, null)
  return groups
}

/**
 * The scope the quick pick makes, or null while it cannot run: no chapter ticked (of those still
 * in the manuscript), or no open document for "Current document".
 */
export function resolveScope(
  kind: ScopeKind,
  chapterIds: readonly string[],
  context: { chapterIds: ReadonlySet<string>; openDocumentId: string | null }
): CompileScope | null {
  if (kind === 'chapters') {
    const ids = chapterIds.filter((id) => context.chapterIds.has(id))
    return ids.length === 0 ? null : { kind: 'chapters', ids }
  }
  if (kind === 'document') {
    return context.openDocumentId === null ? null : { kind: 'document', id: context.openDocumentId }
  }
  return { kind: 'manuscript' }
}

// ---------------------------------------------------------------------------------------------
// Include in compile

/** One row of the "Include in compile" checklist. */
export interface IncludeRow {
  id: string
  title: string
  /** 0 for a section root. */
  depth: number
  kind: 'section' | 'folder' | 'document'
  /** Unticked itself. */
  excluded: boolean
  /** Left out because a folder or section above it is unticked. */
  excludedAbove: boolean
}

/**
 * Every node of the three sections in tree order with its include state; a section root is
 * titled as the binder titles it (`sectionTitle`, e.g. "Front Matter").
 */
export function includeRows(
  index: Pick<TreeIndex, 'byId' | 'childrenOf' | 'rootIds'>,
  excluded: ReadonlySet<string>,
  sectionTitle: (sectionType: SectionType) => string = (sectionType) => sectionType
): IncludeRow[] {
  const rows: IncludeRow[] = []
  const walk = (id: string, depth: number, above: boolean): void => {
    const node = index.byId[id]
    if (!node) return
    const own = excluded.has(id)
    rows.push({
      id,
      title: node.sectionType !== null ? sectionTitle(node.sectionType) : node.title,
      depth,
      kind: node.sectionType !== null ? 'section' : node.kind,
      excluded: own,
      excludedAbove: above
    })
    for (const child of index.childrenOf[id] ?? []) walk(child, depth + 1, above || own)
  }
  for (const root of index.rootIds) walk(root, 0, false)
  return rows
}

// ---------------------------------------------------------------------------------------------
// The preview's window of pages

/** About 20 printed pages: the preview lays out this many words from where it starts. */
export const PREVIEW_WORDS = 6000

function inlineWords(runs: readonly Inline[]): number {
  const text = runs.map((run) => (run.kind === 'text' ? run.text : ' ')).join('')
  return countText(text)
}

function countText(text: string): number {
  const trimmed = text.trim()
  return trimmed === '' ? 0 : trimmed.split(/\s+/u).length
}

function blockWords(blocks: readonly ContentBlock[]): number {
  let words = 0
  for (const block of blocks) {
    if (block.kind === 'paragraph' || block.kind === 'heading') words += inlineWords(block.runs)
    else if (block.kind === 'quote') words += blockWords(block.blocks)
  }
  return words
}

/** The words an item prints (headings and generated pages count as none). */
export function itemWords(item: BookItem): number {
  switch (item.kind) {
    case 'text':
    case 'matter':
    case 'note':
      return blockWords(item.blocks)
    case 'synopsis':
      return countText(item.text)
    default:
      return 0
  }
}

/** A place the preview can start: the first item of a page run, labelled for the picker. */
export interface PreviewStart {
  /** Index into `book.items`. */
  item: number
  label: string
}

const PAGE_LABELS: Record<Extract<BookItem, { kind: 'page' }>['page']['kind'], string> = {
  titlePage: 'Title page',
  manuscriptTitle: 'First page',
  copyright: 'Copyright page',
  dedication: 'Dedication',
  epigraph: 'Epigraph',
  toc: 'Contents',
  aboutAuthor: 'About the author',
  alsoBy: 'Also by'
}

function startLabel(item: BookItem): string | null {
  if (item.kind === 'page') return PAGE_LABELS[item.page.kind]
  if (item.kind === 'matter') return item.title || 'Untitled'
  if (item.kind === 'section') return item.heading?.plain ?? null
  return null
}

/**
 * Where the preview may start: the beginning, then every page run that opens with something
 * nameable (a generated page, a matter document, a headed section), in reading order.
 */
export function previewStarts(book: CompiledBook): PreviewStart[] {
  const starts: PreviewStart[] = [{ item: 0, label: 'Beginning' }]
  for (const run of pageRuns(book)) {
    if (run.start === 0) continue
    const item = book.items[run.start]
    const label = item === undefined ? null : startLabel(item)
    if (label !== null) starts.push({ item: run.start, label })
  }
  return starts
}

/**
 * The part of the book the preview lays out: from item `start` until about `words` words have
 * printed (the item that crosses the budget is kept whole), so a 100k-word novel previews as
 * fast as a short story. Folios in the window count from its first page.
 */
export function previewBook(
  book: CompiledBook,
  start: number,
  words: number = PREVIEW_WORDS
): CompiledBook {
  const from = Math.max(0, Math.min(start, book.items.length))
  const items: BookItem[] = []
  let printed = 0
  for (let index = from; index < book.items.length; index++) {
    const item = book.items[index]
    if (item === undefined) break
    items.push(item)
    printed += itemWords(item)
    if (printed >= words) break
  }
  return { ...book, items }
}

/** Whether the whole book fits in the preview (no "more pages" note needed). */
export function previewIsWhole(book: CompiledBook, preview: CompiledBook): boolean {
  return preview.items.length === book.items.length
}

// ---------------------------------------------------------------------------------------------
// The window's tabs and checks

export const COMPILE_TABS = [
  { id: 'contents', label: 'Contents' },
  { id: 'layouts', label: 'Section layouts' },
  { id: 'page', label: 'Page setup' },
  { id: 'headers', label: 'Headers & footers' },
  { id: 'typography', label: 'Typography' },
  { id: 'matter', label: 'Front & back matter' },
  { id: 'replacements', label: 'Replacements' },
  { id: 'metadata', label: 'Metadata' }
] as const
export type CompileTabId = (typeof COMPILE_TABS)[number]['id']

/** Why the shown format cannot be saved or compiled, or null. */
export function formatProblem(format: CompileFormat): string | null {
  const parsed = CompileFormat.safeParse(format)
  if (parsed.success) return null
  const issue = parsed.error.issues[0]
  if (issue === undefined) return 'The format has an invalid setting'
  const where = issue.path.join(' › ')
  return where === '' ? issue.message : `${where}: ${issue.message}`
}

/** Why a rule cannot be saved, or null. */
export function replacementError(rule: Replacement): string | null {
  if (rule.find === '') return 'Type what to find'
  if (rule.regex && !isValidPattern(rule.find)) return 'Not a valid regular expression'
  return null
}
