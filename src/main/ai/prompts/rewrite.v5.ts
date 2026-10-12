import type { AiMessage } from '../providers/types'
import { buildRewritePromptV4, type BuildRewritePromptV4Input } from './rewrite.v4'

/**
 * The rewrite-in-my-voice prompt (F-14.10), version 5 (F-16.14, story memory v2 only): version 4
 * with the Story notes block (`renderStoryNotes` within `STORY_BIBLE_TOKEN_BUDGET`) in the story
 * bible's slot and no separate scene steer (the tone, content and theme labels are lines of the
 * block). The scene's mood and theme (F-5.6) still ride where version 4 puts them. The rules, the
 * voice block, the user turn and the cap are version 4's byte for byte (this builds through it).
 * A v1 project keeps sending version 4. Prompt files are versioned (F-5.12): `rewrite.v4.ts`
 * stays exactly as it shipped.
 */
export const REWRITE_PROMPT_V5_VERSION = 'rewrite.v5'

export interface BuildRewritePromptV5Input extends Omit<
  BuildRewritePromptV4Input,
  'bible' | 'steer'
> {
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null. */
  storyNotes: string | null
}

export interface BuiltRewritePromptV5 {
  version: typeof REWRITE_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** Version 4's input for the same request: the notes in the bible's slot, no steer. */
export function rewriteV4Input(input: BuildRewritePromptV5Input): BuildRewritePromptV4Input {
  const { storyNotes, ...rest } = input
  return { ...rest, bible: storyNotes, steer: null }
}

export function buildRewritePromptV5(input: BuildRewritePromptV5Input): BuiltRewritePromptV5 {
  const v4 = buildRewritePromptV4(rewriteV4Input(input))
  return { version: REWRITE_PROMPT_V5_VERSION, messages: v4.messages, maxTokens: v4.maxTokens }
}
