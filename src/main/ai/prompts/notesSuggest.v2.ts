import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'
import {
  NOTES_SUGGEST_RULES,
  buildNotesSuggestPrompt,
  type BuildNotesSuggestPromptInput
} from './notesSuggest.v1'

/**
 * The suggested-notes prompt (F-5.20), version 2 (F-5.23 story time, 2026-10-08): the rules gain
 * the story-time rule, and the story bible opens with `STORY_BIBLE_PLANS_HEADING` (the author's
 * notes and plans) instead of the ground-truth line, so a point never states as fact an event
 * the bible only plans. The user turn is version 1's. Prompt files are versioned (F-5.12);
 * `notesSuggest.v1.ts` stays exactly as it shipped.
 */
export const NOTES_SUGGEST_PROMPT_V2_VERSION = 'notesSuggest.v2'

/** The story-time rule (F-5.23) for notes. */
export const NOTES_SUGGEST_TIME_RULE =
  "Story time: the story bible is the author's notes and plans; an event told only there, or in " +
  'the next scene, has not happened by this scene, so never note it as something that has.'

export interface BuiltNotesSuggestPromptV2 {
  version: typeof NOTES_SUGGEST_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `bible` is expected under `STORY_BIBLE_PLANS_HEADING`; the caller renders it so. */
export function buildNotesSuggestPromptV2(
  input: BuildNotesSuggestPromptInput
): BuiltNotesSuggestPromptV2 {
  const rules = `${NOTES_SUGGEST_RULES} ${NOTES_SUGGEST_TIME_RULE}`
  const system = input.bible ? `${rules}\n\n${input.bible}` : rules
  // The user turn is version 1's exactly.
  const user = buildNotesSuggestPrompt(input).messages[1]?.content ?? ''
  return {
    version: NOTES_SUGGEST_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    maxTokens: outputBudget('notesSuggest')
  }
}
