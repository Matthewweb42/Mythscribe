import type { AiMessage } from '../providers/types'
import { buildChatPromptV4, type BuildChatPromptV4Input } from './chat.v4'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The Agent-mode regenerate prompt (F-5.4, F-14.7), version 4: `chat.v4` (the scene brief, the
 * story bible, and the scene steer included, F-14.3, F-14.9, and F-14.13) with the same one
 * clause version 1 appends to the system turn, naming what the fidelity check found wrong with
 * the first answer. Everything else (the voice block, the preset, the bible, the context with
 * its steer, the history, the caps) is the same, so the provider's cached prefix still applies
 * up to the clause. A change to the clause or the base prompt is a new file with its own golden
 * test, never an edit here.
 */
export const CHAT_REGEN_PROMPT_V4_VERSION = 'chatRegen.v4'

export interface BuildChatRegenPromptV4Input extends BuildChatPromptV4Input {
  /** The first violation's message, as the fidelity check phrases it. */
  violation: string
}

export interface BuiltChatRegenPromptV4 {
  version: typeof CHAT_REGEN_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

export function buildChatRegenPromptV4(input: BuildChatRegenPromptV4Input): BuiltChatRegenPromptV4 {
  const base = buildChatPromptV4(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different draft that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content}\n\n${clause}` } : message
  )
  return {
    version: CHAT_REGEN_PROMPT_V4_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
