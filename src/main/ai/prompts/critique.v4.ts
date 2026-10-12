import type { AiMessage } from '../providers/types'
import { buildCritiquePromptV3, type BuildCritiquePromptV3Input } from './critique.v3'

/**
 * The editor's-notes prompt (F-14.8), version 4 (F-16.14, story memory v2 only): version 3 with
 * the Story notes block (`renderStoryNotes` within `STORY_BIBLE_TOKEN_BUDGET`) in the story
 * bible's slot of the system turn, between the voice profile and the scene's metadata line. The
 * rules, the honesty line, the user turn and the cap are version 3's byte for byte (this builds
 * through it), so the e2e's sentinel holds. A v1 project keeps sending version 3. Prompt files are
 * versioned (F-5.12): `critique.v3.ts` stays exactly as it shipped.
 */
export const CRITIQUE_PROMPT_V4_VERSION = 'critique.v4'

export interface BuildCritiquePromptV4Input extends Omit<BuildCritiquePromptV3Input, 'bible'> {
  /** The Story notes block (F-16.14, `buildStoryNotes`), or null. */
  storyNotes: string | null
}

export interface BuiltCritiquePromptV4 {
  version: typeof CRITIQUE_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** Version 3's input for the same request: the notes in the bible's slot. */
export function critiqueV3Input(input: BuildCritiquePromptV4Input): BuildCritiquePromptV3Input {
  const { storyNotes, ...rest } = input
  return { ...rest, bible: storyNotes }
}

export function buildCritiquePromptV4(input: BuildCritiquePromptV4Input): BuiltCritiquePromptV4 {
  const v3 = buildCritiquePromptV3(critiqueV3Input(input))
  return { version: CRITIQUE_PROMPT_V4_VERSION, messages: v3.messages, maxTokens: v3.maxTokens }
}
