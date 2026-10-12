import { ENTITY_IMAGES_DIR } from '@shared/entities'
import {
  estimateContextCost,
  type ContextEstimate,
  type ContextImageHint,
  type ContextProgress
} from '@shared/contextLibrary'
import { docToText } from '@shared/docText'
import {
  filingChunks,
  parseFilingAnswer,
  planFiling,
  writtenLines,
  type FiledRecord,
  type FilingApplyResult,
  type FilingItem,
  type FilingLine,
  type FilingReview,
  type FilingRosterRecord,
  type FilingUndoResult
} from '@shared/filing'
import { JOB_MIN_INTERVAL_MS } from '@shared/jobs'
import { normName } from '@shared/memory/names'
import {
  AI_FILED_ATTR,
  aiFiledOf,
  markedParagraphs,
  NOT_CANON_ATTR,
  pageTextBlocks,
  type MarkedParagraph
} from '@shared/memory/pageMarks'
import type { StoryRecord } from '@shared/memory/records'
import type { TiptapNodeT } from '@shared/tiptap'
import {
  CONTEXT_SPLIT_DEPTH,
  halvePiece,
  SortCategories,
  type ContextChunk
} from '../ai/contextImport'
import { assertFeatureAllowed } from '../ai/dial'
import { cancelInflight } from '../ai/inflight'
import {
  buildContextImportPromptV3,
  CONTEXT_IMPORT_PROMPT_V3_VERSION,
  type FilingRosterGroup
} from '../ai/prompts/contextImport.v3'
import { createProposal, settleProposal } from '../ai/proposalStore'
import { AiCancelledError, AiFallbackError, type CompletionUsage } from '../ai/providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from '../ai/request'
import { getDocumentContent } from '../document/documentStore'
import { createCategory, listCategories } from '../entity/categoryStore'
import { AppError } from '../ipc/errors'
import { dismissedKeys } from '../memory/dismissedStore'
import {
  addAlias,
  createRecord,
  deleteRecord,
  dismissedNames,
  getRecord,
  listRecords,
  removeFiledAlias,
  savePage,
  updateRecord
} from '../memory/recordStore'
import { recordInDetails } from '../memory/sceneDetailStore'
import { addImageAsset, removeImageAsset } from '../project/imageAssets'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import {
  listResearchDocs,
  requireResearchDocument,
  researchDocOf,
  researchFiled,
  researchOriginalPath,
  setResearchFiled
} from './researchStore'

/**
 * Filing an upload into Pinned (F-16.9, decision 6; story memory v2, P1 slice 5): the main half.
 * A Research page's canon paragraphs go out once, chunk by chunk, as `contextImport.v3` on the
 * strong tier with reasoning off (a ledger row and a pending proposal each, the v1 sort's halving
 * of a piece whose answer was cut off); `planFiling` turns the answers into the review. Apply
 * writes what the author kept in one transaction (records and names with origin `filed`, the
 * accepted categories, pictures, Pinned paragraphs marked `aiFiled`) and marks the page filed, so
 * filing runs once. One in-session *Undo filing* takes back what is still as it was written.
 */

/** A Research page as filing reads it. */
export interface FilingSource {
  nodeId: string
  title: string
  /** Every paragraph of the page, in `markedParagraphs` order. */
  paragraphs: MarkedParagraph[]
  /** The canon paragraphs, packed into the requests' chunks. */
  chunks: string[]
  /** The hash of the page's text: what the filed lines are checked against later. */
  hash: string
}

/** The hash of a page's text as the filed-line check compares it. */
export function pageHash(paragraphs: readonly { text: string }[]): string {
  return sha256(paragraphs.map((paragraph) => paragraph.text).join('\n'))
}

/** A page's paragraphs (none for an empty page). */
export function pageParagraphs(db: TreeDb, nodeId: string): MarkedParagraph[] {
  const { content } = getDocumentContent(db, nodeId)
  return content === null ? [] : markedParagraphs(content)
}

const dateOf = (iso: string): string => iso.slice(0, 10)

/**
 * The page to file: NOT_FOUND when gone, VALIDATION for something else, a page filed already
 * (filing runs once), a page marked Not canon as a whole, or one with no canon text.
 */
export function filingSource(db: TreeDb, nodeId: string): FilingSource {
  const row = requireResearchDocument(db, nodeId)
  const filed = researchFiled(db, nodeId).filedAt
  if (filed !== null) {
    throw new AppError(
      'VALIDATION',
      `This document was filed on ${dateOf(filed)}; filing runs once.`,
      {
        nodeId
      }
    )
  }
  if (researchDocOf(db, nodeId).notCanon) {
    throw new AppError(
      'VALIDATION',
      'This document is marked Not canon, so nothing in it is filed as true. Switch it to canon to file it.',
      { nodeId }
    )
  }
  const paragraphs = pageParagraphs(db, nodeId)
  const chunks = filingChunks(paragraphs)
  if (chunks.length === 0) {
    throw new AppError('VALIDATION', 'There is no canon text on this page to file.', { nodeId })
  }
  return { nodeId, title: row.title, paragraphs, chunks, hash: pageHash(paragraphs) }
}

/** What filing the page would cost (the strong tier), shown before anything is sent. */
export function estimateFiling(db: TreeDb, nodeId: string, model: string): ContextEstimate {
  const source = filingSource(db, nodeId)
  return estimateContextCost(
    source.chunks.map((chunk) => chunk.length),
    1,
    model
  )
}

/** A record as the planner reads it: its names, its Pinned canon paragraphs, whether it has a picture. */
function rosterRecord(record: StoryRecord): FilingRosterRecord {
  return {
    id: record.id,
    name: record.name,
    categoryId: record.categoryId,
    names: record.aliases.map((alias) => ({ text: alias.text, shared: alias.shared })),
    pinned:
      record.pinned === null
        ? []
        : markedParagraphs(record.pinned)
            .filter((paragraph) => !paragraph.notCanon)
            .map((paragraph) => ({ index: paragraph.index, text: paragraph.text })),
    hasImage: record.image !== null
  }
}

/** The Research image pages, by the name the prompt lists them under (the original's file name). */
function imagePages(db: TreeDb): { nodeId: string; name: string }[] {
  return listResearchDocs(db)
    .filter((doc) => doc.fileType === 'image' && doc.fileName !== null)
    .map((doc) => ({ nodeId: doc.nodeId, name: doc.fileName ?? '' }))
}

export interface FileResearchInput {
  nodeId: string
  /** The renderer's id for `ai:cancel`; each chunk registers under `<requestId>:c<n>`. */
  requestId: string
  signal?: AbortSignal
  onProgress?: (progress: ContextProgress) => void
}

function stopIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiCancelledError('Filing the document was stopped.')
}

/** Never hold the process open between two chunks. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  })
}

/**
 * Files the page (F-16.9) and answers the review. Refused with DISABLED when Use AI or the
 * feature's toggle is off (`contextImport`); every chunk is a ledger row on the strong tier with
 * reasoning off, and a pending proposal the renderer settles at Apply or Cancel (here, when the
 * pass stops or fails partway). Nothing is written.
 */
export async function fileResearch(
  db: TreeDb,
  deps: AiRequestDeps,
  input: FileResearchInput
): Promise<FilingReview> {
  assertFeatureAllowed(getAiSettings(db), 'contextImport')
  const source = filingSource(db, input.nodeId)
  const summaries = listRecords(db)
  const records = summaries.flatMap((summary) => {
    const found = getRecord(db, summary.id)
    return found === null ? [] : [found]
  })
  const categories = new SortCategories(listCategories(db))
  const roster: FilingRosterGroup[] = categories.project.map((category) => ({
    category,
    records: summaries
      .filter((record) => record.categoryId === category.id)
      .map((record) => ({
        name: record.name,
        aliases: record.aliases.filter((alias) => !alias.isMain).map((alias) => alias.text)
      }))
  }))
  const images = imagePages(db)
  const imageNames = images.map((image) => image.name)

  const filed: FiledRecord[] = []
  const hints: ContextImageHint[] = []
  const proposalIds: string[] = []
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let model = ''
  let inFlight: string | null = null
  const onAbort = (): void => {
    if (inFlight !== null) cancelInflight(inFlight)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    for (const [index, text] of source.chunks.entries()) {
      const chunk: ContextChunk = {
        fileId: source.nodeId,
        fileName: source.title,
        part: index + 1,
        parts: source.chunks.length,
        changedOnly: false,
        text
      }
      const queue = [{ piece: chunk, depth: 0, id: `${input.requestId}:c${index}` }]
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) break
        const { piece, depth, id: chunkId } = next
        stopIfCancelled(input.signal)
        const prompt = buildContextImportPromptV3({
          categories: categories.project,
          roster,
          images: imageNames,
          title: source.title,
          part: piece.part,
          parts: piece.parts,
          text: piece.text
        })
        inFlight = chunkId
        const answer = await runAiRequest(deps, {
          feature: 'contextImport',
          tier: 'strong',
          messages: prompt.messages,
          maxTokens: prompt.maxTokens,
          json: true,
          contextHash: sha256(prompt.messages.map((m) => m.content).join('\n')),
          promptVersion: prompt.version,
          requestId: chunkId
        })
        inFlight = null
        stopIfCancelled(input.signal)
        usage.inputTokens += answer.usage.inputTokens
        usage.outputTokens += answer.usage.outputTokens
        costUsd += answer.costUsd
        model = answer.model
        proposalIds.push(
          createProposal(db, {
            feature: 'contextImport',
            nodeId: source.nodeId,
            promptVersion: prompt.version,
            model: answer.model,
            promptTokens: answer.usage.inputTokens,
            completionTokens: answer.usage.outputTokens,
            costUsd: answer.costUsd,
            cached: answer.cached,
            content: answer.text,
            flagged: null,
            violation: null
          }).id
        )
        const parsed = answer.finishReason === 'length' ? null : parseFilingAnswer(answer.text)
        if (parsed === null) {
          const halves = depth < CONTEXT_SPLIT_DEPTH ? halvePiece(piece) : null
          if (halves === null) {
            throw new AiFallbackError(
              `The model's answer for "${source.title}" was cut off or unreadable, even in smaller pieces. Try again later.`
            )
          }
          queue.unshift(
            { piece: halves[0], depth: depth + 1, id: `${chunkId}a` },
            { piece: halves[1], depth: depth + 1, id: `${chunkId}b` }
          )
          continue
        }
        categories.learn(parsed)
        for (const item of parsed.records ?? []) {
          filed.push({
            name: item.name,
            categoryId: categories.resolve(item.category).id,
            aliases: item.aliases ?? [],
            lines: item.lines ?? []
          })
        }
        for (const image of parsed.images ?? []) {
          if (imageNames.includes(image.file))
            hints.push({ fileName: image.file, name: image.name })
        }
      }
      input.onProgress?.({ done: index + 1, total: source.chunks.length, costUsd })
      if (index < source.chunks.length - 1) {
        await delay(JOB_MIN_INTERVAL_MS)
        stopIfCancelled(input.signal)
      }
    }
  } catch (err) {
    // Nothing the pass found reaches a review, so its proposals are settled here (F-14.5); the
    // ledger rows stay: the money was spent.
    for (const id of proposalIds) settleProposal(db, id, 'rejected')
    throw err
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }

  const plan = planFiling({
    records: filed,
    paragraphs: source.paragraphs,
    roster: records.map(rosterRecord),
    dismissedNames: dismissedNames(db),
    dismissedAliases: dismissedKeys(db, 'alias'),
    images,
    imageHints: hints.map((hint) => ({ file: hint.fileName, name: hint.name }))
  })
  return {
    docId: source.nodeId,
    docTitle: source.title,
    docHash: source.hash,
    items: plan.items,
    categories: categories.forReview(),
    dropped: plan.dropped,
    proposalIds,
    chunks: source.chunks.length,
    usage,
    costUsd,
    model,
    promptVersion: CONTEXT_IMPORT_PROMPT_V3_VERSION
  }
}

// ---------------------------------------------------------------------------------------------
// Apply and Undo

/** A filed line as a Pinned paragraph: its words, marked `aiFiled` with where they came from. */
export function filedBlock(
  docId: string,
  line: Pick<FilingLine, 'text' | 'para' | 'quote'>
): TiptapNodeT {
  return {
    type: 'paragraph',
    attrs: {
      [NOT_CANON_ATTR]: false,
      [AI_FILED_ATTR]: { doc: docId, para: line.para, quote: line.quote }
    },
    content: [{ type: 'text', text: line.text }]
  }
}

/** One filed paragraph, for the undo: its words, its quote, and the paragraph it replaced. */
interface WrittenBlock {
  recordId: string
  text: string
  quote: string
  replaced: TiptapNodeT | null
}

interface FilingUndo {
  docId: string
  filedBefore: { filedAt: string | null; filedHash: string | null }
  /** The records Apply made, with their `modified` right after it (unchanged since: removable). */
  created: { id: string; modified: string }[]
  aliases: { recordId: string; norm: string }[]
  blocks: WrittenBlock[]
  images: { recordId: string; file: string }[]
}

let lastFiling: FilingUndo | null = null

/** Forgets the last filing's undo (a project closed or another opened). */
export function clearFilingUndo(): void {
  lastFiling = null
}

/** Whether a filing can still be undone. For tests. */
export function canUndoFiling(): boolean {
  return lastFiling !== null
}

/**
 * The page with the item's lines written: an update, or a conflict the author decided for the
 * upload, replaces its Pinned paragraph when that paragraph still reads as it did (else it is
 * added); every other line is added at the end.
 */
function withLines(
  pinned: TiptapNodeT | null,
  docId: string,
  lines: readonly FilingLine[],
  recordId: string,
  written: WrittenBlock[]
): TiptapNodeT {
  const doc: TiptapNodeT = pinned ?? { type: 'doc', content: [] }
  const top = [...(doc.content ?? [])]
  const blocks = pinned === null ? [] : pageTextBlocks(pinned)
  for (const line of lines) {
    const block = filedBlock(docId, line)
    const target =
      line.replaces === null
        ? undefined
        : blocks.find(
            (each) =>
              each.index === line.replaces?.index &&
              each.text === line.replaces.text &&
              each.block.type === 'paragraph'
          )
    const at = target === undefined ? -1 : top.indexOf(target.block)
    if (at >= 0 && target !== undefined) {
      top[at] = block
      written.push({ recordId, text: line.text, quote: line.quote, replaced: target.block })
    } else {
      top.push(block)
      written.push({ recordId, text: line.text, quote: line.quote, replaced: null })
    }
  }
  return { ...doc, content: top }
}

/**
 * Writes the reviewed filing in one transaction (F-16.9): each included item's new record (origin
 * `filed`, its new names `filed`, the accepted proposed category created first), its new names on
 * an existing record (one another record took since is skipped), its lines into Pinned marked
 * `aiFiled`, and its picture when the record has none (copied before, removed again on failure);
 * then the page is marked filed (`filed_at`, `filed_hash`). VALIDATION when the page was filed
 * already. The undo is kept for the session.
 */
export function applyFiling(
  db: TreeDb,
  folder: string,
  review: FilingReview,
  now: Date
): FilingApplyResult {
  const filedBefore = researchFiled(db, review.docId)
  if (filedBefore.filedAt !== null) {
    throw new AppError(
      'VALIDATION',
      `This document was filed on ${dateOf(filedBefore.filedAt)}; filing runs once.`,
      { nodeId: review.docId }
    )
  }
  requireResearchDocument(db, review.docId)
  const included = review.items.filter((item) => item.include)
  const copies = new Map<string, string>()
  for (const item of included) {
    if (item.image === null) continue
    if (item.recordId !== null && getRecord(db, item.recordId)?.image != null) continue
    try {
      const source = researchOriginalPath(db, folder, item.image.nodeId)
      copies.set(
        item.id,
        addImageAsset(folder, ENTITY_IMAGES_DIR, source, 'image', item.image.name)
      )
    } catch {
      // A picture that cannot be read leaves the record without one; the lines still file.
    }
  }

  const undo: FilingUndo = {
    docId: review.docId,
    filedBefore,
    created: [],
    aliases: [],
    blocks: [],
    images: []
  }
  const at = now.toISOString()
  let created = 0
  let updated = 0
  let lines = 0
  const touched: string[] = []
  try {
    db.transaction((tx) => {
      const madeCategories = new Map<string, string>()
      for (const category of review.categories) {
        if (!category.proposed) continue
        if (!included.some((item) => item.recordId === null && item.categoryId === category.id)) {
          continue
        }
        const made = createCategory(
          tx,
          {
            name: category.name,
            noun: category.noun,
            icon: category.icon,
            fields: category.fields.filter((field) => field.id !== 'notes').map((f) => f.label),
            hint: category.hint
          },
          'ai'
        )
        madeCategories.set(category.id, made.id)
      }
      for (const item of included) {
        const recordId = writeItem(tx, item, madeCategories, now, undo)
        if (recordId === null) continue
        const written = writtenLines(item)
        if (written.length > 0) {
          const current = getRecord(tx, recordId)
          savePage(
            tx,
            recordId,
            'pinned',
            withLines(current?.pinned ?? null, review.docId, written, recordId, undo.blocks),
            now
          )
          lines += written.length
        }
        const copy = copies.get(item.id)
        if (copy !== undefined) {
          updateRecord(tx, recordId, { image: copy }, now)
          undo.images.push({ recordId, file: copy })
        }
        if (item.recordId === null) created += 1
        else updated += 1
        touched.push(recordId)
      }
      setResearchFiled(tx, review.docId, { filedAt: at, filedHash: review.docHash }, now)
      for (const made of undo.created) {
        made.modified = getRecord(tx, made.id)?.modified ?? made.modified
      }
    })
  } catch (err) {
    for (const copy of copies.values()) removeImageAsset(folder, ENTITY_IMAGES_DIR, copy)
    throw err
  }
  // A copied picture the transaction did not use (the record had one by then) goes.
  const used = new Set(undo.images.map((image) => image.file))
  for (const copy of copies.values()) {
    if (!used.has(copy)) removeImageAsset(folder, ENTITY_IMAGES_DIR, copy)
  }
  lastFiling = undo
  return { created, updated, lines, recordIds: touched, filedAt: at }
}

/** Writes one item's record (new) or names (existing); answers the record's id, or null when gone. */
function writeItem(
  db: TreeDb,
  item: FilingItem,
  madeCategories: ReadonlyMap<string, string>,
  now: Date,
  undo: FilingUndo
): string | null {
  if (item.recordId === null) {
    const made = createRecord(
      db,
      {
        name: item.name,
        categoryId: madeCategories.get(item.categoryId) ?? item.categoryId,
        aliases: item.aliases.map((text) => ({ text, origin: 'filed' as const })),
        origin: 'filed',
        force: true
      },
      now
    )
    if (!('record' in made)) return null
    undo.created.push({ id: made.record.id, modified: made.record.modified })
    return made.record.id
  }
  if (getRecord(db, item.recordId) === null) return null
  for (const text of item.aliases) {
    try {
      addAlias(db, item.recordId, { text, origin: 'filed' }, now)
      undo.aliases.push({ recordId: item.recordId, norm: normName(text) })
    } catch (err) {
      // A name another record took since (or no room left) is left out; the rest files.
      if (!(err instanceof AppError)) throw err
    }
  }
  return item.recordId
}

/** Whether a stored top-level block is the filed paragraph `written` wrote, still as written. */
function isWritten(block: TiptapNodeT, docId: string, written: WrittenBlock): boolean {
  const filed = aiFiledOf(block)
  return (
    block.type === 'paragraph' &&
    filed !== null &&
    filed.doc === docId &&
    filed.quote === written.quote &&
    docToText({ type: 'doc', content: [block] }).trim() === written.text
  )
}

/**
 * *Undo filing* (F-16.9): takes back the last filing where it is still as Apply wrote it. A filed
 * paragraph still marked `aiFiled` (the author's edit clears the mark) goes, or gives its place back
 * to the paragraph it replaced; a filed nickname goes; a picture still the record's goes; a record
 * Apply made goes when nothing changed it since and no scene's details name it; the page is no
 * longer filed. What the author changed stays and is counted. The undo is spent either way.
 */
export function undoFiling(db: TreeDb, folder: string, now: Date): FilingUndoResult {
  const entry = lastFiling
  if (entry === null) throw new AppError('VALIDATION', 'There is no filing to undo')
  lastFiling = null
  let kept = 0
  const touched = new Set<string>()
  const deleted: string[] = []
  const dropFiles: string[] = []
  db.transaction((tx) => {
    // Decided first: the undo's own writes below change a record's `modified`.
    const removable = new Set(
      entry.created
        .filter((made) => {
          const record = getRecord(tx, made.id)
          return (
            record !== null && record.modified === made.modified && !recordInDetails(tx, made.id)
          )
        })
        .map((made) => made.id)
    )
    const byRecord = new Map<string, WrittenBlock[]>()
    for (const block of entry.blocks) {
      byRecord.set(block.recordId, [...(byRecord.get(block.recordId) ?? []), block])
    }
    for (const [recordId, blocks] of byRecord) {
      if (removable.has(recordId)) continue
      const record = getRecord(tx, recordId)
      if (record === null) continue
      const top = [...(record.pinned?.content ?? [])]
      for (const written of blocks) {
        const at = top.findIndex((block) => isWritten(block, entry.docId, written))
        if (at < 0) {
          kept += 1
          continue
        }
        if (written.replaced === null) top.splice(at, 1)
        else top[at] = written.replaced
      }
      savePage(
        tx,
        recordId,
        'pinned',
        record.pinned === null ? null : { ...record.pinned, content: top },
        now
      )
      touched.add(recordId)
    }
    for (const alias of entry.aliases) {
      if (removable.has(alias.recordId)) continue
      if (removeFiledAlias(tx, alias.recordId, alias.norm, now)) touched.add(alias.recordId)
    }
    for (const image of entry.images) {
      if (removable.has(image.recordId)) {
        dropFiles.push(image.file)
        continue
      }
      if (getRecord(tx, image.recordId)?.image !== image.file) continue
      updateRecord(tx, image.recordId, { image: null }, now)
      dropFiles.push(image.file)
      touched.add(image.recordId)
    }
    for (const made of entry.created) {
      if (!removable.has(made.id)) {
        if (getRecord(tx, made.id) !== null) kept += 1
        continue
      }
      deleteRecord(tx, made.id)
      deleted.push(made.id)
    }
    setResearchFiled(tx, entry.docId, entry.filedBefore, now)
  })
  for (const file of dropFiles) removeImageAsset(folder, ENTITY_IMAGES_DIR, file)
  return { recordIds: [...touched], deleted, kept }
}
