import { AGENT_WORDS_DEFAULT, AGENT_WORDS_MAX, AGENT_WORDS_MIN } from '@shared/agent'
import { CHAT_PARAGRAPHS_MAX, CHAT_PARAGRAPHS_MIN, CHAT_SCENE_CHAR_BUDGET } from '@shared/chat'
import { PROPOSAL_NOTE_MAX } from '@shared/proposal'
import { getAiSettings } from '../project/settingsStore'
import type { TreeDb } from '../tree/treeStore'
import { runChat, type ChatResult } from './chat'
import { assertFeatureAllowed } from './dial'
import { AiCutOffError, AiFallbackError } from './providers/types'
import type { AiRequestDeps } from './request'
import { runRewrite } from './rewrite'

/** Words a drafted paragraph is counted at, to turn a length ask into a paragraph count. */
export const DRAFT_WORDS_PER_PARAGRAPH = 90

export interface AgentDraftInput {
  /** The document the prose goes into. */
  nodeId: string
  /** What to write, as the agent put it. */
  brief: string
  /** How long an insertion should be, in words (clamped); ignored for a rewrite. */
  words: number
  /**
   * An insertion: the scene's text before the insertion point, at most
   * `CHAT_SCENE_CHAR_BUDGET` characters (the draft continues it). A rewrite: up to
   * `REWRITE_CONTEXT_CHARS` before the passage.
   */
  before: string
  /** A rewrite: up to `REWRITE_CONTEXT_CHARS` after the passage; '' for an insertion. */
  after: string
  /** The passage to rewrite; null for an insertion. */
  passage: string | null
  requestId?: string
}

/** The paragraphs an insertion of `words` words asks for (`CHAT_PARAGRAPHS_MIN`–`MAX`). */
export function draftParagraphs(words: number): number {
  const clamped = Math.min(AGENT_WORDS_MAX, Math.max(AGENT_WORDS_MIN, words || AGENT_WORDS_DEFAULT))
  return Math.min(
    CHAT_PARAGRAPHS_MAX,
    Math.max(CHAT_PARAGRAPHS_MIN, Math.ceil(clamped / DRAFT_WORDS_PER_PARAGRAPH))
  )
}

/** The drafting request's message: the brief, and the length the agent asked for. */
export function draftMessage(brief: string, words: number): string {
  return `${brief.trim()} (about ${Math.min(AGENT_WORDS_MAX, Math.max(AGENT_WORDS_MIN, words || AGENT_WORDS_DEFAULT))} words)`
}

/**
 * The prose behind one of the chat agent's write intents (2026-10-07, the author's report that
 * agent insertions never landed in the editor): the agent's JSON step names what to write and
 * where; this drafts it through the existing voice-checked paths, streaming the first draft to
 * `onDelta` so the editor (an insertion, as ghost text) or the change card (a rewrite) shows the
 * first words at once.
 *
 * An insertion reuses the assistant's drafting request (`runChat` in Agent mode, `chat.v5`):
 * the voice block (F-14.1), the preset (F-5.2), the scene brief, steer, panel, and story bible,
 * with the text before the insertion point as the scene it continues; the fidelity check (F-14.7)
 * regenerates an off-voice draft once and flags it when it stays off. A rewrite reuses the
 * rewrite-in-my-voice request (`runRewrite`, F-14.10) with the brief as the author's note, and
 * the same check. Both run on the fast tier and are costed in the ledger like their features.
 *
 * The gate is the agent's (`agent`), then each path's own. A draft that comes back empty is a
 * failure, never an empty proposal: `AiCutOffError` when the output cap ended it before any text
 * (a reasoning model that thought through the whole cap), else `AiFallbackError`.
 */
export async function draftForAgent(
  db: TreeDb,
  deps: AiRequestDeps,
  input: AgentDraftInput,
  onDelta: (delta: string) => void
): Promise<ChatResult> {
  assertFeatureAllowed(getAiSettings(db), 'agent')
  const requestId = input.requestId === undefined ? {} : { requestId: input.requestId }
  const result =
    input.passage === null
      ? await runChat(
          db,
          deps,
          {
            nodeId: input.nodeId,
            mode: 'agent',
            paragraphs: draftParagraphs(input.words),
            message: draftMessage(input.brief, input.words),
            history: [],
            sceneText: input.before.slice(-CHAT_SCENE_CHAR_BUDGET),
            streamDraft: true,
            ...requestId
          },
          onDelta
        )
      : await runRewrite(
          db,
          deps,
          {
            nodeId: input.nodeId,
            text: input.passage,
            before: input.before,
            after: input.after,
            note: input.brief.slice(0, PROPOSAL_NOTE_MAX),
            ...requestId
          },
          onDelta
        )
  if (result.text.trim() !== '') return result
  if (result.finishReason === 'length') {
    throw new AiCutOffError(
      `The model used its whole output allowance (${result.usage.outputTokens} tokens) before writing anything.`
    )
  }
  throw new AiFallbackError('The model wrote nothing for this change.')
}
