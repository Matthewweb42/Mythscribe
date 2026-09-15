import type { AiMessage } from '../providers/types'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'
import { buildGhostTextPromptV2, type BuildGhostTextPromptV2Input } from './ghostText.v2'

/**
 * The ghost-text regenerate prompt (F-14.7), version 2: `ghostText.v2` (the brief included,
 * F-14.3) with the same one clause version 1 appends to the system turn, naming what the
 * fidelity check found wrong with the first answer. Everything else (the voice block, the
 * preset, the user turn, the caps) is the same, so the provider's cached prefix still applies
 * up to the clause. A change to the clause or the base prompt is a new file with its own
 * golden test, never an edit here.
 */
export const GHOST_REGEN_PROMPT_V2_VERSION = 'ghostTextRegen.v2'

export interface BuildGhostTextRegenPromptV2Input extends BuildGhostTextPromptV2Input {
  /** The first violation's message, as `checkGhostTextFidelity` phrases it ("switches to present tense"). */
  violation: string
}

export interface BuiltGhostTextRegenPromptV2 {
  version: typeof GHOST_REGEN_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

export function buildGhostTextRegenPromptV2(
  input: BuildGhostTextRegenPromptV2Input
): BuiltGhostTextRegenPromptV2 {
  const base = buildGhostTextPromptV2(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different continuation that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content} ${clause}` } : message
  )
  return {
    version: GHOST_REGEN_PROMPT_V2_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
