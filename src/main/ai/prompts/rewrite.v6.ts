import type { AiMessage } from '../providers/types'
import { buildRewritePromptV4, type BuildRewritePromptV4Input } from './rewrite.v4'

/**
 * The rewrite-in-my-voice prompt (F-14.10), version 6 (notes fixes, 2026-10-15, `fixes-1.md` §3):
 * Rewrite in the chat's Vibe mode, story memory v1. Version 4's request (the rules, the voice
 * block, the story bible's slot and the scene line in the system turn; the steer, the mood, the
 * text each side and the passage in the user turn) with one line more at the very end of the user
 * turn, after the cached prefix: Vibe may be bolder within the passage. Brainstorm and Write keep
 * sending version 4 (and a v2 project version 5), byte for byte. The cap is version 4's.
 */
export const REWRITE_PROMPT_V6_VERSION = 'rewrite.v6'

/** What Vibe adds, after "Rewrite the passage.". */
export const REWRITE_V6_VIBE_LINE =
  'Mode Vibe: be bolder than a close rewrite: tighten hard, cut what drags, reorder sentences, sharpen the dialogue, and add a missing beat if the passage needs one. Stay within this passage, keep its point of view, tense, names and facts, and keep the author’s voice.'

export interface BuiltRewritePromptV6 {
  version: typeof REWRITE_PROMPT_V6_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRewritePromptV6(input: BuildRewritePromptV4Input): BuiltRewritePromptV6 {
  const v4 = buildRewritePromptV4(input)
  return {
    version: REWRITE_PROMPT_V6_VERSION,
    messages: v4.messages.map((message, index) =>
      index === v4.messages.length - 1
        ? { ...message, content: `${message.content}\n\n${REWRITE_V6_VIBE_LINE}` }
        : message
    ),
    maxTokens: v4.maxTokens
  }
}
