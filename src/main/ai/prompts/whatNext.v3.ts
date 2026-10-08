import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'
import { WHAT_NEXT_INSTRUCTION, WHAT_NEXT_RULES } from './whatNext.v1'
import type { BuildWhatNextPromptV2Input } from './whatNext.v2'

/**
 * The What should come next? prompt (F-5.17), version 3 (F-5.23 story time, 2026-10-08): the
 * system turn adds the story-time rule and the story map (`renderStoryMap` within
 * `STORY_MAP_SMALL_TOKEN_BUDGET`: where the scene sits, what is written, what is only planned),
 * and the story bible opens with `STORY_BIBLE_PLANS_HEADING` (the author's notes and plans)
 * instead of the ground-truth line. The rules, the instruction, and the user turn are version
 * 2's. Prompt files are versioned (F-5.12); `whatNext.v2.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules and the time rule (stable), the bible,
 * then the map; the user turn carries the brief, the steer, and the tail of the text.
 */
export const WHAT_NEXT_PROMPT_V3_VERSION = 'whatNext.v3'

/** The story-time rule (F-5.23) for directions. */
export const WHAT_NEXT_TIME_RULE =
  'Story time: this scene is the one marked "▶ NOW" in the story map; only what the scenes up ' +
  "to it show has happened. Later and planned scenes, and the story bible, are the author's " +
  'notes and plans: a direction may move toward them but never treats them as already happened.'

export interface BuildWhatNextPromptV3Input extends BuildWhatNextPromptV2Input {
  /** The story map block, or null with no manuscript document. */
  map: string | null
}

export interface BuiltWhatNextPromptV3 {
  version: typeof WHAT_NEXT_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildWhatNextPromptV3(input: BuildWhatNextPromptV3Input): BuiltWhatNextPromptV3 {
  const system = [WHAT_NEXT_RULES, WHAT_NEXT_TIME_RULE]
  if (input.bible) system.push(input.bible)
  if (input.map) system.push(input.map)

  const user: string[] = []
  if (input.brief) user.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  if (input.steer) user.push(input.steer)
  user.push(`Text so far:\n"""\n${input.text}\n"""`)
  user.push(WHAT_NEXT_INSTRUCTION)

  return {
    version: WHAT_NEXT_PROMPT_V3_VERSION,
    messages: [
      { role: 'system', content: system.join('\n\n') },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('whatNext')
  }
}
