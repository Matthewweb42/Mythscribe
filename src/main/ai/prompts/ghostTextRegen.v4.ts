import type { AiMessage } from '../providers/types'
import { buildGhostTextPromptV4, type BuildGhostTextPromptV4Input } from './ghostText.v4'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The ghost-text regenerate prompt (F-14.7), version 4: `ghostText.v4` (the brief, the story
 * bible, and the scene steer included, F-14.3, F-14.9, and F-14.13) with the same one clause
 * version 1 appends to the system turn, naming what the fidelity check found wrong with the
 * first answer. Everything else (the voice block, the preset, the bible, the user turn with
 * its steer, the caps) is the same, so the
 * provider's cached prefix still applies up to the clause. A change to the clause or the base
 * prompt is a new file with its own golden test, never an edit here.
 */
export const GHOST_REGEN_PROMPT_V4_VERSION = 'ghostTextRegen.v4'

export interface BuildGhostTextRegenPromptV4Input extends BuildGhostTextPromptV4Input {
  /** The first violation's message, as `checkGhostTextFidelity` phrases it ("switches to present tense"). */
  violation: string
}

export interface BuiltGhostTextRegenPromptV4 {
  version: typeof GHOST_REGEN_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

export function buildGhostTextRegenPromptV4(
  input: BuildGhostTextRegenPromptV4Input
): BuiltGhostTextRegenPromptV4 {
  const base = buildGhostTextPromptV4(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different continuation that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content} ${clause}` } : message
  )
  return {
    version: GHOST_REGEN_PROMPT_V4_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
