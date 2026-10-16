import { z } from 'zod'
import { estimateTokens } from '@shared/ai'
import { findQuote } from '@shared/critique'
import { docToText } from '@shared/docText'
import { chunkText } from '@shared/editPass'
import { NOTEBOOK_TITLE_MAX, type NotebookItem } from '@shared/notebook'
import { isTemplatesFolder, inTemplates } from '@shared/notebookTemplates'
import {
  NOTES_SORT_CHUNK_CHARS,
  NOTES_SORT_LIST_CHARS,
  NOTES_SORT_MAX_TOKENS,
  NOTES_SORT_OUTPUT_RATIO,
  NOTES_SORT_PAGES_MAX,
  NOTES_SORT_TIER,
  type NotesSortAppended,
  type NotesSortEstimate
} from '@shared/notesSort'
import type { TiptapNodeT } from '@shared/tiptap'
import { assertFeatureAllowed } from '../ai/dial'
import { requestWithRetry } from '../ai/editPass'
import { buildNotesSortPrompt } from '../ai/prompts/notesSort.v1'
import { createProposal, settleProposal } from '../ai/proposalStore'
import { AiCutOffError, AiFallbackError, AiProviderError } from '../ai/providers/types'
import { sha256, type AiRequestDeps } from '../ai/request'
import { getAiSettings } from '../project/settingsStore'
import { ensureFolderPath } from '../scribe2/structure'
import { folderPath } from '../scribe2/source'
import type { TreeDb } from '../tree/treeStore'
import {
  createNotebookItem,
  getNotebookPage,
  listNotebook,
  updateNotebookItem
} from './notebookStore'

/**
 * Sort with Ms Scribe (notes structure part B, `structure.md` §B, 2026-10-16): a document in Notes
 * broken into smaller pages in folders by `notesSort.v1` (fast tier, JSON), a part of at most
 * `NOTES_SORT_CHUNK_CHARS` a request. Her text is copied, never written anew: a page with a line
 * the part does not hold (whitespace and quotes folded, `findQuote`) is dropped. Each part's pages
 * are written as it answers: a folder she names is found by path or name and made when missing
 * (`ensureFolderPath`, Ms Scribe's own), a page of the same title in that folder is appended to
 * under the document's title (the version kept first is its Undo), any other page is made. The
 * document itself is kept. What it made and appended to is answered for the one Undo.
 */

const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()
const key = (text: string): string => flat(text).toLowerCase()

/** A document to sort: its page, title and text as sent. */
export interface SortSource {
  /** The note page it is (null for a file priced before it is imported). */
  pageId: string | null
  title: string
  text: string
}

/** A page's text as the sort sends it: a block a paragraph, a heading with its `#` marks. */
export function sortSourceText(content: TiptapNodeT | null): string {
  const lines: string[] = []
  for (const block of content?.content ?? []) {
    const text = docToText({ type: 'doc', content: [block] }).trim()
    if (text === '') continue
    if (block.type === 'heading') {
      const level = typeof block.attrs?.level === 'number' ? block.attrs.level : 1
      lines.push(`${'#'.repeat(level)} ${flat(text)}`)
    } else {
      lines.push(text)
    }
  }
  return lines.join('\n\n')
}

/**
 * Her folders and page titles as the prompt lists them (the Templates folder left out), folders
 * first, cut at `NOTES_SORT_LIST_CHARS` (the far pages go first).
 */
export function notesListing(items: readonly NotebookItem[]): string {
  const kept = items.filter(
    (item) =>
      !inTemplates(items, item.parentId) &&
      !(item.kind === 'folder' && isTemplatesFolder(item.title))
  )
  const path = (item: NotebookItem): string => {
    const at = folderPath(items, item.parentId)
    return at === '' ? item.title : `${at} › ${item.title}`
  }
  const folders = kept.filter((item) => item.kind === 'folder').map(path)
  const pages = kept.filter((item) => item.kind === 'page').map(path)
  const lines: string[] = []
  let used = 0
  const add = (label: string, names: readonly string[]): void => {
    if (names.length === 0) return
    let line = `${label}:`
    for (const [at, name] of names.entries()) {
      const piece = `${at === 0 ? ' ' : '; '}${name}`
      if (used + line.length + piece.length > NOTES_SORT_LIST_CHARS) {
        line += '; …'
        break
      }
      line += piece
    }
    used += line.length + 1
    lines.push(line)
  }
  add('Folders', folders)
  add('Pages', pages)
  return lines.join('\n')
}

/** The parts of a document, as the requests carry them. */
export function sortParts(text: string): string[] {
  return chunkText(text, NOTES_SORT_CHUNK_CHARS)
}

/** What sorting `sources` would send, counted locally: every request as it will be built. */
export function estimateNotesSort(
  sources: readonly SortSource[],
  items: readonly NotebookItem[]
): NotesSortEstimate {
  const listing = notesListing(items)
  let requests = 0
  let tokensIn = 0
  let tokensOut = 0
  let words = 0
  let counted = 0
  for (const source of sources) {
    const parts = sortParts(source.text)
    if (parts.length === 0) continue
    counted += 1
    words += source.text.split(/\s+/u).filter(Boolean).length
    for (const [index, text] of parts.entries()) {
      const prompt = buildNotesSortPrompt({
        listing,
        title: source.title,
        part: { index, count: parts.length },
        text
      })
      requests += 1
      tokensIn += estimateTokens(prompt.messages.map((message) => message.content).join('\n'))
      tokensOut += Math.min(
        NOTES_SORT_MAX_TOKENS,
        Math.ceil(estimateTokens(text) * NOTES_SORT_OUTPUT_RATIO) + 40
      )
    }
  }
  return { sources: counted, words, requests, tokensIn, tokensOut }
}

/** One page of her answer as main kept it. */
export interface SortedPage {
  folder: string
  title: string
  text: string
}

const SortAnswer = z.object({ pages: z.array(z.unknown()) })
const SortItem = z.object({
  folder: z.string().nullish(),
  title: z.string().nullish(),
  text: z.string().nullish()
})

const BAD_FORMAT = 'The model did not answer in the expected format.'

/**
 * Her answer for one part: each page kept when it has a title and every one of its lines is in
 * the part as sent; the rest (and any past `NOTES_SORT_PAGES_MAX`) counted as dropped. An answer
 * that is not the JSON asked for is an `AiFallbackError`.
 */
export function parseSortAnswer(
  answer: string,
  part: string
): { pages: SortedPage[]; dropped: number } {
  let json: unknown
  try {
    json = JSON.parse(answer)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const data = SortAnswer.safeParse(json)
  if (!data.success) throw new AiFallbackError(BAD_FORMAT, data.error)
  const pages: SortedPage[] = []
  let dropped = 0
  for (const entry of data.data.pages) {
    const parsed = SortItem.safeParse(entry)
    const item = parsed.success ? parsed.data : null
    const title = flat(item?.title ?? '').slice(0, NOTEBOOK_TITLE_MAX)
    const lines = (item?.text ?? '')
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '')
    const copied = lines.length > 0 && lines.every((line) => findQuote(part, line))
    if (pages.length >= NOTES_SORT_PAGES_MAX || title === '' || !copied) {
      dropped += 1
      continue
    }
    pages.push({ folder: flat(item?.folder ?? ''), title, text: lines.join('\n') })
  }
  return { pages, dropped }
}

/** A page's blocks from her lines: a line of `#` marks a heading (levels 1–3), the rest paragraphs. */
export function sortedBlocks(text: string): TiptapNodeT[] {
  return text.split('\n').map((line) => {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line)
    if (heading !== null) {
      return {
        type: 'heading',
        attrs: { level: Math.min(heading[1]?.length ?? 1, 3) },
        content: [{ type: 'text', text: heading[2] ?? '' }]
      }
    }
    return { type: 'paragraph', content: [{ type: 'text', text: line }] }
  })
}

/** What a sort has written so far: for the next part's writes and for the one Undo. */
export interface SortWrites {
  /** The documents being sorted: never appended to. */
  sources: ReadonlySet<string>
  /** Folders and pages made, in the order made. */
  made: NotebookItem[]
  madeIds: Set<string>
  /** The pages of hers appended to, each with the version kept before its first append. */
  appended: Map<string, NotesSortAppended>
  /** Every page written (made or appended to), each once. */
  written: Set<string>
}

export function newSortWrites(sources: Iterable<string>): SortWrites {
  return {
    sources: new Set(sources),
    made: [],
    madeIds: new Set(),
    appended: new Map(),
    written: new Set()
  }
}

const itemOf = (page: NotebookItem): NotebookItem => ({
  id: page.id,
  parentId: page.parentId,
  kind: page.kind,
  title: page.title,
  position: page.position,
  modified: page.modified
})

/**
 * Writes one part's pages: each into the folder she named (found, else made), appended to a page
 * of the same title there (under the document's title on the first append to a page of hers),
 * else made. Answers the ids written.
 */
export function writeSortedPages(
  db: TreeDb,
  pages: readonly SortedPage[],
  sourceTitle: string,
  writes: SortWrites
): string[] {
  const ids: string[] = []
  for (const page of pages) {
    const folder = ensureFolderPath(db, page.folder, (made) => {
      writes.made.push(itemOf(made))
      writes.madeIds.add(made.id)
      ids.push(made.id)
    })
    const parentId = folder?.id ?? null
    const existing = listNotebook(db).find(
      (item) =>
        item.kind === 'page' &&
        item.parentId === parentId &&
        key(item.title) === key(page.title) &&
        !writes.sources.has(item.id)
    )
    const blocks = sortedBlocks(page.text)
    if (existing === undefined) {
      const made = createNotebookItem(db, {
        parentId,
        kind: 'page',
        title: page.title,
        content: { type: 'doc', content: blocks }
      })
      writes.made.push(itemOf(made))
      writes.madeIds.add(made.id)
      writes.written.add(made.id)
      ids.push(made.id)
      continue
    }
    const current = getNotebookPage(db, existing.id)
    const ours = writes.madeIds.has(existing.id)
    const first = !ours && !writes.appended.has(existing.id)
    const heading: TiptapNodeT = {
      type: 'heading',
      attrs: { level: 2 },
      content: [{ type: 'text', text: sourceTitle }]
    }
    const content: TiptapNodeT = {
      type: 'doc',
      content: [...(current.content?.content ?? []), ...(first ? [heading] : []), ...blocks]
    }
    // A page this sort made needs no version (its Undo deletes it); hers keeps one, by `ai`.
    const { versionId } = updateNotebookItem(db, { id: existing.id, content }, ours ? 'me' : 'ai')
    if (first && versionId !== null) {
      writes.appended.set(existing.id, {
        pageId: existing.id,
        versionId,
        title: existing.title
      })
    }
    writes.written.add(existing.id)
    ids.push(existing.id)
  }
  return ids
}

export interface NotesSortDeps {
  db: TreeDb
  requestDeps: AiRequestDeps
  /** Told after each part's writes, with the ids written (`notebook:changed`). */
  notebookChanged: (ids: string[]) => void
  /** False once the project closed or changed: nothing more is sent or written. */
  live: () => boolean
  signal: AbortSignal
  /** Unique per sort, for the request ids. */
  runId: string
}

/** A sort's outcome; `stopped` is the cause when a provider error ended it after a part was written. */
export interface NotesSortOutcome {
  made: NotebookItem[]
  appended: NotesSortAppended[]
  pages: number
  dropped: number
  unread: number
  stopped: string | null
}

/** The note pages `pageIds` as documents to sort (a folder, a missing or empty page left out). */
export function sortSourcesOf(db: TreeDb, pageIds: readonly string[]): SortSource[] {
  const live = new Map(listNotebook(db).map((item) => [item.id, item]))
  return pageIds.flatMap((id) => {
    if (live.get(id)?.kind !== 'page') return []
    const page = getNotebookPage(db, id)
    const text = sortSourceText(page.content)
    return text.trim() === '' ? [] : [{ pageId: id, title: page.title, text }]
  })
}

/**
 * Sorts the pages, a part a request: the listing is taken once, so every request of the sort
 * shares its cached prefix. A part whose answer cannot be read is counted (`unread`) and the
 * sort goes on; a provider error before anything is written is thrown, after it the sort stops
 * and answers what it wrote.
 */
export async function runNotesSort(
  deps: NotesSortDeps,
  pageIds: readonly string[]
): Promise<NotesSortOutcome> {
  const { db } = deps
  assertFeatureAllowed(getAiSettings(db), 'notesSort')
  const sources = sortSourcesOf(db, pageIds)
  const listing = notesListing(listNotebook(db))
  const writes = newSortWrites(sources.flatMap((source) => source.pageId ?? []))
  let dropped = 0
  let unread = 0
  let stopped: string | null = null
  const work = sources.flatMap((source) => {
    const parts = sortParts(source.text)
    return parts.map((text, index) => ({ source, text, index, count: parts.length }))
  })
  for (const [at, part] of work.entries()) {
    if (!deps.live()) break
    const prompt = buildNotesSortPrompt({
      listing,
      title: part.source.title,
      part: { index: part.index, count: part.count },
      text: part.text
    })
    let answer: Awaited<ReturnType<typeof requestWithRetry>>
    try {
      // The author can turn Use AI or the feature off mid-sort: it stops there.
      assertFeatureAllowed(getAiSettings(db), 'notesSort')
      answer = await requestWithRetry(
        deps.requestDeps,
        (attempt) => ({
          feature: 'notesSort',
          tier: NOTES_SORT_TIER,
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(JSON.stringify(prompt.messages)),
          promptVersion: prompt.version,
          requestId: `sort-${deps.runId}:${at}:${attempt}`
        }),
        deps.signal,
        () => undefined
      )
    } catch (err) {
      // An answer cut off or unreadable loses that part only; the sort goes on.
      if (err instanceof AiCutOffError || err instanceof AiFallbackError) {
        unread += 1
        continue
      }
      if (!(err instanceof AiProviderError) || writes.written.size === 0) throw err
      stopped = err.message
      unread += work.length - at
      break
    }
    if (!deps.live()) break
    let parsed: ReturnType<typeof parseSortAnswer> | null = null
    try {
      parsed = parseSortAnswer(answer.text, part.text)
    } catch (err) {
      if (!(err instanceof AiFallbackError)) throw err
      unread += 1
    }
    const proposal = createProposal(db, {
      feature: 'notesSort',
      nodeId: null,
      promptVersion: prompt.version,
      model: answer.model,
      promptTokens: answer.usage.inputTokens,
      completionTokens: answer.usage.outputTokens,
      costUsd: answer.costUsd,
      cached: answer.cached,
      regeneratedFrom: null,
      content: JSON.stringify(parsed?.pages ?? []),
      flagged: false,
      violation: null
    })
    if (parsed === null) continue
    dropped += parsed.dropped
    const pages = parsed.pages
    const ids = db.transaction((tx) => writeSortedPages(tx, pages, part.source.title, writes))
    // Applied as they came, with one Undo for the sort (the notes rule of AI edits, 2026-10-15).
    if (ids.length > 0) {
      settleProposal(db, proposal.id, 'accepted')
      deps.notebookChanged(ids)
    }
  }
  return {
    made: writes.made,
    appended: [...writes.appended.values()],
    pages: writes.written.size,
    dropped,
    unread,
    stopped
  }
}
