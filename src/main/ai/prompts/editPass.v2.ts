import type { EditPassType } from '@shared/editPass'
import type { AiMessage } from '../providers/types'
import { buildEditPassPrompt, type BuildEditPassPromptInput } from './editPass.v1'

/**
 * The edit-pass prompt (F-14.15), version 2: version 1 plus the scene's mood and theme (F-5.6, the
 * author 2026-10-10) for the passes that reshape prose or judge it (developmental, line, custom):
 * the block `renderSceneMood` makes from the scene's last reading, first in the user turn, so the
 * changes and notes stay in line with them. Copy edit, proofread, and the continuity pass fix what
 * is wrong whatever the mood, so they never carry it. The system turn (the stable prefix shared by
 * every chunk of a pass), the JSON contract, and the cap are version 1's; with no mood block the
 * messages are version 1's exactly. The sentinel stays: the e2e's fake OpenAI keys on it.
 */
export const EDIT_PASS_PROMPT_V2_VERSION = 'editPass.v2'

/** The pass types that carry the scene's mood and theme. */
export const EDIT_PASS_MOOD_TYPES: readonly EditPassType[] = ['developmental', 'line', 'custom']

export interface BuildEditPassPromptV2Input extends BuildEditPassPromptInput {
  /** The scene mood block (F-5.6, `buildSceneMood`), or null when the scene has none yet. */
  mood: string | null
}

export interface BuiltEditPassPromptV2 {
  version: typeof EDIT_PASS_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildEditPassPromptV2(input: BuildEditPassPromptV2Input): BuiltEditPassPromptV2 {
  const v1 = buildEditPassPrompt(input)
  const mood = EDIT_PASS_MOOD_TYPES.includes(input.type) ? input.mood : null
  const messages = mood
    ? v1.messages.map((message) =>
        message.role === 'user' ? { ...message, content: `${mood}\n\n${message.content}` } : message
      )
    : v1.messages
  return { version: EDIT_PASS_PROMPT_V2_VERSION, messages, maxTokens: v1.maxTokens }
}
