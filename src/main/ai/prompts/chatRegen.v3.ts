import type { AiMessage } from '../providers/types'
import { buildChatPromptV3, type BuildChatPromptV3Input } from './chat.v3'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The Agent-mode regenerate prompt (F-5.4, F-14.7), version 3: `chat.v3` (the scene brief and
 * the story bible included, F-14.3 and F-14.9) with the same one clause version 1 appends to
 * the system turn, naming what the fidelity check found wrong with the first answer.
 * Everything else (the voice block, the preset, the bible, the context, the history, the caps)
 * is the same, so the provider's cached prefix still applies up to the clause. A change to the
 * clause or the base prompt is a new file with its own golden test, never an edit here.
 */
export const CHAT_REGEN_PROMPT_V3_VERSION = 'chatRegen.v3'

export interface BuildChatRegenPromptV3Input extends BuildChatPromptV3Input {
  /** The first violation's message, as the fidelity check phrases it. */
  violation: string
}

export interface BuiltChatRegenPromptV3 {
  version: typeof CHAT_REGEN_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

export function buildChatRegenPromptV3(input: BuildChatRegenPromptV3Input): BuiltChatRegenPromptV3 {
  const base = buildChatPromptV3(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different draft that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content}\n\n${clause}` } : message
  )
  return {
    version: CHAT_REGEN_PROMPT_V3_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
