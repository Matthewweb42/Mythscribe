import { z } from 'zod'
import { AgentEdit } from './agent'
import type { Tier } from './ai'
import { EditChange, EditPassStatus } from './editPass'

/**
 * The edit flow (notes redesign phase 2, `docs/research/notes-redesign-2026-10-15/phase2.md`):
 * the edit passes (F-14.15) grown into one flow the author runs at a chosen time from the right
 * column. She picks stages and focused checks (and Update notes), a scope (this scene, this
 * chapter, the whole book) and a depth (Quick or Deep), sees the price, and runs it; the results
 * come back as one issue list grouped by category, with tracked changes where an issue is
 * fixable and note edits applied with Undo. A run is an `edit_pass` row with its `flow` set and
 * its issues `edit_change` rows (so a fix is drawn in the editor like any edit-pass change).
 * This module owns the vocabulary, the caps and the shapes main and the renderer share.
 */

/** The four stages, in the order an editor works (the author's definitions, 2026-10-15). */
export const EDIT_FLOW_STAGES = ['developmental', 'line', 'copy', 'proofread'] as const
/** The focused checks. */
export const EDIT_FLOW_CHECKS = ['continuity', 'plotHoles', 'voice', 'lineSpelling'] as const
export const EDIT_FLOW_CATEGORIES = [
  ...EDIT_FLOW_STAGES,
  ...EDIT_FLOW_CHECKS,
  'updateNotes'
] as const
export const EditFlowCategory = z.enum(EDIT_FLOW_CATEGORIES)
export type EditFlowCategory = z.infer<typeof EditFlowCategory>

export const EDIT_FLOW_LABEL: Record<EditFlowCategory, string> = {
  developmental: 'Developmental editing',
  line: 'Line editing',
  copy: 'Copyediting',
  proofread: 'Proofreading',
  continuity: 'Continuity',
  plotHoles: 'Plot holes & logic',
  voice: 'Character voice',
  lineSpelling: 'Line edit & spelling',
  updateNotes: 'Update notes'
}

/** The help line under each choice: the stages in the author's own words (2026-10-15). */
export const EDIT_FLOW_HELP: Record<EditFlowCategory, string> = {
  developmental:
    'A big-picture review of the entire story: plot structure, character arcs, pacing, point of view, world-building, thematic consistency. First stage, after a rough draft; often leads to major rewrites. Gives an overview and issues, no rewrites.',
  line: 'Sentence-by-sentence and paragraph-by-paragraph craft and style: flow, rhythm, voice, word choice, syntax, showing vs telling, cutting repetitive or awkward phrasing. After the developmental issues are fixed.',
  copy: 'Technical and mechanical: grammar, spelling, punctuation, capitalisation, consistency (eye colour, timeline logic), adherence to a style guide. Near the end. Follows your note page called “Style guide” if you have one, else standard conventions consistent with the book’s own usage.',
  proofread:
    'Final quality control: residual typos, missing words, weird spacing, layout or formatting errors in the final typeset file. Last. Checks the manuscript text and the scene and chapter titles; it does not read an exported PDF or ePub file.',
  continuity: 'Facts that contradict your notes or earlier scenes: names, ages, places, objects, timeline.',
  plotHoles: 'Events that do not follow, motives that do not add up, setups with no payoff.',
  voice: 'Lines a character would not say or think, against their note page and earlier scenes.',
  lineSpelling: 'A quick line edit with the spelling and typos fixed in the same pass.',
  updateNotes:
    'New characters, places, events and timeline from the text go into your notes, applied at once, each with Undo.'
}

/**
 * The prompt family a category is asked in: each stage on its own, the focused checks together
 * in one request (they read the same text against the same notes), and Update notes apart.
 */
export const EDIT_FLOW_FAMILIES = [
  'developmental',
  'line',
  'copy',
  'proof',
  'checks',
  'notes'
] as const
export type EditFlowFamily = (typeof EDIT_FLOW_FAMILIES)[number]

export const EDIT_FLOW_FAMILY: Record<EditFlowCategory, EditFlowFamily> = {
  developmental: 'developmental',
  line: 'line',
  copy: 'copy',
  proofread: 'proof',
  continuity: 'checks',
  plotHoles: 'checks',
  voice: 'checks',
  lineSpelling: 'checks',
  updateNotes: 'notes'
}

/**
 * The flow category a chat edit request names (F-5.26's router passes, "edit this chapter for
 * continuity"): asked of Ms Scribe in a story memory v1 project, it opens the flow pre-filled.
 * Null for the requests the flow has no category for (a dialogue or custom pass, Editor's notes),
 * which keep their edit pass.
 */
export function flowCategoryForPass(pass: string): EditFlowCategory | null {
  switch (pass) {
    case 'developmental':
    case 'line':
    case 'copy':
    case 'proofread':
    case 'continuity':
      return pass
    default:
      return null
  }
}

/** The categories whose issues may carry a tracked change (Developmental never rewrites). */
export function flowCategoryFixes(category: EditFlowCategory): boolean {
  return category !== 'developmental' && category !== 'updateNotes'
}

export const EDIT_FLOW_DEPTHS = ['quick', 'deep'] as const
export const EditFlowDepth = z.enum(EDIT_FLOW_DEPTHS)
export type EditFlowDepth = z.infer<typeof EditFlowDepth>

export const EDIT_FLOW_DEPTH_LABEL: Record<EditFlowDepth, string> = { quick: 'Quick', deep: 'Deep' }
export const EDIT_FLOW_DEPTH_HELP: Record<EditFlowDepth, string> = {
  quick: 'The fast model with your notes, a chapter at a time. Cents.',
  deep: 'The strong model with your notes and the whole book in view.'
}

/** Quick runs on the fast tier (DeepSeek Flash), Deep on the strong one (DeepSeek Pro). */
export const EDIT_FLOW_TIER: Record<EditFlowDepth, Tier> = { quick: 'fast', deep: 'strong' }

export const EDIT_FLOW_SCOPES = ['scene', 'chapter', 'book'] as const
export const EditFlowScopeKind = z.enum(EDIT_FLOW_SCOPES)
export type EditFlowScopeKind = z.infer<typeof EditFlowScopeKind>

export const EDIT_FLOW_SCOPE_LABEL: Record<EditFlowScopeKind, string> = {
  scene: 'This scene',
  chapter: 'This chapter',
  book: 'The whole book'
}

/** What a run covers: a scene, a chapter (a folder), or the whole manuscript (`nodeId` null). */
export const EditFlowScope = z.object({
  kind: EditFlowScopeKind,
  nodeId: z.string().nullable()
})
export type EditFlowScope = z.infer<typeof EditFlowScope>

/** One run as the author set it up. */
export const EditFlowSpec = z.object({
  categories: z
    .array(EditFlowCategory)
    .min(1)
    .max(EDIT_FLOW_CATEGORIES.length)
    .refine((list) => new Set(list).size === list.length, 'A category is listed twice'),
  depth: EditFlowDepth,
  scope: EditFlowScope
})
export type EditFlowSpec = z.infer<typeof EditFlowSpec>

/**
 * The key the kept results are per: the latest run of each scope stays (phase 2 plan). An
 * automatic notes update (phase 3) is kept under its own key, so it never replaces the run the
 * author started herself on the same scope.
 */
export function scopeKey(scope: EditFlowScope, automatic = false): string {
  const key = scope.kind === 'book' ? 'book' : `${scope.kind}:${scope.nodeId ?? ''}`
  return automatic ? `auto:${key}` : key
}

/** The categories in the order the panel shows them (stages, checks, Update notes). */
export function orderedCategories(list: readonly EditFlowCategory[]): EditFlowCategory[] {
  return EDIT_FLOW_CATEGORIES.filter((category) => list.includes(category))
}

/**
 * The scene text one Quick request reads: about a chapter. A longer chapter is split at scene
 * breaks, and a scene longer than this into pieces at paragraph breaks.
 */
export const EDIT_FLOW_QUICK_SLICE_TOKENS = 16_000
/** The scene text one Deep request reads: the author's whole book (about 30k words) in one. */
export const EDIT_FLOW_DEEP_SLICE_TOKENS = 60_000
/** Issues kept per request. */
export const EDIT_FLOW_MAX_ISSUES = 40
/** The developmental overview, per slice. */
export const EDIT_FLOW_OVERVIEW_MAX = 2_400
/** What an issue says. */
export const EDIT_FLOW_PROBLEM_MAX = 400
/** Note writes one Update notes request may make. */
export const EDIT_FLOW_NOTE_WRITES_MAX = 8
/** The quoted passage of an issue (inside one paragraph; `scribe2/quotes.ts` checks it). */
export const EDIT_FLOW_QUOTE_MAX = 400
/** The `max_tokens` one request asks for (an overview plus up to 40 issues with fixes). */
export const EDIT_FLOW_MAX_TOKENS = 8_000

/** Output tokens per input text token, per family, for the price only. */
export const EDIT_FLOW_OUTPUT_RATIO: Record<EditFlowFamily, number> = {
  developmental: 0.08,
  line: 0.35,
  copy: 0.15,
  proof: 0.08,
  checks: 0.1,
  notes: 0.08
}

/** One request as the plan and its price count it. */
export interface EditFlowRequestCount {
  family: EditFlowFamily
  tokensIn: number
  tokensOut: number
}

/** What a run would send before it starts (`editFlow:plan`); the renderer prices it. */
export const EditFlowPlanResult = z.object({
  /** The scope as the panel names it ("Chapter 3", "Scene 1", "the whole book"). */
  scopeTitle: z.string(),
  scenes: z.number().int().nonnegative(),
  words: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative()
})
export type EditFlowPlanResult = z.infer<typeof EditFlowPlanResult>

/** A note page Update notes edited or made, kept with the run; `undone` once its Undo ran. */
export const EditFlowNoteEdit = z.object({
  edit: AgentEdit,
  undone: z.boolean()
})
export type EditFlowNoteEdit = z.infer<typeof EditFlowNoteEdit>
export const EditFlowNoteEdits = z.array(EditFlowNoteEdit)

/** One run as the panel lists it. */
export const EditFlowRun = z.object({
  id: z.string(),
  spec: EditFlowSpec,
  scopeTitle: z.string(),
  /** Started by leaving a chapter after writing in it (phase 3), not by the author's Run. */
  automatic: z.boolean(),
  status: EditPassStatus,
  /** Requests answered so far, of all the run sends. */
  done: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  model: z.string(),
  tokensIn: z.number().int().nonnegative(),
  tokensOut: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
  /** Issues by status (the tracked changes and the issues without one). */
  counts: z.object({
    pending: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
    rejected: z.number().int().nonnegative(),
    stale: z.number().int().nonnegative()
  }),
  /** Issues main dropped (a quote not in the text, an overlap, an empty fix). */
  dropped: z.number().int().nonnegative(),
  error: z.string().nullable(),
  /** Developmental editing's overview, null when it was not asked for or not given. */
  overview: z.string().nullable(),
  noteEdits: EditFlowNoteEdits,
  createdAt: z.string(),
  finishedAt: z.string().nullable()
})
export type EditFlowRun = z.infer<typeof EditFlowRun>

/**
 * One issue: an edit-pass change (`kind: 'change'`, a tracked change in the editor) or an issue
 * with no fix (`kind: 'note'`), with the category it was found under and whether its passage is
 * still in the scene (`textChanged` when the author's edits since moved it).
 */
export const EditFlowIssue = EditChange.extend({
  flowCategory: EditFlowCategory,
  textChanged: z.boolean()
})
export type EditFlowIssue = z.infer<typeof EditFlowIssue>

/** A run with its issues in book order and its scenes' titles (`Chapter › Scene`). */
export const EditFlowDetail = z.object({
  run: EditFlowRun,
  issues: z.array(EditFlowIssue),
  titles: z.record(z.string(), z.string())
})
export type EditFlowDetail = z.infer<typeof EditFlowDetail>

/** The note pages a run's Update notes edited or made, each counted once. */
export function notesUpdatedPages(run: Pick<EditFlowRun, 'noteEdits'>): number {
  return new Set(
    run.noteEdits.flatMap((entry) => (entry.edit.kind === 'notebook' ? [entry.edit.pageId] : []))
  ).size
}

/*
 * Notes redesign phase 3 (`docs/research/notes-redesign-2026-10-15/phase3.md`): notes updates.
 * The step ("Update notes from this scene / chapter / the whole book") and the chat open the
 * flow pre-filled; the automatic update runs Update notes Quick on a chapter the author leaves
 * after writing in it, when she turned it on (off by default), at most `dailyCap` runs a day.
 */

/** The settings key of the automatic update's switch and cap (per project: the book decides). */
export const NOTES_AUTO_KEY = 'notesAutoUpdate'
/** The settings key of today's count and each chapter's text hash at its last automatic update. */
export const NOTES_AUTO_STATE_KEY = 'notesAutoUpdate.state'
export const NOTES_AUTO_CAP_MIN = 1
export const NOTES_AUTO_CAP_MAX = 50
export const NOTES_AUTO_CAP_DEFAULT = 10

export const NotesAutoSettings = z.object({
  on: z.boolean(),
  /** Automatic runs started a day, reset at local midnight. */
  dailyCap: z.number().int().min(NOTES_AUTO_CAP_MIN).max(NOTES_AUTO_CAP_MAX)
})
export type NotesAutoSettings = z.infer<typeof NotesAutoSettings>

export function defaultNotesAutoSettings(): NotesAutoSettings {
  return { on: false, dailyCap: NOTES_AUTO_CAP_DEFAULT }
}

/** What main keeps for the automatic update: the day's count and each chapter's last hash. */
export const NotesAutoState = z.object({
  /** The local day (`YYYY-MM-DD`) `count` is for. */
  day: z.string(),
  count: z.number().int().nonnegative(),
  /** Chapter id → the hash of its text when its last automatic update started. */
  hashes: z.record(z.string(), z.string())
})
export type NotesAutoState = z.infer<typeof NotesAutoState>

export function defaultNotesAutoState(): NotesAutoState {
  return { day: '', count: 0, hashes: {} }
}

/** Why leaving a chapter started no automatic update (main logs it; the author sees nothing). */
export const NOTES_AUTO_SKIPS = [
  'off',
  'aiOff',
  'busy',
  'notChapter',
  'unchanged',
  'cap',
  'noText'
] as const
export const NotesAutoSkip = z.enum(NOTES_AUTO_SKIPS)
export type NotesAutoSkip = z.infer<typeof NotesAutoSkip>

/** What `editFlow:chapterLeft` answers: the run it started, or why none. */
export const EditFlowChapterLeftResult = z.discriminatedUnion('started', [
  z.object({ started: z.literal(true), runId: z.string() }),
  z.object({ started: z.literal(false), reason: NotesAutoSkip })
])
export type EditFlowChapterLeftResult = z.infer<typeof EditFlowChapterLeftResult>

/** The spec of an automatic update of chapter `chapterId`: Update notes, Quick. */
export function autoNotesSpec(chapterId: string): EditFlowSpec {
  return {
    categories: ['updateNotes'],
    depth: 'quick',
    scope: { kind: 'chapter', nodeId: chapterId }
  }
}

/** The depth the step and the chat pre-fill for a scope: Deep for the whole book, else Quick. */
export function notesUpdateDepth(scope: EditFlowScopeKind): EditFlowDepth {
  return scope === 'book' ? 'deep' : 'quick'
}

/**
 * A chat request to update the notes from a scope (phase 3; asked in Brainstorm it opens the flow
 * pre-filled): the scope it names, `here` when it names none ("update my notes"), or null when the
 * message is anything else. Matched whole, so "update my notes on Mara with …" stays a chat turn.
 */
export function notesUpdateAsk(message: string): EditFlowScopeKind | 'here' | null {
  const match =
    /^(?:(?:please|ok(?:ay)?|now),?\s+)?(?:(?:can|could|would) you\s+|let'?s\s+|go ahead and\s+)?(?:please\s+)?(?:update|refresh)\s+(?:all\s+)?(?:of\s+)?(?:my|the|our)?\s*notes(?:\s+(?:from|with|for|using|based on|to match)\s+(?:this|the|my|our)?\s*(?:whole\s+|entire\s+|current\s+)?(scene|chapter|book|manuscript|novel))?(?:,?\s+please)?\s*[.!?]*$/iu.exec(
      message.trim()
    )
  if (match === null) return null
  const scope = match[1]?.toLowerCase()
  if (scope === undefined) return 'here'
  if (scope === 'scene' || scope === 'chapter') return scope
  return 'book'
}
