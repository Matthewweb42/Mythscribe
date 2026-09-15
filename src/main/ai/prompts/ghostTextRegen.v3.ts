import type { AiMessage } from '../providers/types'
import { buildGhostTextPromptV3, type BuildGhostTextPromptV3Input } from './ghostText.v3'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The ghost-text regenerate prompt (F-14.7), version 3: `ghostText.v3` (the brief and the
 * story bible included, F-14.3 and F-14.9) with the same one clause version 1 appends to the
 * system turn, naming what the fidelity check found wrong with the first answer. Everything
 * else (the voice block, the preset, the bible, the user turn, the caps) is the same, so the
 * provider's cached prefix still applies up to the clause. A change to the clause or the base
 * prompt is a new file with its own golden test, never an edit here.
 */
export const GHOST_REGEN_PROMPT_V3_VERSION = 'ghostTextRegen.v3'

export interface BuildGhostTextRegenPromptV3Input extends BuildGhostTextPromptV3Input {
  /** The first violation's message, as `checkGhostTextFidelity` phrases it ("switches to present tense"). */
  violation: string
}

export interface BuiltGhostTextRegenPromptV3 {
  version: typeof GHOST_REGEN_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

export function buildGhostTextRegenPromptV3(
  input: BuildGhostTextRegenPromptV3Input
): BuiltGhostTextRegenPromptV3 {
  const base = buildGhostTextPromptV3(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different continuation that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content} ${clause}` } : message
  )
  return {
    version: GHOST_REGEN_PROMPT_V3_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
