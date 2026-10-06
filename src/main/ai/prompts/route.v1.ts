import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'
import type { ChatTurn } from './chat.v1'

/**
 * The assistant router prompt (F-5.19), version 1: classify the author's chat message into the
 * one feature that answers it, as JSON `{ "action": "...", "instruction": "..." }`. The answer
 * is never shown; `parseRouteAnswer` reads it and every unreadable answer falls back to `chat`.
 * Prompt files are versioned (F-5.12): a change to the text, the caps, or the message order is a
 * new file with its own golden test, never an edit to this one.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the whole stable prefix (the
 * rules and the action list, identical on every call, so the provider caches it); the user turn
 * carries what changes: the last turns, the open document, the selection's opening, and the
 * message. The caller cuts every part to its cap (`@shared/assistantRoute`) before building.
 */
export const ROUTE_PROMPT_VERSION = 'route.v1'

/** The opening sentence; a fake provider in tests can key on it. */
export const ROUTE_RULES =
  "You are the router inside a novel-writing app's assistant. Read the author's message and " +
  'pick the one action that answers it. Reply with JSON only: ' +
  '{"action":"chat","instruction":""}. Actions:\n' +
  '- chat: discussion, brainstorming, advice, or anything else.\n' +
  '- query: a question about what happens or is true in the manuscript (who, what, where, when).\n' +
  '- rewrite: rewrite, rephrase, tighten, or otherwise change the selected passage; only when a ' +
  'passage is selected.\n' +
  "- critique: editor's notes or feedback on the writing of the scene.\n" +
  '- betaReader: how a first-time reader experiences the scene.\n' +
  '- proofread: spelling, typos, grammar, and punctuation.\n' +
  '- continuity: check the scene for contradictions with the story so far.\n' +
  '- whatNext: ideas for what could happen next.\n' +
  "- synopsis: write or suggest the scene's synopsis.\n" +
  "- notes: suggest key points to keep in mind in the scene's notes.\n" +
  'Set "instruction" to the specific request restated in one short sentence for that action ' +
  '(for rewrite, how to change the passage; for notes, what to focus on), or "" when there is ' +
  'none. Never answer the message itself.'

export interface BuildRoutePromptInput {
  /** The message, already cut to `ROUTE_MESSAGE_CHARS`. */
  message: string
  /** The last turns, oldest first, each already cut to `ROUTE_TURN_CHARS`. */
  history: ChatTurn[]
  /** The open document as "scene \"Title\"", or null with none open. */
  active: string | null
  /** The opening of the selected passage, or null with no selection. */
  selection: string | null
}

export interface BuiltRoutePrompt {
  version: typeof ROUTE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRoutePrompt(input: BuildRoutePromptInput): BuiltRoutePrompt {
  const user: string[] = []
  if (input.history.length) {
    const turns = input.history.map(
      (turn) => `${turn.role === 'user' ? 'Author' : 'Assistant'}: ${turn.content}`
    )
    user.push(`Recent turns:\n${turns.join('\n')}`)
  }
  user.push(input.active ? `Open document: ${input.active}` : 'No document is open.')
  user.push(
    input.selection
      ? `Selected passage (opening):\n"""\n${input.selection}\n"""`
      : 'No passage is selected.'
  )
  user.push(`Message:\n"""\n${input.message}\n"""`)

  return {
    version: ROUTE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: ROUTE_RULES },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('route')
  }
}
