import type { AiMessage } from '../providers/types'
import { rewriteV3Input, type BuildRewritePromptV4Input } from './rewrite.v4'
import { buildRewriteRegenPromptV3 } from './rewriteRegen.v3'

/**
 * The rewrite regenerate prompt (F-14.10), version 4: `rewriteRegen.v3` over `rewrite.v4`'s
 * messages, so the scene's mood and theme (F-5.6) ride the regenerate too, after the steer. The
 * author's note and the fidelity violation clauses are version 3's, byte for byte; with no mood
 * block this is version 3's messages exactly.
 */
export const REWRITE_REGEN_PROMPT_V4_VERSION = 'rewriteRegen.v4'

export interface BuildRewriteRegenPromptV4Input extends BuildRewritePromptV4Input {
  /** The author's note from Regenerate…, or null when the fidelity check drove the retry. */
  note: string | null
  /** The first violation's message, as the fidelity check phrases it, or null. */
  violation: string | null
}

export interface BuiltRewriteRegenPromptV4 {
  version: typeof REWRITE_REGEN_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRewriteRegenPromptV4(
  input: BuildRewriteRegenPromptV4Input
): BuiltRewriteRegenPromptV4 {
  const v3 = buildRewriteRegenPromptV3({
    ...rewriteV3Input(input),
    note: input.note,
    violation: input.violation
  })
  return {
    version: REWRITE_REGEN_PROMPT_V4_VERSION,
    messages: v3.messages,
    maxTokens: v3.maxTokens
  }
}
