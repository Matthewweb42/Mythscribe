import type { AiMessage } from '../providers/types'
import { buildChatPromptV2, type BuildChatPromptV2Input } from './chat.v2'
import { REGEN_CLAUSE_PREFIX } from './ghostTextRegen.v1'

/**
 * The Agent-mode regenerate prompt (F-5.4, F-14.7), version 2: `chat.v2` (the scene brief
 * included, F-14.3) with the same one clause version 1 appends to the system turn, naming what
 * the fidelity check found wrong with the first answer. Everything else (the voice block, the
 * preset, the context, the history, the caps) is the same, so the provider's cached prefix
 * still applies up to the clause. A change to the clause or the base prompt is a new file with
 * its own golden test, never an edit here.
 */
export const CHAT_REGEN_PROMPT_V2_VERSION = 'chatRegen.v2'

export interface BuildChatRegenPromptV2Input extends BuildChatPromptV2Input {
  /** The first violation's message, as the fidelity check phrases it. */
  violation: string
}

export interface BuiltChatRegenPromptV2 {
  version: typeof CHAT_REGEN_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

export function buildChatRegenPromptV2(input: BuildChatRegenPromptV2Input): BuiltChatRegenPromptV2 {
  const base = buildChatPromptV2(input)
  const clause =
    `${REGEN_CLAUSE_PREFIX} ${input.violation}. ` +
    "Write a different draft that keeps the manuscript's voice."
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content}\n\n${clause}` } : message
  )
  return {
    version: CHAT_REGEN_PROMPT_V2_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
