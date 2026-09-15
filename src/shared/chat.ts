import { z } from 'zod'
import { toTagName } from './tags'

/**
 * The AI assistant panel (F-5.4): conversations are per project and live as JSON under the
 * settings key `conversations` (the domain model files conversation history under Settings),
 * capped so the row cannot grow without bound. Main is stateless about them: the renderer owns
 * the list, sends the recent turns with each request, and persists after every change.
 */
export const CONVERSATIONS_KEY = 'conversations'

/** Plan answers in the chat; Agent places the answer in the editor as ghost text. */
export const CHAT_MODES = ['plan', 'agent'] as const
export const ChatMode = z.enum(CHAT_MODES)
export type ChatMode = z.infer<typeof ChatMode>
export const CHAT_MODE_LABEL: Record<ChatMode, string> = { plan: 'Plan', agent: 'Agent' }

export const CHAT_PARAGRAPHS_MIN = 1
export const CHAT_PARAGRAPHS_MAX = 10
export const CHAT_PARAGRAPHS_DEFAULT = 1
/** Output tokens asked for per paragraph in Agent mode; Plan mode always gets the feature cap. */
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
  /** The mode the turn was made in; an Agent turn's text went to the editor, not the chat. */
  mode: ChatMode.nullable()
})
export type ChatMessage = z.infer<typeof ChatMessage>

export const Conversation = z.object({
  id: z.string(),
  title: z.string().max(CHAT_TITLE_MAX),
  mode: ChatMode,
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

/** Lenient read of the stored row: anything off-shape is a fresh, empty state. */
export function parseStoredConversations(raw: unknown): Conversations {
  const parsed = Conversations.safeParse(raw)
  return parsed.success ? parsed.data : defaultConversations()
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
