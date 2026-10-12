import type { AiMessage } from '../providers/types'
import { critiqueV3Input, type BuildCritiquePromptV4Input } from './critique.v4'
import { buildCritiqueRegenPromptV3 } from './critiqueRegen.v3'

/**
 * The editor's-notes regenerate prompt (F-14.8), version 4 (F-16.14, story memory v2 only):
 * `critiqueRegen.v3`'s note clause, byte for byte, over `critique.v4`'s messages (the Story notes
 * block in the bible's slot). A change is a new file.
 */
export const CRITIQUE_REGEN_PROMPT_V4_VERSION = 'critiqueRegen.v4'

export interface BuildCritiqueRegenPromptV4Input extends BuildCritiquePromptV4Input {
  /** The author's note from Ask again…, normalized, or null when they gave none. */
  note: string | null
}

export interface BuiltCritiqueRegenPromptV4 {
  version: typeof CRITIQUE_REGEN_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildCritiqueRegenPromptV4(
  input: BuildCritiqueRegenPromptV4Input
): BuiltCritiqueRegenPromptV4 {
  const v3 = buildCritiqueRegenPromptV3({ ...critiqueV3Input(input), note: input.note })
  return {
    version: CRITIQUE_REGEN_PROMPT_V4_VERSION,
    messages: v3.messages,
    maxTokens: v3.maxTokens
  }
}
