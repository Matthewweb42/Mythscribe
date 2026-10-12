import type { AiMessage } from '../providers/types'
import { buildGhostTextPromptV4, type BuildGhostTextPromptV4Input } from './ghostText.v4'

/**
 * The ghost-text continuation prompt (F-5.3), version 5 (F-16.14, story memory v2 only): version
 * 4 with the Story notes block (`renderStoryNotes` within `STORY_BIBLE_GHOST_TOKEN_BUDGET`) in the
 * story bible's slot, last in the stable system prefix, and no separate scene steer: the scene's
 * tone, content and theme labels are lines of the block. The rules, the voice block, the preset,
 * the user turn and the caps are version 4's byte for byte (this builds through it), so with no
 * notes this is version 4's messages with no bible and no steer. A v1 project keeps sending
 * version 4. Prompt files are versioned (F-5.12): `ghostText.v4.ts` stays exactly as it shipped.
 */
export const GHOST_PROMPT_V5_VERSION = 'ghostText.v5'

export interface BuildGhostTextPromptV5Input extends Omit<
  BuildGhostTextPromptV4Input,
  'bible' | 'steer'
> {
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null; last in the prefix. */
  storyNotes: string | null
}

export interface BuiltGhostTextPromptV5 {
  version: typeof GHOST_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

/** Version 4's input for the same request: the notes in the bible's slot, no steer. */
export function ghostTextV4Input(input: BuildGhostTextPromptV5Input): BuildGhostTextPromptV4Input {
  const { storyNotes, ...rest } = input
  return { ...rest, bible: storyNotes, steer: null }
}

export function buildGhostTextPromptV5(input: BuildGhostTextPromptV5Input): BuiltGhostTextPromptV5 {
  const v4 = buildGhostTextPromptV4(ghostTextV4Input(input))
  return { ...v4, version: GHOST_PROMPT_V5_VERSION }
}
