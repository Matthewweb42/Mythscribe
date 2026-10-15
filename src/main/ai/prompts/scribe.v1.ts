import type { AssistantMode } from '@shared/aiSettings'
import { SCRIBE_RETRY_MAX_TOKENS, SCRIBE_STEP_MAX_TOKENS, type ScribeAccess } from '@shared/scribe2'
import type { AiMessage } from '../providers/types'
import type { AgentTranscriptStep } from './agent.v1'
import type { ChatTurn } from './chat.v1'

export const SCRIBE_PROMPT_VERSION = 'scribe.v1'

/**
 * Ms Scribe in a story memory v1 project (notes redesign phase 1, 2026-10-15). The opening
 * sentence is the e2e fake's sentinel; keep it first and unchanged within this version.
 */
export const SCRIBE_SENTINEL =
  'You are Ms Scribe, the writing partner inside the author’s novel app.'

export const SCRIBE_RULES = [
  SCRIBE_SENTINEL,
  'You see her note pages, a map of the book (each scene’s synopsis and notes), the book (whole, or the scenes picked for this message) and where she is now. The book and the notes are hers.',
  'Ground every answer in her notes, the outline (the map) and the scenes so far. Point to where: name each scene by title with its ref, as “The Quay (n3)”, and each page by title with its ref (p2).',
  'When a page or a fact is missing, say so plainly (“Rook has no page”) and draw on the pages and scenes that touch it.',
  'Never invent a past event, a fact or a plot turn that fights her notes or the book; mark anything new as a suggestion.',
  'When you suggest, give two options, concrete and short (“instead of <line>, either <A> or <B>”), one close to her plan and one bolder.',
  'Be brief. Refs: scenes n1, n2…; pages p1, p2….',
  'Reply with exactly one JSON object and nothing else: a tool call {"tool":"<name>","args":{…}}, or the answer {"answer":"<text>","sources":["n3","p2"]} with every scene and page the answer rests on.',
  'Read tools: search_book {"query":"words"} finds paragraphs of the book; open_scene {"id":"n3","from":0} reads a scene; list_notes {} lists every page; open_note {"id":"p2"} reads a page.'
].join('\n')

/** The note tools, for a message that may write notes. */
export const SCRIBE_NOTE_RULES = [
  'Note tools, applied at once (she can undo each): edit_note {"id":"p2","text":"…"} rewrites a note page whole, keeping word for word everything not asked to change; with "section":"<heading line>" it replaces only the text under that line; with "append":true it adds "text" at the end (of the section). create_note {"title":"…","text":"…","folder":"<folder title>"} makes a page (folder optional). Sheets and uploads are read-only: put what belongs there in a note page.',
  'After writing, say in the answer which pages you changed.'
].join('\n')

/** The prose tool, for a message that may suggest prose changes. */
export const SCRIBE_PROSE_RULES =
  'propose_prose_edit {"id":"n3","find":"<exact passage, once in the scene>","replace":"<new text>"} suggests a change to the book; she accepts or rejects it. You never change the book yourself; write prose in her voice.'

export const SCRIBE_MODE_RULES: Record<AssistantMode | 'save', string> = {
  brainstorm: 'Mode Brainstorm: think and plan with her; you change nothing.',
  save: 'Mode Brainstorm, and she asked you to save: put what was agreed into the right note page (edit it, or create one when none fits), then name the pages. No prose changes.',
  write:
    'Mode Write: edit or create note pages when she asks or agrees; suggest prose changes with propose_prose_edit.',
  vibe: 'Mode Vibe: as Write, but your prose suggestions are bolder: vivid, surprising, still in her voice and true to her notes.'
}

export const SCRIBE_FINAL_TURN =
  'Answer now with what you have, as {"answer":"…","sources":[…]}; no more tools.'
export const SCRIBE_RETRY_TURN =
  'Your last reply was cut off or was not one JSON object. Reply again, briefly, as one JSON object.'

export interface ScribePromptContext {
  notes: string
  map: string
  book: string
  bookMode: 'whole' | 'picked'
  moment: string
}

export interface BuildScribePromptInput {
  mode: AssistantMode
  access: ScribeAccess
  context: ScribePromptContext
  history: ChatTurn[]
  message: string
  steps: AgentTranscriptStep[]
  final: boolean
  retry?: boolean
}

export interface BuiltScribePrompt {
  version: typeof SCRIBE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The rules as one message gets them: the tools its mode allows, then the mode's line. */
export function scribeRules(mode: AssistantMode, access: ScribeAccess): string {
  const parts = [SCRIBE_RULES]
  if (access.notes) parts.push(SCRIBE_NOTE_RULES)
  if (access.prose) parts.push(SCRIBE_PROSE_RULES)
  parts.push(SCRIBE_MODE_RULES[mode === 'brainstorm' && access.notes ? 'save' : mode])
  return parts.join('\n')
}

/**
 * The request in cache order: one system message (the rules, the notes, the map, the book, then
 * the moment), the conversation's recent turns, the message, then each step as the model's call
 * and `Result of <tool>:`, and the final or retry turn when it applies.
 */
export function buildScribePrompt(input: BuildScribePromptInput): BuiltScribePrompt {
  const { context } = input
  const system = [
    scribeRules(input.mode, input.access),
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
    version: SCRIBE_PROMPT_VERSION,
    messages,
    maxTokens: input.retry === true ? SCRIBE_RETRY_MAX_TOKENS : SCRIBE_STEP_MAX_TOKENS
  }
}
