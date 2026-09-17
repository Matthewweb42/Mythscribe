import { outputBudget } from '@shared/ai'
import { QUERY_MAX_CITATIONS, QUERY_QUOTE_MAX } from '@shared/query'
import type { AiMessage } from '../providers/types'
import type { ChatTurn } from './chat.v1'

/**
 * The Story Intelligence prompt (F-5.7), version 1: the author's question about the whole
 * manuscript, answered from the scenes main retrieved — the top matches in full, the next few
 * as their stored summary (F-5.6) — as JSON that cites the scenes it rests on. Grounded answers
 * only (CLAUDE.md, author-control rule 4): a claim the scenes do not carry is "not found", not a
 * guess, and every citation must quote a scene that went out in full, so main can check it
 * against the text it sent. Prompt files are versioned (F-5.12): a change to the text, the caps,
 * or the message order is a new file with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the rules and then the scenes,
 * so a second question about the same manuscript reuses the provider's prefix cache up to the
 * point where retrieval differs; the history follows as real user/assistant turns and the
 * question is last.
 */
export const QUERY_PROMPT_VERSION = 'query.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a query request by it, so it must not change within this version.
 */
export const QUERY_RULES =
  'You are the Story Intelligence feature inside a novel-writing app. Answer the question ' +
  'about the manuscript using only the scenes below. Reply with JSON only: ' +
  '{"found":true,"answer":"...","citations":[{"scene":1,"quote":"..."}]}. Write the number of ' +
  'a scene in square brackets like [2] after every claim that scene supports, and give the ' +
  'exact passage you relied on as that citation quote, copied word for word from a scene given ' +
  `in full, at most ${QUERY_QUOTE_MAX} characters; a citation whose quote is not in the scene ` +
  `it names is thrown away. Give at most ${QUERY_MAX_CITATIONS} citations. The scenes listed as ` +
  'summaries only are there to orient you and cannot be cited. When the scenes do not answer ' +
  'the question, set "found" to false, say briefly what is there and what is not, and give no ' +
  'citations. Never use knowledge from outside the scenes, and never invent a passage. Keep the ' +
  'answer under 150 words.'

/** One retrieved scene sent in full: the only thing a citation may quote. */
export interface QueryPromptScene {
  /** The scene's title as the panel labels it (`Chapter 1 › The Ferry`). */
  title: string
  /** The plain text as sent, already head-truncated and fitted by the caller. */
  text: string
}

/** One further candidate sent as its stored summary (F-5.6): context, never a citation source. */
export interface QueryPromptSummary {
  title: string
  summary: string
  keyPoints: string[]
}

export interface BuildQueryPromptInput {
  /** The top matches, best first; their numbers are what the `[n]` markers refer to. */
  full: QueryPromptScene[]
  /** The next matches, best first; numbered on after the full ones. */
  summaries: QueryPromptSummary[]
  /** The recent turns of the conversation, oldest first. */
  history: ChatTurn[]
  /** The author's question. */
  question: string
}

export interface BuiltQueryPrompt {
  version: typeof QUERY_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The system turn: the rules, the scenes in full, then the summarised candidates. */
export function queryScenesBlock(input: BuildQueryPromptInput): string {
  const blocks = [QUERY_RULES]
  if (input.full.length > 0) {
    blocks.push(
      `Scenes (full text):\n${input.full
        .map((scene, index) => `[${index + 1}] ${scene.title}\n"""\n${scene.text}\n"""`)
        .join('\n\n')}`
    )
  }
  if (input.summaries.length > 0) {
    blocks.push(
      `Other scenes (summaries only):\n${input.summaries
        .map(
          (scene, index) =>
            `[${input.full.length + index + 1}] ${scene.title}\n${scene.summary}` +
            scene.keyPoints.map((point) => `\n- ${point}`).join('')
        )
        .join('\n\n')}`
    )
  }
  return blocks.join('\n\n')
}

export function buildQueryPrompt(input: BuildQueryPromptInput): BuiltQueryPrompt {
  return {
    version: QUERY_PROMPT_VERSION,
    messages: [
      { role: 'system', content: queryScenesBlock(input) },
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: input.question }
    ],
    maxTokens: outputBudget('query')
  }
}
