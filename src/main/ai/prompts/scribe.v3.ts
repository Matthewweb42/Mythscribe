import type { AssistantMode } from '@shared/aiSettings'
import {
  SCRIBE_RETRY_MAX_TOKENS,
  SCRIBE_STEP_MAX_TOKENS,
  SCRIBE_VIBE_PROSE_MAX,
  type ScribeAccess
} from '@shared/scribe2'
import type { AiMessage } from '../providers/types'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_NOTE_RULES,
  SCRIBE_PROSE_RULES,
  SCRIBE_RETRY_TURN,
  type BuildScribePromptInput
} from './scribe.v1'
import { SCRIBE_V2_RULES } from './scribe.v2'

export const SCRIBE_V3_PROMPT_VERSION = 'scribe.v3'

/**
 * Ms Scribe in a story memory v1 project, Vibe's bolder suggestions (notes redesign, 2026-10-15,
 * `vibe.md` part B). The rules are the same in every mode: v2's, then every tool; the mode is said
 * in the moment (`# Now`, after the notes, the map and the book), so switching mode never changes
 * the cached prefix. In Vibe she proposes prose changes herself, unasked, and may go big; in Write
 * only when asked; Brainstorm changes nothing (main refuses a write tool the mode may not use).
 * The opening sentence is v1's, the e2e fake's sentinel. The final and retry turns are v1's.
 */
export const SCRIBE_V3_RULES = [SCRIBE_V2_RULES, SCRIBE_NOTE_RULES, SCRIBE_PROSE_RULES].join('\n')

/** The mode's line, last in the moment. */
export const SCRIBE_V3_MODE_RULES: Record<AssistantMode | 'save', string> = {
  brainstorm:
    'Mode Brainstorm: think and plan with her; you change nothing (no edit_note, create_note or propose_prose_edit).',
  save: 'Mode Brainstorm, and she asked you to save: put what was agreed into the right note page (edit it, or create one when none fits), then name the pages. No propose_prose_edit.',
  write:
    'Mode Write: edit or create note pages when she asks or agrees. Suggest prose in the answer as options; use propose_prose_edit only when she asks for a change to the book.',
  vibe: `Mode Vibe: be bold and do the work. Where your answer finds a passage that could be stronger, propose the change yourself with propose_prose_edit, unasked, and go big when it is warranted: rewrite a whole paragraph, cut, reorder a beat, add a missing line of dialogue. At most ${SCRIBE_VIBE_PROSE_MAX} changes, each with its reason in one line of the answer. She accepts or rejects each; keep her voice and her notes. Edit or create note pages when she asks or agrees.`
}

/** The mode line one message gets: Brainstorm asked to save reads as its own line. */
export function scribeModeLineV3(mode: AssistantMode, access: ScribeAccess): string {
  return SCRIBE_V3_MODE_RULES[mode === 'brainstorm' && access.notes ? 'save' : mode]
}

export interface BuiltScribePromptV3 {
  version: typeof SCRIBE_V3_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/**
 * The request in cache order: one system message (the rules, the notes, the map, the book, then
 * the moment ending with the mode's line), the conversation's recent turns, the message, then each
 * step as the model's call and `Result of <tool>:`, and the final or retry turn when it applies.
 */
export function buildScribePromptV3(input: BuildScribePromptInput): BuiltScribePromptV3 {
  const { context } = input
  const system = [
    SCRIBE_V3_RULES,
    `# Notes\n${context.notes}`,
    `# Book map\n${context.map}`,
    context.bookMode === 'whole'
      ? `# The book\n${context.book}`
      : `# Scenes picked for this message (the rest: open_scene)\n${context.book}`,
    `# Now\n${context.moment}\n${scribeModeLineV3(input.mode, input.access)}`
  ].join('\n\n')
  const messages: AiMessage[] = [
    { role: 'system', content: system },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.message }
  ]
  for (const step of input.steps) {
    messages.push({ role: 'assistant', content: step.call })
    messages.push({ role: 'user', content: step.result })
  }
  if (input.retry === true) messages.push({ role: 'user', content: SCRIBE_RETRY_TURN })
  else if (input.final) messages.push({ role: 'user', content: SCRIBE_FINAL_TURN })
  return {
    version: SCRIBE_V3_PROMPT_VERSION,
    messages,
    maxTokens: input.retry === true ? SCRIBE_RETRY_MAX_TOKENS : SCRIBE_STEP_MAX_TOKENS
  }
}
