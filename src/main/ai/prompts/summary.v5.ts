import { outputBudget } from '@shared/ai'
import { SCENE_MOOD_MAX } from '@shared/sceneCard'
import { SUMMARY_RELATIONS_MAX } from '@shared/summary'
import type { AiMessage } from '../providers/types'
import {
  buildSummaryPromptV4,
  SUMMARY_RULES_V4,
  type BuildSummaryPromptV4Input
} from './summary.v4'

/**
 * The scene-summary prompt, version 5 (F-5.6, the author 2026-10-10): version 4's reading plus the
 * scene's mood and theme, two short phrases deduced from the scene as a whole, so the prompts
 * that propose prose edits for the scene keep to them (`renderSceneMood`). They are a reading,
 * not tags: the tag rule (names and coined terms) is unchanged. One clause after the card's and
 * two keys after `card` in the reply shape; nothing else moved, so the output cap is version
 * 4's. A stored `summary.v4` row stays current (`SUMMARY_CURRENT_MIN_VERSION` in
 * `summarize.ts`): a scene gets its mood and theme when it is next read, never by a bulk re-read.
 *
 * Order (token rule 3): version 4's, byte for byte apart from the rules: the system turn is the
 * rules, the names, the bank line, the thread line, and the scene line; the user turn is the scene.
 */
export const SUMMARY_PROMPT_V5_VERSION = 'summary.v5'

const V4_RELATIONS = ` Then up to ${SUMMARY_RELATIONS_MAX} relationships`
const V4_CARD_SHAPE = '"changed":"..."},'

/** The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI keys on it. */
export const SUMMARY_RULES_V5 = SUMMARY_RULES_V4.replace(
  V4_RELATIONS,
  ' Then deduce the mood (its emotional atmosphere) and the theme (the idea it explores) of the ' +
    `scene as a whole, each a short phrase of at most ${SCENE_MOOD_MAX} characters; they are ` +
    `your reading, not tags.${V4_RELATIONS}`
).replace(V4_CARD_SHAPE, `${V4_CARD_SHAPE}"mood":"...","theme":"...",`)

export type BuildSummaryPromptV5Input = BuildSummaryPromptV4Input

export interface BuiltSummaryPromptV5 {
  version: typeof SUMMARY_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildSummaryPromptV5(input: BuildSummaryPromptV5Input): BuiltSummaryPromptV5 {
  const v4 = buildSummaryPromptV4(input)
  const [system, user] = v4.messages
  if (system === undefined || user === undefined) {
    throw new Error('summary.v4 no longer builds a system and a user turn')
  }
  return {
    version: SUMMARY_PROMPT_V5_VERSION,
    messages: [
      {
        role: 'system',
        content: `${SUMMARY_RULES_V5}${system.content.slice(SUMMARY_RULES_V4.length)}`
      },
      user
    ],
    maxTokens: outputBudget('summary')
  }
}
