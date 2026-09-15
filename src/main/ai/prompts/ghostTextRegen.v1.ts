import type { AiMessage } from '../providers/types'
import { buildGhostTextPrompt, type BuildGhostTextPromptInput } from './ghostText.v1'

/**
 * The ghost-text regenerate prompt (F-14.7), version 1: `ghostText.v1` with one clause
 * appended to the system turn naming what the fidelity check found wrong with the first
 * answer. Everything else (the voice block, the preset, the user turn, the caps) is the
 * same, so the provider's cached prefix still applies up to the clause. A change to the
 * clause or the base prompt is a new file with its own golden test, never an edit here.
 */
export const GHOST_REGEN_PROMPT_VERSION = 'ghostTextRegen.v1'

export interface BuildGhostTextRegenPromptInput extends BuildGhostTextPromptInput {
  /** The first violation's message, as `checkGhostTextFidelity` phrases it ("switches to present tense"). */
  violation: string
}

export interface BuiltGhostTextRegenPrompt {
  version: typeof GHOST_REGEN_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

/** The clause appended to the system turn; exported so the fake server and tests recognise a regenerate. */
export const REGEN_CLAUSE_PREFIX = 'Your last attempt'

export function buildGhostTextRegenPrompt(
  input: BuildGhostTextRegenPromptInput
): BuiltGhostTextRegenPrompt {
  const base = buildGhostTextPrompt(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different continuation that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content} ${clause}` } : message
  )
  return {
    version: GHOST_REGEN_PROMPT_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
