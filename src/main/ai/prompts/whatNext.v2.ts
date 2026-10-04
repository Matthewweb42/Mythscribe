import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'
import { WHAT_NEXT_INSTRUCTION, WHAT_NEXT_RULES } from './whatNext.v1'

/**
 * The What should come next? prompt (F-5.17), version 2: version 1 plus the scene steer
 * (F-14.13): the scene's Tone, Content, Plot threads, and theme tags as a labelled block with
 * one instruction sentence (`renderSceneSteer`), in the user turn after the brief and before
 * the text so far, so the directions keep the scene's tone and threads. The rules and the
 * instruction are version 1's, imported unchanged — the rules' opening sentence is the
 * sentinel the e2e's fake OpenAI keys on. Nothing else moved: with no steer this is version
 * 1's messages exactly. Prompt files are versioned (F-5.12): a change to the text, the caps,
 * or the message order is a new file with its own golden test, never an edit to a shipped one;
 * `whatNext.v1.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules
 * and the story bible (F-14.9); the user turn carries what changes: the scene brief (F-14.3),
 * the scene steer, and the tail of the text.
 */
export const WHAT_NEXT_PROMPT_V2_VERSION = 'whatNext.v2'

export interface BuildWhatNextPromptV2Input {
  /** The tail of the scene, or of the text up to the selection's end, as sent. */
  text: string
  /** The scene brief block (`sceneBriefBlock`), or null when nobody has written one. */
  brief: string | null
  /**
   * The scene steer block (F-14.13, `buildSceneSteer`), or null when the scene has no tag in a
   * steer category.
   */
  steer: string | null
  /** The story bible block (`buildStoryBible` within `STORY_BIBLE_TOKEN_BUDGET`), or null when it is empty. */
  bible: string | null
}

export interface BuiltWhatNextPromptV2 {
  version: typeof WHAT_NEXT_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildWhatNextPromptV2(input: BuildWhatNextPromptV2Input): BuiltWhatNextPromptV2 {
  const system = input.bible ? `${WHAT_NEXT_RULES}\n\n${input.bible}` : WHAT_NEXT_RULES

  const user: string[] = []
  if (input.brief) user.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  if (input.steer) user.push(input.steer)
  user.push(`Text so far:\n"""\n${input.text}\n"""`)
  user.push(WHAT_NEXT_INSTRUCTION)

  return {
    version: WHAT_NEXT_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('whatNext')
  }
}
