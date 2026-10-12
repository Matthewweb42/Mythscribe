import type { AiMessage } from '../providers/types'
import { WHAT_NEXT_RULES } from './whatNext.v1'
import {
  buildWhatNextPromptV3,
  WHAT_NEXT_TIME_RULE,
  type BuildWhatNextPromptV3Input
} from './whatNext.v3'

/**
 * The What should come next? prompt (F-5.17), version 4 (F-16.14, story memory v2 only): version 3
 * with the Story notes block (`renderStoryNotes` within `STORY_BIBLE_TOKEN_BUDGET`) in the story
 * bible's slot of the system turn, before the story map, and no separate scene steer (the tone,
 * content and theme labels are lines of the block). The rules name the block ("the story notes",
 * where version 3 says "the story bible"), and the story-time rule (F-5.23) says what the block is
 * in v2: timeless facts, which never make a plot event happen, while later and planned scenes stay
 * plans. The instruction and the user turn are version 3's byte for byte (this builds through it).
 * A v1 project keeps sending version 3. Prompt files are versioned (F-5.12): `whatNext.v3.ts`
 * stays exactly as it shipped.
 */
export const WHAT_NEXT_PROMPT_V4_VERSION = 'whatNext.v4'

/** Version 1's rules with the block named as it is headed: "story notes". */
export const WHAT_NEXT_RULES_V4 = WHAT_NEXT_RULES.replace(
  'and the story bible, and suggest',
  'and the story notes, and suggest'
).replace('rules the bible states', 'rules the story notes state')

/** The story-time rule (F-5.23) for directions in v2. */
export const WHAT_NEXT_TIME_RULE_V4 =
  'Story time: this scene is the one marked "▶ NOW" in the story map; only what the scenes up ' +
  "to it show has happened. Later and planned scenes are the author's plans: a direction may " +
  'move toward them but never treats them as already happened. The story notes are timeless ' +
  'facts about people, places and things; they never make a plot event happen.'

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
  const messages = v3.messages.map((message) =>
    message.role === 'system'
      ? {
          ...message,
          content: message.content
            .replace(WHAT_NEXT_RULES, WHAT_NEXT_RULES_V4)
            .replace(WHAT_NEXT_TIME_RULE, WHAT_NEXT_TIME_RULE_V4)
        }
      : message
  )
  return { version: WHAT_NEXT_PROMPT_V4_VERSION, messages, maxTokens: v3.maxTokens }
}
