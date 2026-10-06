import { outputBudget } from '@shared/ai'
import { NOTES_SUGGEST_POINT_MAX, NOTES_SUGGEST_POINTS_MAX } from '@shared/sceneSuggest'
import type { AiMessage } from '../providers/types'

/**
 * The notes suggestion prompt (F-5.20), version 1: the key points an author should keep in mind
 * while writing or revising one scene (continuity facts from the story bible, open threads,
 * what the brief promises), answered as JSON `{ "points": ["..."] }`. The author adds them to
 * the scene's notes with one click or ignores them; nothing is written without that accept.
 * Prompt files are versioned (F-5.12): a change to the text, the caps, or the message order is a
 * new file with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules
 * and the story bible (F-14.9); the user turn carries what changes: the brief (F-14.3), the
 * stored summary (F-5.6), the current notes, the scene text, and the author's focus last.
 */
export const NOTES_SUGGEST_PROMPT_VERSION = 'notesSuggest.v1'

/** The rules; the opening sentence is the one a fake provider in tests keys on. */
export const NOTES_SUGGEST_RULES =
  'You are the scene-notes feature inside a novel-writing app. Read the scene and its context ' +
  'below and list the key points the author should keep in mind in this scene: facts it must ' +
  'stay consistent with, threads it opens or must pay off, and what its brief promises. ' +
  `At most ${NOTES_SUGGEST_POINTS_MAX} points, each one plain sentence of at most ` +
  `${NOTES_SUGGEST_POINT_MAX} characters, most important first. Rely only on the scene and the ` +
  'context given; do not repeat what the current notes already say, do not summarise the ' +
  'scene, and do not write prose for it. Reply with JSON only: {"points":["..."]}.'

export interface BuildNotesSuggestPromptInput {
  /** The scene as plain text, head-truncated by the caller. */
  sceneText: string
  /** The stored summary (F-5.6) and its key points, or null when the scene has none yet. */
  summary: { summary: string; keyPoints: string[] } | null
  /** The scene brief block (`sceneBriefBlock`), or null when nobody has written one. */
  brief: string | null
  /** The scene's current notes as plain text, head-truncated; null when empty. */
  notes: string | null
  /** The story bible block (`buildStoryBible` within `STORY_BIBLE_TOKEN_BUDGET`), or null. */
  bible: string | null
  /** What the author asked to focus on, or null. */
  instruction: string | null
}

export interface BuiltNotesSuggestPrompt {
  version: typeof NOTES_SUGGEST_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildNotesSuggestPrompt(
  input: BuildNotesSuggestPromptInput
): BuiltNotesSuggestPrompt {
  const system = input.bible ? `${NOTES_SUGGEST_RULES}\n\n${input.bible}` : NOTES_SUGGEST_RULES
  const user: string[] = []
  if (input.brief) user.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  if (input.summary) {
    const points = input.summary.keyPoints.map((point) => `- ${point}`).join('\n')
    user.push(`Stored summary:\n${input.summary.summary}${points ? `\n${points}` : ''}`)
  }
  if (input.notes) user.push(`Current notes:\n"""\n${input.notes}\n"""`)
  user.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  user.push(
    input.instruction
      ? `List the key points, focusing on: ${input.instruction}`
      : 'List the key points.'
  )
  return {
    version: NOTES_SUGGEST_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('notesSuggest')
  }
}
