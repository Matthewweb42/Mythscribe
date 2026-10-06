import type { AiMessage } from '../providers/types'
import { buildChatPromptV5, type BuildChatPromptV5Input } from './chat.v5'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The Agent-mode regenerate prompt (F-5.4, F-14.7), version 5: `chat.v5` (the side panel
 * included, F-5.20) with the same one clause every earlier version appends to the system turn,
 * naming what the fidelity check found wrong with the first answer. Everything else is the same,
 * so the provider's cached prefix still applies up to the clause. A change to the clause or the
 * base prompt is a new file with its own golden test, never an edit here.
 */
export const CHAT_REGEN_PROMPT_V5_VERSION = 'chatRegen.v5'

export interface BuildChatRegenPromptV5Input extends BuildChatPromptV5Input {
  /** The first violation's message, as the fidelity check phrases it. */
  violation: string
}

export interface BuiltChatRegenPromptV5 {
  version: typeof CHAT_REGEN_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

export function buildChatRegenPromptV5(input: BuildChatRegenPromptV5Input): BuiltChatRegenPromptV5 {
  const base = buildChatPromptV5(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different draft that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content}\n\n${clause}` } : message
  )
  return {
    version: CHAT_REGEN_PROMPT_V5_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
