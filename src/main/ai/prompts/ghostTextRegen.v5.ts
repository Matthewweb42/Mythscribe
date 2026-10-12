import type { AiMessage } from '../providers/types'
import { ghostTextV4Input, type BuildGhostTextPromptV5Input } from './ghostText.v5'
import { buildGhostTextRegenPromptV4 } from './ghostTextRegen.v4'

/**
 * The ghost-text regenerate prompt (F-14.7), version 5 (F-16.14, story memory v2 only):
 * `ghostTextRegen.v4`'s one clause naming what the fidelity check found, on `ghostText.v5`'s
 * messages (the Story notes block in the bible's slot, no steer). Everything else is version 4's,
 * so the provider's cached prefix still applies up to the clause. A change is a new file.
 */
export const GHOST_REGEN_PROMPT_V5_VERSION = 'ghostTextRegen.v5'

export interface BuildGhostTextRegenPromptV5Input extends BuildGhostTextPromptV5Input {
  /** The first violation's message, as `checkGhostTextFidelity` phrases it. */
  violation: string
}

export interface BuiltGhostTextRegenPromptV5 {
  version: typeof GHOST_REGEN_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

export function buildGhostTextRegenPromptV5(
  input: BuildGhostTextRegenPromptV5Input
): BuiltGhostTextRegenPromptV5 {
  const v4 = buildGhostTextRegenPromptV4({ ...ghostTextV4Input(input), violation: input.violation })
  return { ...v4, version: GHOST_REGEN_PROMPT_V5_VERSION }
}
