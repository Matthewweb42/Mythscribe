import { z } from 'zod'
import type { ImportDraft } from '@shared/import'
import {
  chunkParagraphs,
  flattenDraft,
  StructureBreakKind,
  STRUCTURE_REASON_MAX,
  STRUCTURE_TAGS_MAX,
  STRUCTURE_TITLE_MAX,
  type FlatParagraph,
  type ImportDetectProgress,
  type StructureBreak,
  type StructureScene,
  type StructureSuggestions
} from '@shared/importStructure'
import { JOB_MIN_INTERVAL_MS } from '@shared/jobs'
import { toTagName } from '@shared/tags'
import { getAiSettings } from '../project/settingsStore'
import { listTags } from '../tag/tagStore'
import { assertFeatureAllowed } from './dial'
import { cancelInflight } from './inflight'
import {
  buildImportStructurePrompt,
  IMPORT_STRUCTURE_PROMPT_VERSION
} from './prompts/importStructure.v1'
import { createProposal, settleProposal } from './proposalStore'
import { AiCancelledError, AiFallbackError, type CompletionUsage } from './providers/types'
import { runAiRequest, sha256, type AiRequestDeps } from './request'
import type { AiDb } from './usageStore'

/**
 * The import structure pass (F-12.3): the AI half of manuscript import. The draft is flattened
 * into paragraphs in reading order, cut into chunks of about `IMPORT_CHUNK_WORDS` words, and
 * each chunk is sent once through the request path on the fast tier in JSON mode. The chunks
 * run serially with the index queue's spacing (`JOB_MIN_INTERVAL_MS`) rather than through the
 * persistent queue (F-5.13): `index_job` is keyed by `node_id` and survives a restart, and an
 * import draft has no nodes and must not persist — nothing is written to the project until the
 * author presses Import.
 *
 * Nothing here changes the draft. The suggestions are merged by the renderer, which shows every
 * added break and every replaced title with an AI badge the author can reject, and the tag
 * candidates become pending proposals on the created scenes at commit. Each chunk's raw answer
 * is one proposal (F-14.5) with `nodeId: null`, settled by the renderer at Import or Cancel —
 * and settled `rejected` here when the pass is stopped or fails partway, because the channel's
 * failure branch carries no ids for the renderer to close.
 */
export interface DetectImportStructureInput {
  draft: ImportDraft
  /** The renderer's id for `ai:cancel` (F-5.10); each chunk registers under `<requestId>:c<n>`. */
  requestId: string
  /** The parent request's signal: an abort stops the loop and the chunk in flight. */
  signal?: AbortSignal
  /** Called after each chunk is answered, for the dialog's "chunk 3 of 16 · $0.02 so far". */
  onProgress?: (progress: ImportDetectProgress) => void
}

export interface DetectImportStructureResult {
  suggestions: StructureSuggestions
  /** Chunks sent (and answered); 0 when the draft has nothing left to read. */
  chunks: number
  usage: CompletionUsage
  costUsd: number
  /** The model the fast tier resolved to; empty when no chunk was sent. */
  model: string
  promptVersion: string
  /** One proposal per chunk, in chunk order (F-14.5). */
  proposalIds: string[]
}

/**
 * The model's answer. Looser than `StructureSuggestions` on purpose: the shape must be exactly
 * what the prompt asked for (anything else is `AiFallbackError`), but an over-long reason or
 * title is cut here rather than thrown away — the boundary is still worth showing.
 */
const ModelAnswer = z.object({
  breaks: z.array(
    z.object({
      before: z.number().int(),
      kind: StructureBreakKind,
      reason: z.string().nullish()
    })
  ),
  scenes: z.array(
    z.object({
      start: z.number().int(),
      title: z.string().nullish(),
      tags: z.array(z.string()).nullish()
    })
  )
})

const BAD_FORMAT = 'The model did not answer in the expected format.'

export async function detectImportStructure(
  db: AiDb,
  deps: AiRequestDeps,
  input: DetectImportStructureInput
): Promise<DetectImportStructureResult> {
  assertFeatureAllowed(getAiSettings(db), 'importStructure')

  const flat = flattenDraft(input.draft)
  const chunks = chunkParagraphs(flat)
  const bank = listTags(db).map((tag) => tag.name)
  const bankByName = new Map(bank.map((name) => [toTagName(name), name]))
  const bankKey = [...bank].sort().join(',')

  const breaks: StructureBreak[] = []
  const scenes: StructureScene[] = []
  const proposalIds: string[] = []
  const usage: CompletionUsage = { inputTokens: 0, outputTokens: 0 }
  let costUsd = 0
  let model = ''

  // F-5.10: the parent id is the renderer's; a cancel aborts the chunk in flight through its own
  // registration, so a stop lands during a request and not only between two.
  let inFlight: string | null = null
  const onAbort = (): void => {
    if (inFlight !== null) cancelInflight(inFlight)
  }
  input.signal?.addEventListener('abort', onAbort, { once: true })

  try {
    for (const [index, chunk] of chunks.entries()) {
      stopIfCancelled(input.signal)
      const paragraphs = flat.slice(chunk.start, chunk.end)
      const prompt = buildImportStructurePrompt({ paragraphs, tagNames: bank })
      const chunkId = `${input.requestId}:c${index}`
      inFlight = chunkId
      const answer = await runAiRequest(deps, {
        feature: 'importStructure',
        tier: 'fast',
        messages: prompt.messages,
        maxTokens: prompt.maxTokens,
        json: true,
        contextHash: sha256(
          `${paragraphs.map((p) => `${p.index}:${p.text}`).join('\n')}|${bankKey}`
        ),
        promptVersion: prompt.version,
        requestId: chunkId
      })
      inFlight = null
      stopIfCancelled(input.signal)

      usage.inputTokens += answer.usage.inputTokens
      usage.outputTokens += answer.usage.outputTokens
      costUsd += answer.costUsd
      model = answer.model
      const parsed = parseAnswer(answer.text)
      breaks.push(...keepBreaks(parsed.breaks, flat, chunk))
      scenes.push(...keepScenes(parsed.scenes, chunk, bankByName))
      proposalIds.push(
        createProposal(db, {
          feature: 'importStructure',
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
      input.onProgress?.({ done: index + 1, total: chunks.length, costUsd })
      if (index < chunks.length - 1) {
        await delay(JOB_MIN_INTERVAL_MS)
        stopIfCancelled(input.signal)
      }
    }
  } catch (err) {
    // The pass did not finish, so nothing it found reaches the draft: the chunks already
    // answered are settled `rejected` here (F-14.5). The channel's failure branch carries no
    // `proposalIds`, so the renderer cannot close them, and a pending row nobody owns would
    // sit in the table until it is evicted. Their ledger rows stay: the money was spent.
    for (const id of proposalIds) settleProposal(db, id, 'rejected')
    throw err
  } finally {
    input.signal?.removeEventListener('abort', onAbort)
  }

  return {
    suggestions: { breaks, scenes },
    chunks: chunks.length,
    usage,
    costUsd,
    model,
    promptVersion: IMPORT_STRUCTURE_PROMPT_VERSION,
    proposalIds
  }
}

/** The author pressed Cancel: the pass stops where it is and answers CANCELLED like any request. */
function stopIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AiCancelledError('The structure check was stopped.')
}

/** Never hold the process open between two chunks: quitting mid-pass just drops the timer. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref()
  })
}

/** The model's JSON, or PROVIDER when the answer is not JSON or not the shape the prompt asked for. */
function parseAnswer(text: string): z.infer<typeof ModelAnswer> {
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

/**
 * The breaks worth showing: inside the chunk that was sent, never the manuscript's first
 * paragraph (the draft already starts there), and never a boundary the draft has — a scene
 * break at a scene start is nothing new, and so is a chapter break at a chapter start. A
 * chapter break where a scene already starts is kept: it promotes that scene to a chapter.
 */
function keepBreaks(
  answered: z.infer<typeof ModelAnswer>['breaks'],
  flat: readonly FlatParagraph[],
  chunk: { start: number; end: number }
): StructureBreak[] {
  const kept: StructureBreak[] = []
  const seen = new Set<number>()
  for (const item of answered) {
    const at = flat[item.before]
    if (!at || item.before === 0) continue
    if (item.before < chunk.start || item.before >= chunk.end) continue
    if (item.kind === 'scene' ? at.sceneStart : at.chapterStart) continue
    if (seen.has(item.before)) continue
    seen.add(item.before)
    kept.push({
      before: item.before,
      kind: item.kind,
      reason: (item.reason ?? '').trim().slice(0, STRUCTURE_REASON_MAX)
    })
  }
  return kept
}

/**
 * The titles and tags worth keeping: inside the chunk, the title trimmed to its cap (blank
 * becomes null, so the draft's own title stays), the tags mapped back to bank names through
 * `toTagName` with unknown names and repeats dropped and the cap applied. An entry with
 * neither a title nor a tag would change nothing, so it is dropped here.
 */
function keepScenes(
  answered: z.infer<typeof ModelAnswer>['scenes'],
  chunk: { start: number; end: number },
  bankByName: ReadonlyMap<string, string>
): StructureScene[] {
  const kept: StructureScene[] = []
  const seen = new Set<number>()
  for (const item of answered) {
    if (item.start < chunk.start || item.start >= chunk.end) continue
    if (seen.has(item.start)) continue
    seen.add(item.start)
    const trimmed = (item.title ?? '').trim().slice(0, STRUCTURE_TITLE_MAX).trim()
    const tags: string[] = []
    for (const name of item.tags ?? []) {
      const known = bankByName.get(toTagName(name))
      if (known === undefined || tags.includes(known)) continue
      tags.push(known)
      if (tags.length === STRUCTURE_TAGS_MAX) break
    }
    if (trimmed === '' && tags.length === 0) continue
    kept.push({ start: item.start, title: trimmed === '' ? null : trimmed, tags })
  }
  return kept
}
