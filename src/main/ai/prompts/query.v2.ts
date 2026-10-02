import { outputBudget } from '@shared/ai'
import type { AiMessage } from '../providers/types'
import { QUERY_RULES, queryScenesBlock, type BuildQueryPromptInput } from './query.v1'

/**
 * The Story Intelligence prompt, version 2 (F-5.16): version 1 plus a story-bible block — the
 * author's entity sheets and the observed facts the manuscript states, each fact with the
 * scene it was read from — for the entities the question names. The rules are version 1's,
 * imported unchanged (the opening sentence is the sentinel the e2e's fake OpenAI keys on), and
 * so are the citation rules: an answer still rests on the scenes sent in full, and the bible
 * only orients, which its own heading says. With no bible the messages are version 1's
 * exactly; the golden test pins that.
 *
 * Order (CLAUDE.md, token efficiency rule 3): rules, then the story bible, then the retrieved
 * scenes, all in the system turn; the history as real turns; the question last.
 */
export const QUERY_PROMPT_V2_VERSION = 'query.v2'

/**
 * The block's opening line. It carries the block's one rule, so a request without a bible
 * spends nothing on it: the sheets are the author's word, the facts point at scenes, and
 * neither is a citation.
 */
export const QUERY_BIBLE_HEADING =
  "Story bible (the author's own sheets, then what the manuscript states with the scene it " +
  'was read from; use it to orient yourself, never as a citation, and where a sheet and a ' +
  'scene disagree, say so):'

export interface BuildQueryPromptV2Input extends BuildQueryPromptInput {
  /** The entity lines for the entities the question names, already fitted to their budget; null for none. */
  bible: string | null
}

export interface BuiltQueryPromptV2 {
  version: typeof QUERY_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The system turn: version 1's, with the story bible between the rules and the scenes. */
function querySystemV2(input: BuildQueryPromptV2Input): string {
  const v1 = queryScenesBlock(input)
  if (input.bible === null) return v1
  return `${QUERY_RULES}\n\n${QUERY_BIBLE_HEADING}\n${input.bible}` + v1.slice(QUERY_RULES.length)
}

export function buildQueryPromptV2(input: BuildQueryPromptV2Input): BuiltQueryPromptV2 {
  return {
    version: QUERY_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: querySystemV2(input) },
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: input.question }
    ],
    maxTokens: outputBudget('query')
  }
}
