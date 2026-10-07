import { z } from 'zod'
import { priceFor, type Tier } from './ai'

/**
 * Edit passes (F-14.15): developmental, line, copy, proofread, continuity, and custom passes, run over the
 * scenes the author picks, as one background job per pass. Every change comes back as a tracked
 * change the author accepts or rejects (AI rule 1); a developmental pass only writes notes. This
 * module is the one owner of the vocabulary, the caps, the estimate, and the shapes the contract, main, and the workspace share.
 */

export const EDIT_PASS_TYPES = [
  'developmental',
  'line',
  'copy',
  'proofread',
  'continuity',
  'custom'
] as const
export const EditPassType = z.enum(EDIT_PASS_TYPES)
export type EditPassType = z.infer<typeof EditPassType>

export const EDIT_PASS_LABEL: Record<EditPassType, string> = {
  developmental: 'Developmental edit',
  line: 'Line edit',
  copy: 'Copy edit',
  proofread: 'Proofread',
  continuity: 'Continuity pass',
  custom: 'Custom pass'
}

/** One line under each pass type in the workspace: what an editor does in it. */
export const EDIT_PASS_DESCRIPTION: Record<EditPassType, string> = {
  developmental:
    'Structure, pacing, character arcs, stakes, point of view, openings and endings. Notes that cite passages; no text changes.',
  line: 'Sentence by sentence: clarity, rhythm, flow, word choice, and tightening, in your voice.',
  copy: 'Grammar, tense, consistency of names and spelling, repetition, and word choice, against a style sheet from your story bible.',
  proofread: 'The last pass: typos, spelling, punctuation, doubled and missing words.',
  continuity:
    'Facts that contradict your story bible or earlier scenes: names, ages, places, objects, timeline.',
  custom: 'Your own instruction: trim, a dialogue pass, tighten, show don’t tell, or anything else.'
}

/**
 * The tier each pass asks for (CLAUDE.md, token rule 1; decided by Claude, unconfirmed): the
 * passes that judge or rewrite prose use `strong`, the mechanical ones `fast`.
 */
export const EDIT_PASS_TIER: Record<EditPassType, Tier> = {
  developmental: 'strong',
  line: 'strong',
  copy: 'fast',
  proofread: 'fast',
  continuity: 'fast',
  custom: 'strong'
}

/** Whether a pass writes tracked changes; a developmental pass writes only report notes. */
export function passChangesText(type: EditPassType): boolean {
  return type !== 'developmental'
}

/** The characters of one scene sent in one request; a longer scene is split at paragraph breaks. */
export const EDIT_PASS_CHUNK_CHARS = 12_000
/** A scene needs this many characters of text to be sent; shorter scenes are skipped. */
export const EDIT_PASS_TEXT_MIN = 20
/** The author's instruction for a custom pass (and a saved preset's). */
export const EDIT_PASS_INSTRUCTION_MAX = 1_000
/** Changes (or notes) kept per request, in document order. */
export const EDIT_PASS_MAX_ITEMS = 40
/** The quoted passage of a change: inside one paragraph, a sentence or two. */
export const EDIT_PASS_QUOTE_MAX = 600
/** The replacement text; empty means "cut the passage". */
export const EDIT_PASS_REPLACEMENT_MAX = 1_200
/** Why the editor made the change, or the developmental note. */
export const EDIT_PASS_RATIONALE_MAX = 300
export const EDIT_PASS_NOTE_MAX = 600
/** Scenes one pass may cover (a long novel has a few hundred). */
export const EDIT_PASS_SCENES_MAX = 2_000
/** Passes kept per project; the oldest finished ones go first. */
export const EDIT_PASS_RETENTION_MAX = 50
/** Saved custom presets per project. */
export const EDIT_PASS_PRESETS_MAX = 20
export const EDIT_PASS_PRESET_NAME_MAX = 60

/** The categories of a developmental note. */
export const DEVELOPMENTAL_CATEGORIES = [
  'structure',
  'pacing',
  'character',
  'stakes',
  'pov',
  'opening',
  'ending',
  'other'
] as const
export const DevelopmentalCategory = z.enum(DEVELOPMENTAL_CATEGORIES)
export type DevelopmentalCategory = z.infer<typeof DevelopmentalCategory>
export const DEVELOPMENTAL_CATEGORY_LABEL: Record<DevelopmentalCategory, string> = {
  structure: 'Structure',
  pacing: 'Pacing',
  character: 'Character',
  stakes: 'Stakes',
  pov: 'Point of view',
  opening: 'Opening',
  ending: 'Ending',
  other: 'Other'
}

/**
 * The built-in custom presets: each fills the instruction box; the trim presets take a number.
 * `{n}` is replaced by the author's number when the preset is applied.
 */
export const BUILTIN_PRESET_IDS = [
  'trimPercent',
  'trimWords',
  'dialogue',
  'tighten',
  'show'
] as const
export type BuiltinPresetId = (typeof BUILTIN_PRESET_IDS)[number]
export interface BuiltinPreset {
  label: string
  /** The number the author is asked for, or null for a preset with none. */
  number: { label: string; min: number; max: number; default: number } | null
}
export const BUILTIN_PRESETS: Record<BuiltinPresetId, BuiltinPreset> = {
  trimPercent: {
    label: 'Trim by N%',
    number: { label: 'Percent to cut', min: 1, max: 60, default: 10 }
  },
  trimWords: {
    label: 'Trim to N words',
    number: { label: 'Target words', min: 1, max: 1_000_000, default: 1_000 }
  },
  dialogue: { label: 'Dialogue pass', number: null },
  tighten: { label: 'Tighten', number: null },
  show: { label: 'Show, don’t tell', number: null }
}

/**
 * The instruction a built-in preset writes into the box. `words` is the selection's word count,
 * so "trim to N words" becomes the share to cut; a target at or above it asks for no cut.
 */
export function presetInstruction(id: BuiltinPresetId, n: number, words: number): string {
  switch (id) {
    case 'trimPercent':
      return `Trim the text by about ${Math.round(n)}%: cut redundancy, filler, and over-explanation, keep every plot beat and the author's voice.`
    case 'trimWords': {
      const share = words > 0 ? Math.max(0, Math.round((1 - n / words) * 100)) : 0
      return share === 0
        ? `Keep the text at about ${Math.round(n)} words: cut only clear redundancy.`
        : `Trim the text by about ${share}% (to about ${Math.round(n)} words overall): cut redundancy, filler, and over-explanation, keep every plot beat and the author's voice.`
    }
    case 'dialogue':
      return 'Dialogue pass: make each speaker sound distinct, cut on-the-nose lines and empty pleasantries, simplify attribution (said over fancy tags), and keep the subtext.'
    case 'tighten':
      return 'Tighten: cut filler words, redundant phrases, and stacked modifiers; prefer strong verbs; keep meaning, rhythm, and voice.'
    case 'show':
      return "Show, don't tell: where a sentence names an emotion or trait outright, render it through action, sensation, or dialogue instead, briefly and in the author's voice."
  }
}

/** A custom preset the author saved (settings key `editPassPresets`). */
export const EditPassPreset = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1).max(EDIT_PASS_PRESET_NAME_MAX),
  instruction: z.string().trim().min(1).max(EDIT_PASS_INSTRUCTION_MAX)
})
export type EditPassPreset = z.infer<typeof EditPassPreset>
export const EditPassPresets = z.array(EditPassPreset).max(EDIT_PASS_PRESETS_MAX)
export type EditPassPresets = z.infer<typeof EditPassPresets>
export const EDIT_PASS_PRESETS_KEY = 'editPassPresets'

/** Tokens per word of English prose (as the import estimate counts them). */
export const EDIT_PASS_TOKENS_PER_WORD = 1.35
/** Characters per word, to count the chunks a scene of N words splits into. */
export const EDIT_PASS_CHARS_PER_WORD = 5.7
/** The rules, voice block, keep list or references, and framing sent with every chunk. */
export const EDIT_PASS_CHUNK_OVERHEAD_TOKENS = 1_200
/** Output tokens per input text token, per pass type, for the estimate only. */
export const EDIT_PASS_OUTPUT_RATIO: Record<EditPassType, number> = {
  developmental: 0.15,
  line: 0.5,
  copy: 0.25,
  proofread: 0.12,
  continuity: 0.08,
  custom: 0.5
}

export interface EditPassEstimate {
  scenes: number
  words: number
  chunks: number
  tokensIn: number
  tokensOut: number
  costUsd: number
  priced: boolean
}

/** The chunks a scene of `words` words is sent in (0 for an empty scene). */
export function chunksForWords(words: number): number {
  if (words <= 0) return 0
  return Math.max(1, Math.ceil((words * EDIT_PASS_CHARS_PER_WORD) / EDIT_PASS_CHUNK_CHARS))
}

/**
 * What a pass over scenes of `sceneWords` words would cost on `model`: the sum of its chunk
 * estimates (AI-BILLING-SPEC R3). Each chunk's output is capped at `outputCap`, as the request
 * path caps it. No comparison with an editor's fee is made (AI-BILLING-SPEC C1).
 */
export function estimateEditPass(
  type: EditPassType,
  sceneWords: readonly number[],
  model: string,
  outputCap: number
): EditPassEstimate {
  let chunks = 0
  let words = 0
  let scenes = 0
  let tokensOut = 0
  for (const count of sceneWords) {
    const n = chunksForWords(count)
    if (n === 0) continue
    scenes += 1
    chunks += n
    words += count
    const perChunk = Math.ceil((count * EDIT_PASS_TOKENS_PER_WORD) / n)
    tokensOut += n * Math.min(outputCap, Math.ceil(perChunk * EDIT_PASS_OUTPUT_RATIO[type]))
  }
  const tokensIn =
    Math.ceil(words * EDIT_PASS_TOKENS_PER_WORD) + chunks * EDIT_PASS_CHUNK_OVERHEAD_TOKENS
  const price = priceFor(model, tokensIn, tokensOut)
  return {
    scenes,
    words,
    chunks,
    tokensIn,
    tokensOut,
    costUsd: price.costUsd,
    priced: price.priced
  }
}

/** A text cut into pieces of at most `max` characters at paragraph breaks (a blank line). */
export function chunkText(text: string, max: number = EDIT_PASS_CHUNK_CHARS): string[] {
  const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim() !== '')
  const chunks: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    // A single paragraph over the cap is cut at sentence ends, then hard, so nothing is lost.
    const pieces = paragraph.length <= max ? [paragraph] : splitLong(paragraph, max)
    for (const piece of pieces) {
      if (current === '') current = piece
      else if (current.length + 2 + piece.length <= max) current += `\n\n${piece}`
      else {
        chunks.push(current)
        current = piece
      }
    }
  }
  if (current !== '') chunks.push(current)
  return chunks
}

function splitLong(paragraph: string, max: number): string[] {
  const sentences = paragraph.match(/[^.!?…]+[.!?…]+["'”’)]*\s*|[^.!?…]+$/g) ?? [paragraph]
  const out: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current.length + sentence.length <= max) {
      current += sentence
      continue
    }
    if (current !== '') out.push(current.trim())
    current = sentence
    while (current.length > max) {
      out.push(current.slice(0, max))
      current = current.slice(max)
    }
  }
  if (current.trim() !== '') out.push(current.trim())
  return out
}

export const EDIT_PASS_STATUSES = ['running', 'done', 'cancelled', 'failed'] as const
export const EditPassStatus = z.enum(EDIT_PASS_STATUSES)
export type EditPassStatus = z.infer<typeof EditPassStatus>

/** A change's status: `stale` when its passage is no longer in the scene, so it can never land. */
export const EDIT_CHANGE_STATUSES = ['pending', 'accepted', 'rejected', 'stale'] as const
export const EditChangeStatus = z.enum(EDIT_CHANGE_STATUSES)
export type EditChangeStatus = z.infer<typeof EditChangeStatus>

/** A tracked change (`kind: 'change'`) or a developmental note (`kind: 'note'`). */
export const EDIT_CHANGE_KINDS = ['change', 'note'] as const
export const EditChangeKind = z.enum(EDIT_CHANGE_KINDS)
export type EditChangeKind = z.infer<typeof EditChangeKind>

/** One pass as the list, the progress line, and the report header read it. */
export const EditPassSummary = z.object({
  id: z.string(),
  type: EditPassType,
  /** The custom instruction; null for the built-in passes. */
  instruction: z.string().nullable(),
  status: EditPassStatus,
  /** The scenes in the pass, in reading order. */
  nodeIds: z.array(z.string()),
  /** The scenes finished so far (all of them once done). */
  doneNodeIds: z.array(z.string()),
  /** The scene being read right now, while running. */
  currentNodeId: z.string().nullable(),
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Changes or notes found, by status. */
  counts: z.object({
    pending: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative()
  }),
  /** Items main dropped (a quote not found once, an overlap, an empty edit); only counted. */
  dropped: z.number().int().nonnegative(),
  /** Why the pass stopped, for a failed one. */
  error: z.string().nullable(),
  createdAt: z.string(),
  finishedAt: z.string().nullable()
})
export type EditPassSummary = z.infer<typeof EditPassSummary>

/** One tracked change or note, as the editor and the report read it. */
export const EditChange = z.object({
  id: z.string(),
  passId: z.string(),
  nodeId: z.string(),
  kind: EditChangeKind,
  /** Reading order inside the scene. */
  position: z.number().int().nonnegative(),
  /** The passage as it was: what a change replaces and a note cites. */
  original: z.string(),
  /** The replacement ('' cuts the passage); null for a note. */
  replacement: z.string().nullable(),
  /** Why (a change) or the note itself (a developmental note). */
  rationale: z.string(),
  /** A developmental note's category; null for a change. */
  category: DevelopmentalCategory.nullable(),
  flagged: z.boolean(),
  violation: z.string().nullable(),
  status: EditChangeStatus,
  /** The proposal (F-14.5) the change belongs to: one per scene of the pass. */
  proposalId: z.string().nullable()
})
export type EditChange = z.infer<typeof EditChange>

/** The pass a report shows: the summary and every change or note with its scene's title. */
export const EditPassDetail = z.object({
  pass: EditPassSummary,
  changes: z.array(EditChange),
  titles: z.record(z.string(), z.string())
})
export type EditPassDetail = z.infer<typeof EditPassDetail>
