import type { AiMessage } from '../providers/types'
import { buildChatPromptV5, type BuildChatPromptV5Input } from './chat.v5'

/**
 * The assistant prompt (F-5.4: Plan mode and Author-mode drafting), version 6 (F-16.14, story
 * memory v2 only): version 5 with the Story notes block (`renderStoryNotes` within
 * `STORY_BIBLE_TOKEN_BUDGET`) in the story bible's slot, in both modes, and no separate scene
 * steer in Author mode (the tone, content and theme labels are lines of the block). The rules,
 * the voice block, the preset, the side panel, the history and the caps are version 5's byte for
 * byte (this builds through it). A v1 project keeps sending version 5. Prompt files are versioned
 * (F-5.12): `chat.v5.ts` stays exactly as it shipped.
 */
export const CHAT_PROMPT_V6_VERSION = 'chat.v6'

export interface BuildChatPromptV6Input extends Omit<BuildChatPromptV5Input, 'bible' | 'steer'> {
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null. */
  storyNotes: string | null
}

export interface BuiltChatPromptV6 {
  version: typeof CHAT_PROMPT_V6_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

/** Version 5's input for the same request: the notes in the bible's slot, no steer. */
export function chatV5Input(input: BuildChatPromptV6Input): BuildChatPromptV5Input {
  const { storyNotes, ...rest } = input
  return { ...rest, bible: storyNotes, steer: null }
}

export function buildChatPromptV6(input: BuildChatPromptV6Input): BuiltChatPromptV6 {
  const v5 = buildChatPromptV5(chatV5Input(input))
  return { ...v5, version: CHAT_PROMPT_V6_VERSION }
}
