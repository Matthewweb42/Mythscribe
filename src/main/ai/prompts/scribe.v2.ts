import type { AssistantMode } from '@shared/aiSettings'
import { SCRIBE_RETRY_MAX_TOKENS, SCRIBE_STEP_MAX_TOKENS, type ScribeAccess } from '@shared/scribe2'
import type { AiMessage } from '../providers/types'
import {
  SCRIBE_FINAL_TURN,
  SCRIBE_MODE_RULES,
  SCRIBE_NOTE_RULES,
  SCRIBE_PROSE_RULES,
  SCRIBE_RETRY_TURN,
  SCRIBE_SENTINEL,
  type BuildScribePromptInput
} from './scribe.v1'

export const SCRIBE_V2_PROMPT_VERSION = 'scribe.v2'

/**
 * Ms Scribe in a story memory v1 project, after the author's first tries of phase 1
 * (2026-10-15): every source carries the exact words she relied on, so the app can open the
 * scene or page at that spot, and she names places by ref alone, which the app writes as the
 * scene's chapter ("the chapter Blades of Alandor"): the author's scenes are titled by point of
 * view. The opening sentence is v1's, the e2e fake's sentinel. Note, prose and mode rules, and
 * the final and retry turns, are v1's.
 */
export const SCRIBE_V2_RULES = [
  SCRIBE_SENTINEL,
  'You see her note pages, a map of the book (each scene’s synopsis and notes), the book (whole, or the scenes picked for this message) and where she is now. The book and the notes are hers.',
  'Ground every answer in her notes, the outline (the map) and the scenes so far. Point to where with the ref alone where the place’s name would go: “in n3”, “from n3 and n4”, “p2 says”. The app writes a scene ref as its chapter’s name (scenes are named “Chapter › Scene”, and a scene’s own title is often only its point-of-view character), and a page ref as the page’s title, so never write a scene’s title yourself.',
  'When a page or a fact is missing, say so plainly (“Rook has no page”) and draw on the pages and scenes that touch it.',
  'Never invent a past event, a fact or a plot turn that fights her notes or the book; mark anything new as a suggestion.',
  'When you suggest, give two options, concrete and short (“instead of <line>, either <A> or <B>”), one close to her plan and one bolder.',
  'Be brief. Refs: scenes n1, n2…; pages p1, p2….',
  'Reply with exactly one JSON object and nothing else: a tool call {"tool":"<name>","args":{…}}, or the answer {"answer":"<text>","sources":[{"ref":"n3","quote":"<5 to 15 words copied exactly from n3>"},{"ref":"p2"}]} with every scene and page the answer rests on; give each passage you relied on as its own source with its exact words as "quote" (the app opens the scene there), at most three per scene.',
  'Read tools: search_book {"query":"words"} finds paragraphs of the book; open_scene {"id":"n3","from":0} reads a scene; list_notes {} lists every page; open_note {"id":"p2"} reads a page.'
].join('\n')

export interface BuiltScribePromptV2 {
  version: typeof SCRIBE_V2_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The rules as one message gets them: the tools its mode allows, then the mode's line. */
export function scribeRulesV2(mode: AssistantMode, access: ScribeAccess): string {
  const parts = [SCRIBE_V2_RULES]
  if (access.notes) parts.push(SCRIBE_NOTE_RULES)
  if (access.prose) parts.push(SCRIBE_PROSE_RULES)
  parts.push(SCRIBE_MODE_RULES[mode === 'brainstorm' && access.notes ? 'save' : mode])
  return parts.join('\n')
}

/**
 * The request in cache order, as v1 builds it: one system message (the rules, the notes, the
 * map, the book, then the moment), the conversation's recent turns, the message, then each step
 * as the model's call and `Result of <tool>:`, and the final or retry turn when it applies.
 */
export function buildScribePromptV2(input: BuildScribePromptInput): BuiltScribePromptV2 {
  const { context } = input
  const system = [
    scribeRulesV2(input.mode, input.access),
    `# Notes\n${context.notes}`,
    `# Book map\n${context.map}`,
    context.bookMode === 'whole'
      ? `# The book\n${context.book}`
      : `# Scenes picked for this message (the rest: open_scene)\n${context.book}`,
    `# Now\n${context.moment}`
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
    version: SCRIBE_V2_PROMPT_VERSION,
    messages,
    maxTokens: input.retry === true ? SCRIBE_RETRY_MAX_TOKENS : SCRIBE_STEP_MAX_TOKENS
  }
}
