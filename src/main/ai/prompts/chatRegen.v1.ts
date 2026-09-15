import type { AiMessage } from '../providers/types'
import { buildChatPrompt, type BuildChatPromptInput } from './chat.v1'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The Agent-mode regenerate prompt (F-5.4, F-14.7), version 1: `chat.v1` with one clause
 * appended to the system turn naming what the fidelity check found wrong with the first
 * answer. Everything else (the voice block, the preset, the context, the history, the caps)
 * is the same, so the provider's cached prefix still applies up to the clause. A change to
 * the clause or the base prompt is a new file with its own golden test, never an edit here.
 */
export const CHAT_REGEN_PROMPT_VERSION = 'chatRegen.v1'

export interface BuildChatRegenPromptInput extends BuildChatPromptInput {
  /** The first violation's message, as the fidelity check phrases it. */
  violation: string
}

export interface BuiltChatRegenPrompt {
  version: typeof CHAT_REGEN_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

export function buildChatRegenPrompt(input: BuildChatRegenPromptInput): BuiltChatRegenPrompt {
  const base = buildChatPrompt(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different draft that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content}\n\n${clause}` } : message
  )
  return {
    version: CHAT_REGEN_PROMPT_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
