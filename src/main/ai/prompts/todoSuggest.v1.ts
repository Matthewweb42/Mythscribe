import type { AiMessage } from '../providers/types'

/**
 * A To do item's suggestions (F-9.16), version 1: the item (what is left open and why), where the
 * author's line would go and what it holds now, the record's fields, and up to three passages
 * that name it; the model offers two or three short options. They are labelled "Suggestion" in
 * the app and fill only an editable line: nothing is written until the author adds it. Asked once
 * per item when its card is first shown, and cached on the item. Prompt files are versioned
 * (F-5.12).
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules alone in the system turn; the item and
 * its context in the user turn.
 */
export const TODO_SUGGEST_PROMPT_VERSION = 'todoSuggest.v1'

/** One request's answer cap: three options of at most 160 characters as JSON. */
export const TODO_SUGGEST_MAX_TOKENS = 300

/** The rules; the opening sentence is the one the e2e's fake provider keys on. */
export const TODO_SUGGEST_RULES =
  'You are the To do suggestions inside a novel-writing app. The book leaves the gap below ' +
  'open. Offer 2 or 3 short options the author could choose to close it, each one sentence of ' +
  'at most 160 characters, consistent with the passages and the sheet and never contradicting ' +
  'them. They are options, not facts: never claim the book says them. Reply with JSON only: ' +
  '{"suggestions":["…","…"]}.'

export interface BuildTodoSuggestPromptInput {
  /** "Gap", "Undefined", "Loose end", "Contradiction". */
  kind: string
  subject: string
  why: string
  /** Where the author's line goes ("Mara › Goals / motivations"); '' for nowhere. */
  target: string
  /** What that place holds now; '' when empty. */
  current: string
  /** The record's filled fields as `Label: value` lines, already cut; '' for none. */
  record: string
  /** Up to three passages that name the subject, each already cut. */
  passages: readonly string[]
}

export interface BuiltTodoSuggestPrompt {
  version: typeof TODO_SUGGEST_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildTodoSuggestPrompt(input: BuildTodoSuggestPromptInput): BuiltTodoSuggestPrompt {
  const lines = [
    `${input.kind}: ${input.subject}`,
    `Why: ${input.why}`,
    ...(input.target === '' ? [] : [`The line goes to: ${input.target}`]),
    ...(input.current === '' ? [] : [`It holds now: ${input.current}`]),
    ...(input.record === '' ? [] : [`Sheet:\n${input.record}`]),
    ...(input.passages.length === 0
      ? []
      : [`Passages:\n${input.passages.map((passage) => `- ${passage}`).join('\n')}`]),
    'Suggest the options.'
  ]
  return {
    version: TODO_SUGGEST_PROMPT_VERSION,
    messages: [
      { role: 'system', content: TODO_SUGGEST_RULES },
      { role: 'user', content: lines.join('\n') }
    ],
    maxTokens: TODO_SUGGEST_MAX_TOKENS
  }
}
