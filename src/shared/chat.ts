import { z } from 'zod'
import { AgentTurn, type AgentAccess } from './agent'
import { AiUsage } from './ai'
import type { AssistantMode } from './aiSettings'
import { RouteAction } from './assistantRoute'
import { EditTurn } from './editRequest'
import { QueryTurn } from './query'
import { toTagName } from './tags'
import { WhatNextDirection } from './whatNext'

/**
 * The AI assistant panel (F-5.4): conversations are per project and live as JSON under the
 * settings key `conversations` (the domain model files conversation history under Settings),
 * capped so the row cannot grow without bound. Main is stateless about them: the renderer owns
 * the list, sends the recent turns with each request, and persists after every change.
 */
export const CONVERSATIONS_KEY = 'conversations'

/**
 * The request a stored turn was made in: Query (F-5.7) answered about the whole manuscript with
 * citations; Author (`agent`) placed its answer in the editor as ghost text; Plan answered in
 * the chat. Since 2026-10-07 the chat's modes are Auto, Ask, and Plan (`AssistantMode`, one
 * setting per project); these values stay so every stored turn parses and renders as it was,
 * and a new turn records `query` for a cited lookup and `plan` for a chat answer.
 */
export const CHAT_MODES = ['query', 'agent', 'plan'] as const
export const ChatMode = z.enum(CHAT_MODES)
export type ChatMode = z.infer<typeof ChatMode>
export const CHAT_MODE_LABEL: Record<ChatMode, string> = {
  query: 'Query',
  agent: 'Author',
  plan: 'Plan'
}

/**
 * The per-conversation mode stored before 2026-10-07 (`auto` routed, the others pinned one
 * request). Still parsed so old conversations load; ignored since the chat mode became one
 * project setting (`AiSettings.chatMode`), and no longer written.
 */
export const CONVERSATION_MODES = ['auto', ...CHAT_MODES] as const
export const ConversationMode = z.enum(CONVERSATION_MODES)
export type ConversationMode = z.infer<typeof ConversationMode>

/**
 * What the chat agent (F-5.22) may do in a chat mode (decided by the author 2026-10-07): Plan
 * gets the read-only tools, so it researches the whole project but never proposes an edit; Ask
 * and Auto may propose edits.
 */
export function agentAccessFor(mode: AssistantMode): AgentAccess {
  return mode === 'plan' ? 'read' : 'write'
}

/** Whether the chat applies the agent's edits itself (each with Undo; deletions still ask): only Auto. */
export function appliesEditsItself(mode: AssistantMode): boolean {
  return mode === 'auto'
}

/**
 * The router's picks (F-5.19) a Plan turn may run as they are: the answer in the chat, a cited
 * lookup, three directions, and a beta read, none of which proposes an edit. Every other pick
 * (a rewrite, proofread, editor's notes with fixes, a consistency check with fixes, a suggested
 * synopsis or notes, an edit pass, F-5.26) is answered by the read-only chat instead, which may
 * describe what it would do. Decided by Claude, unconfirmed.
 */
export const PLAN_ROUTE_ACTIONS: readonly RouteAction[] = [
  'chat',
  'query',
  'whatNext',
  'betaReader'
]

/** The action a routed turn runs in `mode`: the router's pick, or chat where Plan forbids it. */
export function routeActionFor(mode: AssistantMode, action: RouteAction): RouteAction {
  return mode === 'plan' && !PLAN_ROUTE_ACTIONS.includes(action) ? 'chat' : action
}

export const CHAT_PARAGRAPHS_MIN = 1
export const CHAT_PARAGRAPHS_MAX = 10
export const CHAT_PARAGRAPHS_DEFAULT = 1
/** Output tokens asked for per paragraph in Author mode; Plan mode always gets the feature cap. */
export const CHAT_TOKENS_PER_PARAGRAPH = 120

export const CHAT_MESSAGE_MAX = 4_000
/** How many recent messages ride along with a request as history. */
export const CHAT_HISTORY_TURNS = 10
export const CHAT_MAX_CONVERSATIONS = 10
/** Messages kept per conversation; the oldest are dropped first. */
export const CHAT_MAX_MESSAGES = 200
export const CHAT_TITLE_MAX = 40

/** The active scene's text rides along head-truncated to this many characters. */
export const CHAT_SCENE_CHAR_BUDGET = 6_000
/** Notes pulled in with `#name` share this many characters, split evenly across the names. */
export const CHAT_REF_NOTES_CHAR_BUDGET = 2_000
/** How many `#name` references one message may pull in. */
export const CHAT_MAX_REFS = 4

export const ChatRole = z.enum(['user', 'assistant'])
export type ChatRole = z.infer<typeof ChatRole>

/** One turn; the assistant's carries what produced it (cost is visible, CLAUDE.md rule 10). */
export const ChatMessage = z.object({
  id: z.string(),
  role: ChatRole,
  content: z.string(),
  created: z.string(),
  /** The `ai_proposal` row (F-14.5) of an assistant turn; null for the author's. */
  proposalId: z.string().nullable(),
  model: z.string().nullable(),
  costUsd: z.number().nullable(),
  /** The tokens the turn spent (F-5.9); null for the author's and for rows written before it. */
  usage: AiUsage.nullable().default(null),
  /**
   * The mode the turn was made in; an Author turn's text went to the editor, not the chat. Read
   * leniently (F-16.2): a mode this build no longer has reads as null and the turn keeps its text.
   */
  mode: ChatMode.nullable().catch(null),
  /**
   * A Query turn's citations and flags (F-5.7); null for every other turn and for rows written
   * before it. Every structured part of a turn reads leniently (F-16.2): a part that no longer
   * parses (a shape retired at the story-memory switch-over) is null, and the turn keeps its text.
   */
  query: QueryTurn.nullable().catch(null).default(null),
  /** A What should come next? turn's directions (F-5.17); null for every other turn and for rows written before it. */
  directions: z.array(WhatNextDirection).nullable().catch(null).default(null),
  /**
   * The feature the router (F-5.19) picked for this turn in an Auto conversation, shown as a
   * label on the turn; null for a turn sent in a fixed mode and for rows written before it, and
   * for an action this build no longer has (F-16.2: retired at the switch-over).
   */
  action: RouteAction.nullable().catch(null).default(null),
  /**
   * A chat agent turn's lookups and edits (F-5.22) and where each edit stands; null for every
   * other turn and for rows written before it.
   */
  agent: AgentTurn.nullable().catch(null).default(null),
  /**
   * F-5.26: an edit request's target, its choices, and what was picked and started; null for
   * every other turn and for rows written before it.
   */
  edit: EditTurn.nullable().catch(null).default(null)
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const Conversation = z.object({
  id: z.string(),
  title: z.string().max(CHAT_TITLE_MAX),
  /** Stored before 2026-10-07; ignored and no longer written (`ConversationMode`); read leniently. */
  mode: ConversationMode.optional().catch(undefined),
  paragraphs: z.number().int().min(CHAT_PARAGRAPHS_MIN).max(CHAT_PARAGRAPHS_MAX),
  messages: z.array(ChatMessage).max(CHAT_MAX_MESSAGES),
  created: z.string(),
  modified: z.string()
})
export type Conversation = z.infer<typeof Conversation>

export const Conversations = z.object({
  /** The open tab; null only when there are no conversations. */
  active: z.string().nullable(),
  items: z.array(Conversation).max(CHAT_MAX_CONVERSATIONS)
})
export type Conversations = z.infer<typeof Conversations>

export function defaultConversations(): Conversations {
  return { active: null, items: [] }
}

/**
 * Lenient read of the stored row (F-16.2). A row that parses whole is used as it is. Otherwise
 * each conversation is salvaged on its own: a turn that no longer parses is dropped and the rest
 * of its conversation kept, and a conversation that still does not parse is dropped, so one bad
 * turn can never empty the whole chat history. A row that is not even a list of conversations is
 * a fresh, empty state.
 */
export function parseStoredConversations(raw: unknown): Conversations {
  const parsed = Conversations.safeParse(raw)
  if (parsed.success) return parsed.data
  const stored = z.object({ active: z.unknown(), items: z.array(z.unknown()) }).safeParse(raw)
  if (!stored.success) return defaultConversations()
  const items = stored.data.items
    .map(salvageConversation)
    .filter((item): item is Conversation => item !== null)
    .slice(0, CHAT_MAX_CONVERSATIONS)
  const active = stored.data.active
  return {
    active:
      typeof active === 'string' && items.some((item) => item.id === active)
        ? active
        : (items[0]?.id ?? null),
    items
  }
}

function salvageConversation(raw: unknown): Conversation | null {
  const whole = Conversation.safeParse(raw)
  if (whole.success) return whole.data
  if (typeof raw !== 'object' || raw === null || !('messages' in raw)) return null
  const messages = Array.isArray(raw.messages)
    ? raw.messages.filter((message: unknown) => ChatMessage.safeParse(message).success)
    : []
  const kept = Conversation.safeParse({ ...raw, messages })
  return kept.success ? kept.data : null
}

/** A conversation's title is its first message, cut to fit. */
export function titleFor(firstMessage: string): string {
  const line = firstMessage.trim().split('\n')[0] ?? ''
  return line.length > CHAT_TITLE_MAX ? `${line.slice(0, CHAT_TITLE_MAX - 1).trimEnd()}…` : line
}

const TAG_REF = /#([\p{L}\p{N}][\p{L}\p{N}_-]*)/gu

/**
 * The `#name` references in a message as normalized tag names, first appearance first, at most
 * `CHAT_MAX_REFS`. Matching against the bank is the caller's job.
 */
export function parseTagRefs(text: string): string[] {
  const names: string[] = []
  for (const match of text.matchAll(TAG_REF)) {
    const name = toTagName(match[1] ?? '')
    if (name && !names.includes(name)) names.push(name)
    if (names.length === CHAT_MAX_REFS) break
  }
  return names
}
