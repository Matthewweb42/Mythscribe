import type { AiMessage } from '../providers/types'
import { buildWhatNextPromptV3, type BuildWhatNextPromptV3Input } from './whatNext.v3'

/**
 * The What should come next? prompt (F-5.17), version 4 (F-16.14, story memory v2 only): version 3
 * with the Story notes block (`renderStoryNotes` within `STORY_BIBLE_TOKEN_BUDGET`) in the story
 * bible's slot of the system turn, before the story map, and no separate scene steer (the tone,
 * content and theme labels are lines of the block). The rules, the story-time rule, the
 * instruction and the user turn are version 3's byte for byte (this builds through it); they say
 * "story bible", which the model reads as the block. A v1 project keeps sending version 3. Prompt
 * files are versioned (F-5.12): `whatNext.v3.ts` stays exactly as it shipped.
 */
export const WHAT_NEXT_PROMPT_V4_VERSION = 'whatNext.v4'

export interface BuildWhatNextPromptV4Input extends Omit<
  BuildWhatNextPromptV3Input,
  'bible' | 'steer'
> {
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null. */
  storyNotes: string | null
}

export interface BuiltWhatNextPromptV4 {
  version: typeof WHAT_NEXT_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildWhatNextPromptV4(input: BuildWhatNextPromptV4Input): BuiltWhatNextPromptV4 {
  const { storyNotes, ...rest } = input
  const v3 = buildWhatNextPromptV3({ ...rest, bible: storyNotes, steer: null })
  return { version: WHAT_NEXT_PROMPT_V4_VERSION, messages: v3.messages, maxTokens: v3.maxTokens }
}
