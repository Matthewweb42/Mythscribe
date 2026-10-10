import type { AiMessage } from '../providers/types'
import { buildRewritePromptV3, type BuildRewritePromptV3Input } from './rewrite.v3'

/**
 * The rewrite-in-my-voice prompt (F-14.10), version 4: version 3 plus the scene's mood and theme
 * (F-5.6, the author 2026-10-10): the block `renderSceneMood` makes from the scene's last reading
 * (`buildSceneMood`), in the user turn right after the scene steer and before the text each side
 * of the passage, so the rewrite stays in line with them. With no mood block this is version 3's
 * messages exactly; the rules, the stable system prefix, and the cap are version 3's. Prompt
 * files are versioned (F-5.12): `rewrite.v3.ts` stays exactly as it shipped.
 */
export const REWRITE_PROMPT_V4_VERSION = 'rewrite.v4'

export interface BuildRewritePromptV4Input extends BuildRewritePromptV3Input {
  /** The scene mood block (F-5.6, `buildSceneMood`), or null when the scene has no mood or theme yet. */
  mood: string | null
}

export interface BuiltRewritePromptV4 {
  version: typeof REWRITE_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/**
 * Version 3's input with the mood block after the steer: version 3 puts the steer first in the
 * user turn, so the two blocks go in together, the steer first.
 */
export function rewriteV3Input(input: BuildRewritePromptV4Input): BuildRewritePromptV3Input {
  const steer = [input.steer, input.mood].filter((block) => block !== null && block !== '')
  return {
    text: input.text,
    before: input.before,
    after: input.after,
    meta: input.meta,
    voice: input.voice,
    bible: input.bible,
    steer: steer.length === 0 ? null : steer.join('\n\n')
  }
}

export function buildRewritePromptV4(input: BuildRewritePromptV4Input): BuiltRewritePromptV4 {
  const v3 = buildRewritePromptV3(rewriteV3Input(input))
  return { version: REWRITE_PROMPT_V4_VERSION, messages: v3.messages, maxTokens: v3.maxTokens }
}
