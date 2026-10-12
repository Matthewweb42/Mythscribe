import type { AiMessage } from '../providers/types'
import { chatV5Input, type BuildChatPromptV6Input } from './chat.v6'
import { buildChatRegenPromptV5 } from './chatRegen.v5'

/**
 * The Author-mode regenerate prompt (F-5.4, F-14.7), version 6 (F-16.14, story memory v2 only):
 * `chatRegen.v5`'s one clause naming the violation, over `chat.v6`'s messages (the Story notes
 * block in the bible's slot, no steer). A change is a new file.
 */
export const CHAT_REGEN_PROMPT_V6_VERSION = 'chatRegen.v6'

export interface BuildChatRegenPromptV6Input extends BuildChatPromptV6Input {
  /** The first violation's message, as the fidelity check phrases it. */
  violation: string
}

export interface BuiltChatRegenPromptV6 {
  version: typeof CHAT_REGEN_PROMPT_V6_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

export function buildChatRegenPromptV6(input: BuildChatRegenPromptV6Input): BuiltChatRegenPromptV6 {
  const v5 = buildChatRegenPromptV5({ ...chatV5Input(input), violation: input.violation })
  return { ...v5, version: CHAT_REGEN_PROMPT_V6_VERSION }
}
