import type { AiMessage } from '../providers/types'
import { buildTagsPrompt, type BuildTagsPromptInput } from './tags.v1'

/**
 * The tag-recommendation regenerate prompt (F-14.5), version 1: `tags.v1` with one clause
 * appended to the system turn saying the author asked for a different set, quoting their note
 * when they left one. Everything else (the bank, the passage, the caps) is the same, so the
 * provider's cached prefix still applies up to the clause. A change to the clause or the base
 * prompt is a new file with its own golden test, never an edit here.
 */
export const TAGS_REGEN_PROMPT_VERSION = 'tagsRegen.v1'

export interface BuildTagsRegenPromptInput extends BuildTagsPromptInput {
  /** The author's note on what was off, trimmed; null when they left it blank. */
  note: string | null
}

export interface BuiltTagsRegenPrompt {
  version: typeof TAGS_REGEN_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The clause appended to the system turn; exported so the fake server and tests recognise a regenerate. */
export const TAGS_REGEN_CLAUSE_PREFIX = 'The writer asked for a different set'

export function buildTagsRegenPrompt(input: BuildTagsRegenPromptInput): BuiltTagsRegenPrompt {
  const base = buildTagsPrompt(input)
  const clause =
    `${TAGS_REGEN_CLAUSE_PREFIX}` +
    (input.note === null ? '.' : ` and said: "${input.note}".`) +
    ' Pick again with that in mind; every name still comes from the bank.'
  const messages = base.messages.map((message) =>
    message.role === 'system' ? { ...message, content: `${message.content} ${clause}` } : message
  )
  return { version: TAGS_REGEN_PROMPT_VERSION, messages, maxTokens: base.maxTokens }
}
