import { z } from 'zod'
import {
  CATEGORY_FIELD_LABEL_MAX,
  CATEGORY_NAME_MAX,
  categoryFromInput,
  categoryOf,
  customCategoryId,
  isKnownCategory,
  type StoryCategory
} from '@shared/categories'
import {
  CONTEXT_PROPOSED_CATEGORIES_MAX,
  CONTEXT_PROPOSED_FIELDS_MAX,
  changedParagraphs,
  chunkParagraphs,
  estimateContextCost,
  planContextReview,
  PROJECT_NOTES_NAME,
  recordFields,
  splitParagraphs,
  type ContextEstimate,
  type ContextImageHint,
  type ContextProgress,
  type ContextRecord,
  type ContextReview,
  type ContextReviewCategory
} from '@shared/contextLibrary'
import { ENTITY_NAME_MAX, toEntityNameKey } from '@shared/entities'
import { JOB_MIN_INTERVAL_MS } from '@shared/jobs'
import { listCategories } from '../entity/categoryStore'
import { listEntities } from '../entity/entityStore'
import { readContextText, requireContextFileRow, type LibraryDb } from '../library/libraryStore'
import { getAiSettings } from '../project/settingsStore'
import { assertFeatureAllowed } from './dial'
import { cancelInflight } from './inflight'
import {
  buildContextImportPromptV2,
  CONTEXT_IMPORT_PROMPT_V2_VERSION,
  type ContextSheetGroup
} from './prompts/contextImport.v2'
import { createProposal, settleProposal } from './proposalStore'
import { AiCancelledError, AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'

/**
 * The context library's AI pass (F-9.8): the chosen files read back into the review the author
 * edits before anything lands. Each text file is split into paragraphs — for a file updated since
 * it was last sorted, only the paragraphs it did not have then — packed into chunks of at most
 * `CONTEXT_CHUNK_CHARS` at paragraph boundaries, and each chunk is sent once on the strong tier
 * in JSON mode, serially with the index queue's spacing, like the import structure pass (F-12.3)
 * and for the same reason: nothing may be written before Apply, so the persistent queue is not
 * the place. Each chunk's raw answer is one proposal (F-14.5), settled by the renderer at Apply
 * or Cancel and here when the pass stops or fails partway. The pure planner then merges what
 * every chunk found across files and against the existing sheets.
 */

/** One request's worth of one file. */
export interface ContextChunk {
  fileId: string
  fileName: string
  part: number
  parts: number
  changedOnly: boolean
  text: string
}

/** What the chosen files amount to: the chunks to send and the images to match. */
export interface ContextWork {
  chunks: ContextChunk[]
  /** Text files with something to send. */
  files: number
  images: { id: string; name: string }[]
}

/** Reads the chosen files and cuts what is new in them into chunks. Unknown ids are NOT_FOUND. */
export async function contextWork(
  db: LibraryDb,
  folder: string,
  fileIds: readonly string[]
): Promise<ContextWork> {
  const work: ContextWork = { chunks: [], files: 0, images: [] }
  for (const id of fileIds) {
    const row = requireContextFileRow(db, id)
    if (row.type === 'image') {
      work.images.push({ id: row.id, name: row.name })
      continue
    }
    const text = await readContextText(folder, row)
    if (text === null) continue
    // An updated file sends only what changed; a file sorted as it stands is read whole again
    // (the author asked to reprocess it; the review still leaves out what the sheets hold).
    const changedOnly =
      row.processedText !== null && row.processedHash !== null && row.processedHash !== row.textHash
    const paragraphs = changedOnly
      ? changedParagraphs(splitParagraphs(text), splitParagraphs(row.processedText ?? ''))
      : splitParagraphs(text)
    if (paragraphs.length === 0) continue
    const chunks = chunkParagraphs(paragraphs)
    work.files += 1
    chunks.forEach((chunk, index) =>
      work.chunks.push({
        fileId: row.id,
        fileName: row.name,
        part: index + 1,
        parts: chunks.length,
        changedOnly,
        text: chunk
      })
    )
  }
  return work
}

/** The estimate shown before the author confirms (F-9.8). */
export async function estimateContextImport(
  db: LibraryDb,
  folder: string,
  fileIds: readonly string[],
  model: string
): Promise<ContextEstimate> {
  const work = await contextWork(db, folder, fileIds)
  return estimateContextCost(
    work.chunks.map((chunk) => chunk.text.length),
    work.files,
    model
  )
}

export interface SortContextInput {
  folder: string
  fileIds: readonly string[]
  /** The renderer's id for `ai:cancel` (F-5.10); each chunk registers under `<requestId>:c<n>`. */
  requestId: string
  signal?: AbortSignal
  onProgress?: (progress: ContextProgress) => void
}

/** The model's answer, read leniently: a bad item is dropped, a bad shape is PROVIDER. */
const ModelAnswer = z.object({
  entities: z
    .array(
      z.object({
        kind: z.string(),
        name: z.string(),
        aliases: z.array(z.string()).nullish(),
        fields: z.record(z.string(), z.unknown()).nullish(),
        details: z.array(z.string()).nullish()
      })
    )
    .nullish(),
  notes: z.array(z.string()).nullish(),
  images: z.array(z.object({ file: z.string(), name: z.string() })).nullish(),
  /** F-9.11: categories the model proposes for things no category fits. */
  categories: z
    .array(
      z.object({
        kind: z.string(),
        name: z.string(),
        noun: z.string().nullish(),
        fields: z.array(z.string()).nullish()
      })
    )
    .nullish()
})
type ModelAnswer = z.infer<typeof ModelAnswer>

/**
 * The categories of one sort (F-9.11): the project's, and the new ones the model proposed, each
 * under a provisional `c-…` id. A proposal named like a category the project has (by name or
 * singular) is that category; past `CONTEXT_PROPOSED_CATEGORIES_MAX` the rest are not taken, and
 * their things are filed under World.
 */
export class SortCategories {
  readonly proposed: ContextReviewCategory[] = []
  private readonly byToken = new Map<string, string>()

  constructor(readonly project: readonly StoryCategory[]) {}

  private all(): StoryCategory[] {
    return [...this.project, ...this.proposed]
  }

  /** Takes in what one answer proposed. */
  learn(answer: ModelAnswer): void {
    for (const given of answer.categories ?? []) {
      const token = given.kind.trim().toLowerCase()
      const name = given.name.trim().slice(0, CATEGORY_NAME_MAX).trim()
      if (token === '' || name === '' || this.byToken.has(token)) continue
      if (isKnownCategory(token, this.project)) continue
      const same = this.byName(name)
      if (same !== undefined) {
        this.byToken.set(token, same.id)
        continue
      }
      if (this.proposed.length >= CONTEXT_PROPOSED_CATEGORIES_MAX) continue
      const id = customCategoryId(
        name,
        this.all().map((category) => category.id)
      )
      const noun = given.noun?.trim().slice(0, CATEGORY_NAME_MAX).trim()
      const fields = (given.fields ?? [])
        .map((label) => label.trim().slice(0, CATEGORY_FIELD_LABEL_MAX).trim())
        .filter((label) => label !== '')
        .slice(0, CONTEXT_PROPOSED_FIELDS_MAX)
      const category = categoryFromInput(
        id,
        { name, ...(noun ? { noun } : {}), fields, hint: '' },
        'ai'
      )
      this.proposed.push({ ...category, proposed: true })
      this.byToken.set(token, id)
    }
  }

  private byName(name: string): StoryCategory | undefined {
    const key = name.toLowerCase()
    return this.all().find(
      (category) => category.name.toLowerCase() === key || category.noun.toLowerCase() === key
    )
  }

  /** The category the model meant by `kind`; World when it is none the sort knows. */
  resolve(kind: string): StoryCategory {
    const token = kind.trim().toLowerCase()
    const id =
      this.byToken.get(token) ??
      (isKnownCategory(token, this.project) ? token : this.byName(token)?.id)
    return categoryOf(id ?? 'world', this.all())
  }

  /** The review's categories: the project's own (for their templates) and the proposed ones. */
  forReview(): ContextReviewCategory[] {
    return [
      ...this.project
        .filter((category) => !category.builtIn)
        .map((category) => ({ ...category, proposed: false })),
      ...this.proposed
    ]
  }
}

const BAD_FORMAT = 'The model did not answer in the expected format.'

function parseAnswer(text: string): ModelAnswer {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (err) {
    throw new AiFallbackError(BAD_FORMAT, err)
  }
  const parsed = ModelAnswer.safeParse(json)
  if (!parsed.success) throw new AiFallbackError(BAD_FORMAT, parsed.error)
  return parsed.data
}

/** How many times a cut-off piece is halved and asked again before the sort fails (2026-10-08). */
export const CONTEXT_SPLIT_DEPTH = 2
/** A piece shorter than this is not halved: its answer was not cut off for being long. */
const CONTEXT_MIN_SPLIT_CHARS = 1_000

/**
 * A piece cut in two at the paragraph nearest its middle (or, for one long paragraph, at the
 * sentence end nearest it); null when it is too short to halve.
 */
export function halvePiece(piece: ContextChunk): [ContextChunk, ContextChunk] | null {
  const text = piece.text.trim()
  if (text.length < CONTEXT_MIN_SPLIT_CHARS) return null
  const middle = text.length / 2
  const breaks = [...text.matchAll(/\n\s*\n/g)].map((m) => m.index)
  const sentences = [...text.matchAll(/[.!?…]["”’)]?\s+/g)].map((m) => m.index + m[0].length)
  const candidates = breaks.length > 0 ? breaks : sentences
  if (candidates.length === 0) return null
  const at = candidates.reduce((best, c) =>
    Math.abs(c - middle) < Math.abs(best - middle) ? c : best
  )
  const first = text.slice(0, at).trim()
  const second = text.slice(at).trim()
  if (first === '' || second === '') return null
  return [
    { ...piece, text: first },
    { ...piece, text: second }
  ]
}

const NOTES_KEY = toEntityNameKey(PROJECT_NOTES_NAME)

/**
 * The answer's entities as records of this chunk; nameless items are dropped, and an item of a
 * kind the sort does not know is filed under World (F-9.11).
 */
function toRecords(
  answer: ModelAnswer,
  chunk: ContextChunk,
  first: number,
  categories: SortCategories
): ContextRecord[] {
  const records: ContextRecord[] = []
  for (const item of answer.entities ?? []) {
    const category = categories.resolve(item.kind)
    const name = item.name.trim().slice(0, ENTITY_NAME_MAX).trim()
    if (name === '' || toEntityNameKey(name) === NOTES_KEY) continue
    records.push({
      id: `r${first + records.length + 1}`,
      fileId: chunk.fileId,
      fileName: chunk.fileName,
      kind: category.id,
      name,
      aliases: (item.aliases ?? [])
        .map((alias) => alias.trim().slice(0, ENTITY_NAME_MAX))
        .filter((alias) => alias !== ''),
      fields: recordFields(category, item.fields ?? {}),
      details: (item.details ?? []).map((detail) => detail.trim()).filter((d) => d !== '')
    })
  }
  return records
}

/**
 * Sorts the chosen files (F-9.8) and answers the review. Refused with DISABLED when Use AI or the
 * feature's toggle is off; every chunk is a ledger row on the strong tier.
 */
export async function sortContextFiles(
  db: LibraryDb,
  deps: AiRequestDeps,
  input: SortContextInput
): Promise<ContextReview> {
  assertFeatureAllowed(getAiSettings(db), 'contextImport')
  const work = await contextWork(db, input.folder, input.fileIds)
  const existing = listEntities(db)
  const categories = new SortCategories(listCategories(db))
  const sheets: ContextSheetGroup[] = categories.project.map((category) => ({
    category,
    names: existing.filter((entity) => entity.kind === category.id).map((entity) => entity.name)
  }))
  const imageNames = work.images.map((image) => image.name)

  const records: ContextRecord[] = []
  const notes: string[] = []
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
    for (const [index, chunk] of work.chunks.entries()) {
      // 2026-10-08: a piece whose answer is cut off or unreadable is split in half and each half
      // asked again, at most `CONTEXT_SPLIT_DEPTH` times, before the sort gives up naming the file.
      const queue: { piece: ContextChunk; depth: number; id: string }[] = [
        { piece: chunk, depth: 0, id: `${input.requestId}:c${index}` }
      ]
      while (queue.length > 0) {
        const next = queue.shift()
        if (next === undefined) break
        const { piece, depth, id: chunkId } = next
        stopIfCancelled(input.signal)
        const prompt = buildContextImportPromptV2({
          ...piece,
          categories: categories.project,
          sheets,
          images: imageNames
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
            nodeId: null,
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
        let parsed: ModelAnswer | null = null
        if (answer.finishReason !== 'length') {
          try {
            parsed = parseAnswer(answer.text)
          } catch (err) {
            if (!(err instanceof AiFallbackError)) throw err
          }
        }
        if (parsed === null) {
          const halves = depth < CONTEXT_SPLIT_DEPTH ? halvePiece(piece) : null
          if (halves === null) {
            throw new AiFallbackError(
              `The model's answer for "${piece.fileName}" was cut off or unreadable, even in smaller pieces. Try again, or switch Thinking off for the strong model in Settings › AI.`
            )
          }
          queue.unshift(
            { piece: halves[0], depth: depth + 1, id: `${chunkId}a` },
            { piece: halves[1], depth: depth + 1, id: `${chunkId}b` }
          )
          continue
        }
        categories.learn(parsed)
        records.push(...toRecords(parsed, piece, records.length, categories))
        notes.push(...(parsed.notes ?? []).map((note) => note.trim()).filter((n) => n !== ''))
        for (const image of parsed.images ?? []) {
          if (imageNames.includes(image.file))
            hints.push({ fileName: image.file, name: image.name })
        }
      }
      input.onProgress?.({ done: index + 1, total: work.chunks.length, costUsd })
      if (index < work.chunks.length - 1) {
        await delay(JOB_MIN_INTERVAL_MS)
        stopIfCancelled(input.signal)
      }
    }
  } catch (err) {
    // Nothing the pass found reaches the review, so its chunks are settled here (F-14.5); the
    // ledger rows stay: the money was spent.
    for (const id of proposalIds) settleProposal(db, id, 'rejected')
    throw err
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }

  const plan = planContextReview({
    records,
    existing,
    categories: categories.forReview(),
    images: work.images,
    hints,
    notes
  })
  return {
    fileIds: [...input.fileIds],
    entities: plan.entities,
    categories: plan.categories,
    notes: plan.notes,
    proposalIds,
    chunks: work.chunks.length,
    usage,
    costUsd,
    model,
    promptVersion: CONTEXT_IMPORT_PROMPT_V2_VERSION
  }
}

function stopIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiCancelledError('Sorting the files was stopped.')
}

/** Never hold the process open between two chunks. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  })
}
