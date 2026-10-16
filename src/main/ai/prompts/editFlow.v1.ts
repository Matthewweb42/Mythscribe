import {
  EDIT_FLOW_MAX_ISSUES,
  EDIT_FLOW_MAX_TOKENS,
  EDIT_FLOW_QUOTE_MAX,
  type EditFlowCategory,
  type EditFlowFamily
} from '@shared/editFlow'
import type { AiMessage } from '../providers/types'

/**
 * The edit flow's prompt (notes redesign phase 2), version 1: the stages and the focused checks.
 * One file serves every family but Update notes (`editNotes.v1`), as `editPass.v1` serves every
 * pass type: the system turn is the same for every request of a run, whatever the family (the
 * rules, every note page, the book map), so the provider caches it across the run's slices and
 * families; the user turn carries the family's task and one slice of the text. A change to any of
 * it is a new file. The opening sentence is the e2e fake's sentinel.
 */
export const EDIT_FLOW_PROMPT_VERSION = 'editFlow.v1'

export const EDIT_FLOW_SENTINEL =
  'You are the editor inside the author’s novel app, working through her book in the edit flow.'

export const EDIT_FLOW_RULES = [
  EDIT_FLOW_SENTINEL,
  'You see her note pages, a map of the book (each scene’s synopsis and notes) and, in each message, the part of the book to work on. The book and the notes are hers.',
  'Judge the text against her notes, the outline (the map) and the book so far; never invent a fact. Every issue points to its passage by quoting it.',
  'Scenes are n1, n2… and pages p1, p2…. Reply with exactly one JSON object and nothing else, as each message asks.'
].join('\n')

/**
 * The prefix every request of a run shares: the rules, the notes, the book map, and on a Deep run
 * of a scene or a chapter the rest of the book for reference (null otherwise).
 */
export function editFlowSystem(notes: string, map: string, reference: string | null): string {
  const parts = [EDIT_FLOW_RULES, `# Notes\n${notes}`, `# Book map\n${map}`]
  if (reference !== null) {
    parts.push(`# The rest of the book, for reference (edit only the text each message gives)\n${reference}`)
  }
  return parts.join('\n\n')
}

/** Each focused check's line in the checks family's task. */
export const EDIT_FLOW_CHECK_LINES: Record<
  Extract<EditFlowCategory, 'continuity' | 'plotHoles' | 'voice' | 'lineSpelling'>,
  string
> = {
  continuity:
    'continuity: facts that contradict her notes or an earlier scene (names, ages, looks, places, objects, timeline); say which page or scene it contradicts.',
  plotHoles:
    'plotHoles: events that do not follow from what came before, motives that do not add up, a setup the map never pays off.',
  voice:
    'voice: a line a character would not say or think, against their note page and their earlier scenes; say why.',
  lineSpelling: 'lineSpelling: a light line edit, and every spelling mistake and typo.'
}

const QUOTE_RULE =
  `"quote" is words copied exactly from that scene, inside one paragraph: the shortest stretch that shows the problem, at most ${EDIT_FLOW_QUOTE_MAX} characters, found once in the scene. ` +
  `"problem" says what is wrong in a sentence or two. At most ${EDIT_FLOW_MAX_ISSUES} issues, in book order; none is fine.`

const FIX_RULE =
  '"fix" is the quoted passage as it should read ("" cuts it), in her voice; never change plot, facts, point of view or tense beyond the problem.'

function shape(options: {
  check: boolean
  overview: boolean
  fix: 'text' | 'textOrNull' | 'null'
}): string {
  const fix = options.fix === 'null' ? 'null' : options.fix === 'text' ? '"..."' : '"..." or null'
  const check = options.check ? '"check":"...",' : ''
  const overview = options.overview ? '"overview":"...",' : ''
  return `Reply {${overview}"issues":[{"scene":"n3",${check}"quote":"...","problem":"...","fix":${fix}}]}.`
}

export interface EditFlowTaskInput {
  family: Exclude<EditFlowFamily, 'notes'>
  /** The focused checks asked for (the checks family). */
  checks: readonly EditFlowCategory[]
  /** The ref and title of her "Style guide" page, or null (copyediting). */
  styleGuide: { ref: string; title: string } | null
}

/** The family's task paragraph and its reply shape. */
export function editFlowTask(input: EditFlowTaskInput): string {
  switch (input.family) {
    case 'developmental':
      return [
        'Developmental editing: a big-picture review of this text: plot structure, character arcs, pacing, point of view, world-building, thematic consistency, against her notes and the outline.',
        '"overview" is a short overview for her: what works first, then the biggest structural problems, at most 250 words. "issues" are those problems, each resting on a passage. You never rewrite: "fix" is always null.',
        QUOTE_RULE,
        shape({ check: false, overview: true, fix: 'null' })
      ].join('\n')
    case 'line':
      return [
        'Line editing: sentence by sentence and paragraph by paragraph: flow, rhythm, voice, word choice, syntax, showing vs telling, cutting repetitive or awkward phrasing. Leave what works alone.',
        QUOTE_RULE,
        FIX_RULE,
        shape({ check: false, overview: false, fix: 'text' })
      ].join('\n')
    case 'copy':
      return [
        'Copyediting: grammar, spelling, punctuation, capitalisation, and consistency (names, eye colour, timeline logic). Do not restyle a sentence that is correct.',
        input.styleGuide === null
          ? 'She has no style guide page: follow standard conventions, consistent with the book’s own usage.'
          : `Follow her style guide, ${input.styleGuide.ref} “${input.styleGuide.title}”, and the book’s own usage where it is silent.`,
        QUOTE_RULE,
        FIX_RULE,
        shape({ check: false, overview: false, fix: 'text' })
      ].join('\n')
    case 'proof':
      return [
        'Proofreading, the last pass: residual typos, missing or doubled words, wrong spacing, stray characters, and scene-break markers or chapter and scene titles that are inconsistent (the titles are in the map and the headings below). Never change style or word choice; fragments and dialect are deliberate.',
        QUOTE_RULE,
        FIX_RULE,
        shape({ check: false, overview: false, fix: 'text' })
      ].join('\n')
    case 'checks': {
      const asked = input.checks.filter(
        (check): check is keyof typeof EDIT_FLOW_CHECK_LINES => check in EDIT_FLOW_CHECK_LINES
      )
      return [
        'Focused checks. Look only for:',
        ...asked.map((check) => `- ${EDIT_FLOW_CHECK_LINES[check]}`),
        `"check" is one of ${asked.join(', ')}.`,
        QUOTE_RULE,
        `${FIX_RULE} Give a fix only where one passage obviously mends it${asked.includes('lineSpelling') ? ' (always for lineSpelling)' : ''}, else null.`,
        shape({ check: true, overview: false, fix: 'textOrNull' })
      ].join('\n')
    }
  }
}

/** One scene (or a piece of one) in a slice, as the user turn shows it. */
export interface EditFlowSliceItem {
  ref: string
  title: string
  text: string
  part: { index: number; count: number }
}

/** The slice's text: each scene under its ref and `Chapter › Scene` title. */
export function editFlowSliceText(items: readonly EditFlowSliceItem[]): string {
  return items
    .map((item) => {
      const part =
        item.part.count > 1 ? ` (part ${item.part.index + 1} of ${item.part.count})` : ''
      return `### ${item.ref} ${item.title}${part}\n${item.text}`
    })
    .join('\n\n')
}

export interface BuildEditFlowPromptInput extends EditFlowTaskInput {
  notes: string
  map: string
  /** Deep on a scene or a chapter: the rest of the book's scenes; null otherwise. */
  reference: string | null
  /** Which slice of the run this is, and its label ("Chapter 3"). */
  slice: { index: number; count: number; label: string }
  items: readonly EditFlowSliceItem[]
}

export interface BuiltEditFlowPrompt {
  version: typeof EDIT_FLOW_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildEditFlowPrompt(input: BuildEditFlowPromptInput): BuiltEditFlowPrompt {
  const part =
    input.slice.count > 1 ? ` (part ${input.slice.index + 1} of ${input.slice.count})` : ''
  const user = [
    `# Task\n${editFlowTask(input)}`,
    `# Text: ${input.slice.label}${part}\n${editFlowSliceText(input.items)}`
  ].join('\n\n')
  return {
    version: EDIT_FLOW_PROMPT_VERSION,
    messages: [
      { role: 'system', content: editFlowSystem(input.notes, input.map, input.reference) },
      { role: 'user', content: user }
    ],
    maxTokens: EDIT_FLOW_MAX_TOKENS
  }
}
