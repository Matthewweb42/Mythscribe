import { z } from 'zod'
import { AiErrorCode, AiUsage, priceFor } from './ai'
import { docToText } from './docText'
import { IMPORT_TITLE_MAX, type ImportDraft } from './import'
import { countWords } from './wordCount'

/**
 * AI structure detection for import (F-12.3): the shape of the pass the author can ask for over
 * a structure draft (F-12.2) before Import. One owner for the chunking, the cost estimate the
 * dialog shows before anything is sent, the suggestion schema the model answers with, and the
 * channel's result, so main (the runner), the renderer (estimate, merge, badges), and the
 * prompt agree. Paragraph indices are global over the flattened draft in reading order, excluded
 * nodes skipped, and the merge applies them from the highest down so each stays valid.
 */

/** Words per chunk sent to the model; ~3,400 tokens at `STRUCTURE_TOKENS_PER_WORD`, well inside `inputBudget('importStructure')`. */
export const IMPORT_CHUNK_WORDS = 2_500
/** The estimate's tokens-in per word of manuscript (the spec's figure for English prose). */
export const STRUCTURE_TOKENS_PER_WORD = 1.35
/** Tokens of rules, bank names, and paragraph numbering per chunk, added to the estimate. */
export const STRUCTURE_CHUNK_OVERHEAD_TOKENS = 250
/** Tokens the estimate charges for each chunk's answer (the real cap is `outputBudget('importStructure')`). */
export const STRUCTURE_OUT_TOKENS_PER_CHUNK = 200
/** A paragraph longer than head + tail is sent as its head, ` … `, and its tail: boundaries live at paragraph edges. */
export const STRUCTURE_PARAGRAPH_HEAD = 300
export const STRUCTURE_PARAGRAPH_TAIL = 150
/** Longest reason the model may give for a break; longer ones are cut, not refused. */
export const STRUCTURE_REASON_MAX = 120
/** Most tag candidates kept per scene. */
export const STRUCTURE_TAGS_MAX = 6
/** Longest scene title the model may suggest (shorter than the node cap: it is a label, not a heading). */
export const STRUCTURE_TITLE_MAX = 60

export interface StructureEstimate {
  chunks: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** False when the fast model is not in `MODEL_PRICING`; the dialog then shows tokens, not dollars. */
  priced: boolean
}

/** What the pass over `words` words of manuscript would cost on `model`, before anything is sent. */
export function estimateStructureCost(words: number, model: string): StructureEstimate {
  const chunks = words <= 0 ? 0 : Math.max(1, Math.ceil(words / IMPORT_CHUNK_WORDS))
  const tokensIn =
    Math.ceil(words * STRUCTURE_TOKENS_PER_WORD) + chunks * STRUCTURE_CHUNK_OVERHEAD_TOKENS
  const tokensOut = chunks * STRUCTURE_OUT_TOKENS_PER_CHUNK
  const price = priceFor(model, tokensIn, tokensOut)
  return { chunks, tokensIn, tokensOut, costUsd: price.costUsd, priced: price.priced }
}

/** One paragraph of the draft in reading order, with where it lives. */
export interface FlatParagraph {
  /** Global index, the one the model and the suggestions use. */
  index: number
  partId: string
  chapterId: string
  sceneId: string
  /** Position inside its scene's `paragraphs`. */
  local: number
  /** True on a scene's first paragraph. */
  sceneStart: boolean
  /** True on a chapter's first paragraph. */
  chapterStart: boolean
  sceneTitle: string
  chapterTitle: string
  text: string
  words: number
}

/** The draft's paragraphs in reading order; excluded parts, chapters, and scenes are skipped, as are empty scenes. */
export function flattenDraft(draft: ImportDraft): FlatParagraph[] {
  const flat: FlatParagraph[] = []
  for (const part of draft.parts) {
    if (part.excluded) continue
    for (const chapter of part.chapters) {
      if (chapter.excluded) continue
      let chapterStart = true
      for (const scene of chapter.scenes) {
        if (scene.excluded) continue
        scene.paragraphs.forEach((paragraph, local) => {
          const doc = { type: 'doc', content: [paragraph] }
          flat.push({
            index: flat.length,
            partId: part.id,
            chapterId: chapter.id,
            sceneId: scene.id,
            local,
            sceneStart: local === 0,
            chapterStart: chapterStart && local === 0,
            sceneTitle: scene.title,
            chapterTitle: chapter.title,
            text: docToText(doc).replace(/\s+/g, ' ').trim(),
            words: countWords(doc)
          })
        })
        if (scene.paragraphs.length > 0) chapterStart = false
      }
    }
  }
  return flat
}

/** A run of consecutive flat paragraphs sent in one request: `start` inclusive, `end` exclusive. */
export interface StructureChunk {
  start: number
  end: number
}

/**
 * Greedy chunks of at most `IMPORT_CHUNK_WORDS` words; a paragraph longer than that is a chunk
 * of its own, so every chunk has at least one paragraph and every paragraph is in exactly one.
 */
export function chunkParagraphs(flat: readonly FlatParagraph[]): StructureChunk[] {
  const chunks: StructureChunk[] = []
  let start = 0
  let words = 0
  flat.forEach((paragraph, index) => {
    if (index > start && words + paragraph.words > IMPORT_CHUNK_WORDS) {
      chunks.push({ start, end: index })
      start = index
      words = 0
    }
    words += paragraph.words
  })
  if (flat.length > start) chunks.push({ start, end: flat.length })
  return chunks
}

/** The paragraph text as the prompt sends it: whole when short, head + ` … ` + tail when long. */
export function shortenParagraph(text: string): string {
  if (text.length <= STRUCTURE_PARAGRAPH_HEAD + STRUCTURE_PARAGRAPH_TAIL) return text
  return `${text.slice(0, STRUCTURE_PARAGRAPH_HEAD)} … ${text.slice(-STRUCTURE_PARAGRAPH_TAIL)}`
}

export const STRUCTURE_BREAK_KINDS = ['chapter', 'scene'] as const
export const StructureBreakKind = z.enum(STRUCTURE_BREAK_KINDS)
export type StructureBreakKind = z.infer<typeof StructureBreakKind>

/** A boundary the model is confident of: a new `kind` starts before global paragraph `before`. */
export const StructureBreak = z.object({
  before: z.number().int().nonnegative(),
  kind: StructureBreakKind,
  reason: z.string().max(STRUCTURE_REASON_MAX)
})
export type StructureBreak = z.infer<typeof StructureBreak>

/** A scene as the model sees it after its breaks: the global index it starts at, a title or null, tag-bank names. */
export const StructureScene = z.object({
  start: z.number().int().nonnegative(),
  title: z.string().max(IMPORT_TITLE_MAX).nullable(),
  tags: z.array(z.string()).max(STRUCTURE_TAGS_MAX)
})
export type StructureScene = z.infer<typeof StructureScene>

/** Every chunk's suggestions merged, indices global, tags already filtered to the bank. */
export const StructureSuggestions = z.object({
  breaks: z.array(StructureBreak),
  scenes: z.array(StructureScene)
})
export type StructureSuggestions = z.infer<typeof StructureSuggestions>

/** The `import:detectProgress` event: chunks answered so far, the total, and the spend so far. */
export const ImportDetectProgress = z.object({
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative()
})
export type ImportDetectProgress = z.infer<typeof ImportDetectProgress>

/**
 * What `import:detectStructure` answers: the merged suggestions with what the pass cost, or an
 * expected AI failure as data (`aiFailure`), a CANCELLED one included. `proposalIds` are the
 * one proposal per chunk (F-14.5), for the renderer to settle at Import or Cancel.
 */
export const ImportDetectResult = z.discriminatedUnion('ok', [
  z.object({
    ok: z.literal(true),
    suggestions: StructureSuggestions,
    chunks: z.number().int().nonnegative(),
    usage: AiUsage,
    costUsd: z.number().nonnegative(),
    model: z.string(),
    promptVersion: z.string(),
    proposalIds: z.array(z.string())
  }),
  z.object({ ok: z.literal(false), code: AiErrorCode, message: z.string(), nextStep: z.string() })
])
export type ImportDetectResult = z.infer<typeof ImportDetectResult>

/** The pending tag proposal on an imported scene (F-12.3), as `proposal:pendingTags` answers it. */
export const PendingTagProposal = z.object({
  proposalId: z.string(),
  tags: z.array(z.string()),
  model: z.string()
})
export type PendingTagProposal = z.infer<typeof PendingTagProposal>
