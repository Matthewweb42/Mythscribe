import type { AiMessage } from '../providers/types'
import { rewriteV4Input, type BuildRewritePromptV5Input } from './rewrite.v5'
import { buildRewriteRegenPromptV4 } from './rewriteRegen.v4'

/**
 * The rewrite regenerate prompt (F-14.10), version 5 (F-16.14, story memory v2 only):
 * `rewriteRegen.v4`'s note and violation clauses, byte for byte, over `rewrite.v5`'s messages (the
 * Story notes block in the bible's slot, no steer). A change is a new file.
 */
export const REWRITE_REGEN_PROMPT_V5_VERSION = 'rewriteRegen.v5'

export interface BuildRewriteRegenPromptV5Input extends BuildRewritePromptV5Input {
  /** The author's note from Regenerate…, or null when the fidelity check drove the retry. */
  note: string | null
  /** The first violation's message, as the fidelity check phrases it, or null. */
  violation: string | null
}

export interface BuiltRewriteRegenPromptV5 {
  version: typeof REWRITE_REGEN_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRewriteRegenPromptV5(
  input: BuildRewriteRegenPromptV5Input
): BuiltRewriteRegenPromptV5 {
  const v4 = buildRewriteRegenPromptV4({
    ...rewriteV4Input(input),
    note: input.note,
    violation: input.violation
  })
  return {
    version: REWRITE_REGEN_PROMPT_V5_VERSION,
    messages: v4.messages,
    maxTokens: v4.maxTokens
  }
}
