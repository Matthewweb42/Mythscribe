import { z } from 'zod'
import type { RouteEditPass } from './assistantRoute'
import {
  EDIT_PASS_EXCERPT_MAX,
  EDIT_PASS_INSTRUCTION_MAX,
  EDIT_PASS_SCENES_MAX,
  presetInstruction,
  type EditPassType
} from './editPass'

/**
 * "Make this scene better" in the chat (F-5.26, requested by the author 2026-10-11): a request to
 * improve, polish, tighten, or fix a passage, a scene, or a chapter runs an edit pass (F-14.15),
 * whose changes come back as tracked changes in the editor. A vague request first asks which kind
 * of edit with quick-pick choices; a specific one runs its pass at once. This module owns the
 * choices, their labels, what each runs, and the shape a chat turn stores.
 */

/**
 * What the chat can run for an edit request: the edit pass types, `dialogue` (a custom pass with
 * the built-in dialogue instruction), and `critique` (Editor's notes, F-14.8, not a pass).
 */
export const EDIT_CHOICES = [
  'line',
  'developmental',
  'dialogue',
  'proofread',
  'critique',
  'copy',
  'continuity',
  'custom'
] as const
export const EditChoice = z.enum(EDIT_CHOICES)
export type EditChoice = z.infer<typeof EditChoice>

/** The quick picks a vague request is asked with, in the order the chat shows them. */
export const EDIT_ASK_CHOICES: readonly EditChoice[] = [
  'line',
  'developmental',
  'dialogue',
  'proofread',
  'critique'
]

export const EDIT_CHOICE_LABEL: Record<EditChoice, string> = {
  line: 'Tighten prose',
  developmental: 'Pacing & structure',
  dialogue: 'Dialogue',
  proofread: 'Proofread',
  critique: "Editor's notes",
  copy: 'Copy edit',
  continuity: 'Continuity pass',
  custom: 'Custom pass'
}

/** The question a vague request is answered with. */
export const EDIT_ASK_QUESTION = 'What should I focus on?'

/** The choice a router decision's pass names; null for `ask`. */
export function choiceForPass(pass: RouteEditPass): EditChoice | null {
  return pass === 'ask' ? null : pass
}

/**
 * The edit pass a choice runs, with its instruction: `dialogue` is a custom pass with the
 * built-in dialogue instruction (the author's own words after it, when the request had some);
 * `custom` carries the author's instruction (null without one: it cannot run); `critique` is not
 * a pass (null).
 */
export function choicePass(
  choice: EditChoice,
  instruction: string | null
): { type: EditPassType; instruction: string | null } | null {
  switch (choice) {
    case 'critique':
      return null
    case 'dialogue': {
      const base = presetInstruction('dialogue', 0, 0)
      const text = instruction === null ? base : `${base} ${instruction}`
      return { type: 'custom', instruction: text.slice(0, EDIT_PASS_INSTRUCTION_MAX) }
    }
    case 'custom':
      return instruction === null
        ? null
        : { type: 'custom', instruction: instruction.slice(0, EDIT_PASS_INSTRUCTION_MAX) }
    default:
      return { type: choice, instruction: null }
  }
}

/** What an edit request covers: the selected passage, the open scene, or a chapter. */
export const EDIT_TARGET_KINDS = ['selection', 'scene', 'chapter'] as const
export const EditTargetKind = z.enum(EDIT_TARGET_KINDS)
export type EditTargetKind = z.infer<typeof EditTargetKind>

export const EDIT_TARGET_TITLE_MAX = 200

export const EditTarget = z.object({
  kind: EditTargetKind,
  /** The scenes in reading order (one for a selection or a scene). */
  nodeIds: z.array(z.string()).min(1).max(EDIT_PASS_SCENES_MAX),
  /** The scene's or the chapter's title, as the turn names it. */
  title: z.string().max(EDIT_TARGET_TITLE_MAX),
  /** The selected passage, for a selection; null otherwise. */
  excerpt: z.string().max(EDIT_PASS_EXCERPT_MAX).nullable()
})
export type EditTarget = z.infer<typeof EditTarget>

/**
 * An edit request on a chat turn: what it covers, the choices offered (every quick pick for a
 * vague request; the one that matched for a specific one waiting for the hosted confirm), the
 * author's own instruction, and what was picked and the pass it started, once it has.
 */
export const EditTurn = z.object({
  target: EditTarget,
  choices: z.array(EditChoice).min(1).max(EDIT_CHOICES.length),
  instruction: z.string().max(EDIT_PASS_INSTRUCTION_MAX).nullable(),
  picked: EditChoice.nullable(),
  /** The edit pass the pick started; null for Editor's notes and before a pick. */
  passId: z.string().nullable()
})
export type EditTurn = z.infer<typeof EditTurn>

/** How the turn names what the pass covers. */
export function targetPhrase(target: EditTarget): string {
  switch (target.kind) {
    case 'selection':
      return `the selection in “${target.title}”`
    case 'scene':
      return `“${target.title}”`
    case 'chapter':
      return `the ${target.nodeIds.length === 1 ? 'scene' : `${target.nodeIds.length} scenes`} of “${target.title}”`
  }
}

/**
 * The chapter an author named ("chapter 3", "Chapter Three", "The Crossing") among the
 * manuscript's chapters in reading order: a title match first (any case, surrounding space
 * ignored, with or without a leading "chapter"), then a number as the chapter's place in the
 * book. Null when none matches.
 */
export function findChapter(
  name: string,
  chapters: readonly { id: string; title: string }[]
): string | null {
  const wanted = normalizeTitle(name)
  if (wanted === '') return null
  const bare = wanted.replace(/^chapter\s+/u, '')
  const byTitle = chapters.find((chapter) => {
    const title = normalizeTitle(chapter.title)
    return title === wanted || title === bare || title.replace(/^chapter\s+/u, '') === bare
  })
  if (byTitle !== undefined) return byTitle.id
  const number = /^\d+$/u.test(bare) ? Number(bare) : NUMBER_WORDS.indexOf(bare) + 1 || NaN
  return Number.isInteger(number) && number >= 1 ? (chapters[number - 1]?.id ?? null) : null
}

const NUMBER_WORDS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty'
]

function normalizeTitle(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[.:!?]+$/u, '')
    .replace(/\s+/gu, ' ')
}
