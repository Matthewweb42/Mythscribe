import { outputBudget } from '@shared/ai'
import { renderPromptCard, type PromptCard } from '@shared/memory/cardText'
import type { AiMessage } from '../providers/types'
import { NOTES_SUGGEST_RULES } from './notesSuggest.v1'
import { NOTES_SUGGEST_TIME_RULE_V3 } from './notesSuggest.v3'

/**
 * The suggested-notes prompt (F-5.20), version 4 (F-16.20, story memory v2 only; decision P1-D7,
 * plan P2a §5.1): version 3 with the scene's v2 card (`renderPromptCard`: the reader's line, gist
 * and the place, time and POV that stand on the text) in the stored summary's place in the user
 * turn. The system turn (the rules, the v2 story-time rule and the Story notes block) is version
 * 3's byte for byte, so the provider's prefix cache carries over. Prompt files are versioned
 * (F-5.12): `notesSuggest.v3.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): rules and Story notes in the system turn; the brief,
 * the card, the current notes, the scene text, and the author's focus last in the user turn.
 */
export const NOTES_SUGGEST_PROMPT_V4_VERSION = 'notesSuggest.v4'

export interface BuildNotesSuggestPromptV4Input {
  /** The scene as plain text, head-truncated by the caller. */
  sceneText: string
  /** The scene's v2 card as the readers take it (`promptCard`), or null before its first reading. */
  card: PromptCard | null
  /** The scene brief block (`sceneBriefBlock`), or null when nobody has written one. */
  brief: string | null
  /** The scene's current notes as plain text, head-truncated; null when empty. */
  notes: string | null
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null. */
  storyNotes: string | null
  /** What the author asked to focus on, or null. */
  instruction: string | null
}

export interface BuiltNotesSuggestPromptV4 {
  version: typeof NOTES_SUGGEST_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildNotesSuggestPromptV4(
  input: BuildNotesSuggestPromptV4Input
): BuiltNotesSuggestPromptV4 {
  const rules = `${NOTES_SUGGEST_RULES} ${NOTES_SUGGEST_TIME_RULE_V3}`
  const system = input.storyNotes ? `${rules}\n\n${input.storyNotes}` : rules
  const user: string[] = []
  if (input.brief) user.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  if (input.card !== null) user.push(renderPromptCard(input.card))
  if (input.notes) user.push(`Current notes:\n"""\n${input.notes}\n"""`)
  user.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  user.push(
    input.instruction
      ? `List the key points, focusing on: ${input.instruction}`
      : 'List the key points.'
  )
  return {
    version: NOTES_SUGGEST_PROMPT_V4_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('notesSuggest')
  }
}
