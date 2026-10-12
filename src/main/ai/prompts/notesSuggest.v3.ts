import type { AiMessage } from '../providers/types'
import type { BuildNotesSuggestPromptInput } from './notesSuggest.v1'
import { buildNotesSuggestPromptV2, NOTES_SUGGEST_TIME_RULE } from './notesSuggest.v2'

/**
 * The suggested-notes prompt (F-5.20), version 3 (F-16.14, story memory v2 only; decision P1-D7):
 * version 2 with the Story notes block (`renderStoryNotes` within `STORY_BIBLE_TOKEN_BUDGET`) in
 * the story bible's slot of the system turn, and the story-time rule (F-5.23) naming the block as
 * what it is in v2: timeless facts, which never make a plot event happen. The rules and the user
 * turn are version 2's byte for byte (this builds through it). A v1 project keeps sending version
 * 2. P2a's re-point to the scene card is `notesSuggest.v4`. Prompt files are versioned (F-5.12):
 * `notesSuggest.v2.ts` stays exactly as it shipped.
 */
export const NOTES_SUGGEST_PROMPT_V3_VERSION = 'notesSuggest.v3'

/** The story-time rule (F-5.23) for notes in v2. */
export const NOTES_SUGGEST_TIME_RULE_V3 =
  'Story time: the story notes are timeless facts and never make a plot event happen; an event ' +
  'told only there, or in the next scene, has not happened by this scene, so never note it as ' +
  'something that has.'

export interface BuildNotesSuggestPromptV3Input extends Omit<
  BuildNotesSuggestPromptInput,
  'bible'
> {
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null. */
  storyNotes: string | null
}

export interface BuiltNotesSuggestPromptV3 {
  version: typeof NOTES_SUGGEST_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildNotesSuggestPromptV3(
  input: BuildNotesSuggestPromptV3Input
): BuiltNotesSuggestPromptV3 {
  const { storyNotes, ...rest } = input
  const v2 = buildNotesSuggestPromptV2({ ...rest, bible: storyNotes })
  return {
    version: NOTES_SUGGEST_PROMPT_V3_VERSION,
    messages: v2.messages.map((message) =>
      message.role === 'system'
        ? {
            ...message,
            content: message.content.replace(NOTES_SUGGEST_TIME_RULE, NOTES_SUGGEST_TIME_RULE_V3)
          }
        : message
    ),
    maxTokens: v2.maxTokens
  }
}
