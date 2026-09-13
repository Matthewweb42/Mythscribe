import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'

/**
 * The tag-recommendation prompt (F-4.7), version 1. Prompt files are versioned (F-5.12): a
 * change to the text, the trim budget, or the message order is a new file (`tags.v2.ts`) with
 * its own golden test, never an edit here, so every ledger row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system rules are identical across every
 * project and request, so they lead for provider-side prefix caching; inside the user turn the
 * bank names come first (stable until the author edits the bank) and the passage last.
 */
export const TAGS_PROMPT_VERSION = 'tags.v1'

/**
 * Keeps the passage well under `FEATURE_INPUT_BUDGETS.tags` (8,000 tokens) alongside the bank
 * and the system rules; the first N characters, not head+tail: deterministic, and scenes
 * establish their tag-worthy detail (characters, setting, mood) early.
 */
export const TAGS_TEXT_CHAR_BUDGET = 6_000

const SYSTEM_PROMPT =
  "You are tagging a scene for a fiction writer's tag bank. Pick 3 to 8 tag names from the " +
  'bank that best fit the passage; never invent a name that is not in the bank. If fewer than ' +
  '3 genuinely fit, return only the ones that do. Reply with JSON only: {"tags": ["name", ...]}.'

export interface BuildTagsPromptInput {
  /** The document's plain text (`docToText`). */
  text: string
  /** Every name in the bank, in `tag:list` order. */
  tagNames: string[]
}

export interface BuiltTagsPrompt {
  version: typeof TAGS_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildTagsPrompt({ text, tagNames }: BuildTagsPromptInput): BuiltTagsPrompt {
  const trimmed =
    text.length > TAGS_TEXT_CHAR_BUDGET ? `${text.slice(0, TAGS_TEXT_CHAR_BUDGET)}…` : text
  return {
    version: TAGS_PROMPT_VERSION,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Tag bank: ${tagNames.join(', ')}\n\nPassage:\n${trimmed}` }
    ],
    maxTokens: outputBudget('tags')
  }
}
