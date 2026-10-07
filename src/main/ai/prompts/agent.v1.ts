import { outputBudget } from '@shared/ai'
import { AGENT_MAX_EDITS, AGENT_MAX_STEPS, AGENT_READ_CHARS, type AgentAccess } from '@shared/agent'
import type { AiMessage } from '../providers/types'
import type { ChatTurn } from './chat.v1'

/**
 * The chat agent prompt (F-5.22), version 1: research, then answer. Every step the model replies
 * with one JSON object, a tool call or the final reply; main runs the tool and appends its call
 * and result as one assistant turn and one user turn, so the conversation grows step by step.
 * Prompt files are versioned (F-5.12): a change to the text or the message order is a new file
 * with its own golden test, never an edit to this one.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn opens with the rules (identical for
 * every read run, and for every write run), then the voice block (write runs only; it changes
 * when the author's prose does), then the open document, which changes with every message.
 * History turns are real user/assistant turns, then the message, then the steps so far.
 */
export const AGENT_PROMPT_VERSION = 'agent.v1'

/** The opening sentence; the e2e's fake provider keys on it. */
export const AGENT_RULES =
  "You are the assistant inside a novel-writing app, working for the book's author. Before you " +
  "reply you may look things up in the author's project with tools; look up only what the " +
  'message needs, mostly about the open document.\n' +
  'Reply with one JSON object and nothing else: a tool call, ' +
  '{"tool":"search","args":{"query":"ledger"}}, or your reply, ' +
  '{"answer":"...","found":true,"citations":[{"id":"n3","quote":"..."}]}.\n' +
  'Tools (documents are named by ids like n3):\n' +
  '- search {"query"}: the scenes that match best, with ids and summaries.\n' +
  '- outline {}: every part, chapter, and scene with its id and word count.\n' +
  `- read_scene {"id","from"}: ${AGENT_READ_CHARS.toLocaleString('en-US')} characters of a ` +
  'document from character "from" (default 0).\n' +
  '- read_notes {"id"}: a document\'s synopsis and notes.\n' +
  '- read_summary {"id"}: a scene\'s stored summary and key points.\n' +
  '- read_sheet {"name"}: a story-bible sheet (a character, setting, or world entry).\n' +
  '- list_sheets {"kind"}: sheet names; kind is character, setting, world, or "" for all.\n' +
  '- tags {}: the tag names by category.\n' +
  `At most ${AGENT_MAX_STEPS} tool calls, then reply. Ground what you say about the book in text ` +
  'you read: cite a passage as {"id","quote"} with the quote copied exactly, and mark it in the ' +
  'answer as [1], [2] in citation order. If the project does not answer the question, say so ' +
  'and set "found" to false. The answer is plain prose for the author.'

/** What a write run adds to the rules: the edits it may propose. */
export const AGENT_EDIT_RULES =
  `To change the project, add "edits" (at most ${AGENT_MAX_EDITS}) to your reply; only when the ` +
  'message asks for a change or clearly invites one. The author approves each edit, or it is ' +
  'applied with an undo. "find", "after", and "at" are exact text copied from the document; new ' +
  "prose is in the author's voice, paragraphs separated by a blank line. Edits:\n" +
  '- {"edit":"text","id","find","replace"}: replace one passage ("replace":"" cuts it).\n' +
  '- {"edit":"insert","id","after","text"}: new paragraphs after the paragraph holding "after" ' +
  '("" for the end).\n' +
  '- {"edit":"synopsis","id","text"}\n' +
  '- {"edit":"notes","id","text"}: points added to the notes, one per line.\n' +
  '- {"edit":"sheet","name","field","text"}: one field of a sheet, as read_sheet names it.\n' +
  '- {"edit":"create","level":"scene" or "chapter","in","after","title","text"}: "in" is the ' +
  'parent\'s id, "after" the sibling to follow ("" for last).\n' +
  '- {"edit":"rename","id","title"}\n' +
  '- {"edit":"move","id","in","after"}: "after" is the sibling to follow ("" for first).\n' +
  '- {"edit":"split","id","at","title"}: the paragraph holding "at" and the rest become a new ' +
  'scene.\n' +
  '- {"edit":"merge","id","into"}: this document joins the end of "into" and is deleted.\n' +
  '- {"edit":"tag","id","tag","add"}: add or remove a tag.\n' +
  '- {"edit":"delete","id"}, {"edit":"delete","sheet"}, or {"edit":"delete","tag"}.'

/** What the final request after the step cap says instead of a tool result. */
export const AGENT_FINAL_TURN = 'No more lookups. Reply now with what you have.'

/** One step so far: the model's call as it wrote it, and what the tool answered. */
export interface AgentTranscriptStep {
  call: string
  result: string
}

export interface BuildAgentPromptInput {
  access: AgentAccess
  /** The voice block (F-14.1) for a write run; null for a read run or without a profile. */
  voice: string | null
  /** The open document block (`renderAgentFocus`), or null with none open. */
  focus: string | null
  history: ChatTurn[]
  message: string
  steps: AgentTranscriptStep[]
  /** True for the request after the step or cost cap: the model must reply. */
  final: boolean
}

export interface BuiltAgentPrompt {
  version: typeof AGENT_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildAgentPrompt(input: BuildAgentPromptInput): BuiltAgentPrompt {
  const system = [AGENT_RULES]
  if (input.access === 'write') system.push(AGENT_EDIT_RULES)
  if (input.voice) system.push(input.voice)
  system.push(input.focus ?? 'No document is open.')

  const messages: AiMessage[] = [
    { role: 'system', content: system.join('\n\n') },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: input.message }
  ]
  for (const step of input.steps) {
    messages.push({ role: 'assistant', content: step.call })
    messages.push({ role: 'user', content: step.result })
  }
  if (input.final) messages.push({ role: 'user', content: AGENT_FINAL_TURN })

  return { version: AGENT_PROMPT_VERSION, messages, maxTokens: outputBudget('agent') }
}

/** The open document as the system turn carries it; the parts are already cut to their caps. */
export interface AgentFocusBlock {
  ref: string
  title: string
  level: string
  synopsis: string
  notes: string
  summary: string
  beforeCaret: string
  selection: string
}

export function renderAgentFocus(block: AgentFocusBlock): string {
  const lines = [`Open document ${block.ref}: ${block.title} (${block.level})`]
  if (block.synopsis) lines.push(`Synopsis: ${block.synopsis}`)
  if (block.notes) lines.push(`Notes:\n${block.notes}`)
  if (block.summary) lines.push(`Summary: ${block.summary}`)
  if (block.beforeCaret) lines.push(`Text before the caret:\n"""\n${block.beforeCaret}\n"""`)
  if (block.selection) lines.push(`Selected passage:\n"""\n${block.selection}\n"""`)
  return lines.join('\n')
}
