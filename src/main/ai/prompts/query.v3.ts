import { outputBudget } from '@shared/ai'
import { QUERY_MAX_CITATIONS, QUERY_QUOTE_MAX } from '@shared/query'
import type { AiMessage } from '../providers/types'
import { QUERY_RULES, queryScenesBlock, type BuildQueryPromptInput } from './query.v1'

/**
 * The Story Intelligence prompt, version 3: the author's own sheets become a source. In version
 * 2 the story bible only oriented the answer, so a question whose answer lives on a character or
 * world sheet ("what colour are Mara's eyes?") came back "not found" or uncited. Here the sheets
 * are the author's word and may be relied on, named in a `sheets` list that main checks against
 * the sheets it sent; observed facts still only point at scenes and are never a source. Scene
 * citations are version 1's, unchanged.
 *
 * The opening sentence is version 1's (the e2e's fake OpenAI keys on it). The block's budget and
 * value cap grow (`QUERY_V3_BIBLE_TOKEN_BUDGET`, `QUERY_V3_BIBLE_VALUE_MAX`) so a filled sheet
 * fits whole, and the caller adds the sheets of the entities tagged on the top scenes when the
 * question names none.
 *
 * Order (CLAUDE.md, token efficiency rule 3): rules, then the story bible, then the retrieved
 * scenes, all in the system turn; the history as real turns; the question last.
 */
export const QUERY_PROMPT_V3_VERSION = 'query.v3'

export const QUERY_RULES_V3 =
  'You are the Story Intelligence feature inside a novel-writing app. Answer the question ' +
  "about the manuscript using only the author's sheets and the scenes below. Reply with JSON " +
  'only: {"found":true,"answer":"...","citations":[{"scene":1,"quote":"..."}],"sheets":["Name"]}. ' +
  'Write the number of a scene in square brackets like [2] after every claim that scene ' +
  'supports, and give the exact passage you relied on as that citation quote, copied word for ' +
  `word from a scene given in full, at most ${QUERY_QUOTE_MAX} characters; a citation whose ` +
  `quote is not in the scene it names is thrown away. Give at most ${QUERY_MAX_CITATIONS} ` +
  "citations. The author's sheets are true for this story: when a claim rests on one, put that " +
  'entity\'s name, exactly as the sheet line starts, in "sheets". What a sheet line lists as ' +
  'seen in the manuscript, and the scenes listed as summaries only, are there to orient you and ' +
  'are not sources. Where a sheet and a scene disagree, say so. When neither answers the ' +
  'question, set "found" to false, say briefly what is there and what is not, and give no ' +
  'citations or sheets. Never use knowledge from outside the sheets and scenes, and never ' +
  'invent a passage. Keep the answer under 150 words.'

/** The block's opening line: the sheets lead each entity line, the observed facts follow. */
export const QUERY_BIBLE_HEADING_V3 = "The author's sheets (story bible):"

export interface BuildQueryPromptV3Input extends BuildQueryPromptInput {
  /** The entity lines, already fitted to their budget; null for none. */
  bible: string | null
}

export interface BuiltQueryPromptV3 {
  version: typeof QUERY_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The system turn: the v3 rules, the story bible when there is one, then version 1's scenes. */
function querySystemV3(input: BuildQueryPromptV3Input): string {
  // Version 1's block opens with its own rules; everything after them (the scenes) is reused.
  const afterRules = queryScenesBlock(input).slice(QUERY_RULES.length)
  const bible = input.bible === null ? '' : `\n\n${QUERY_BIBLE_HEADING_V3}\n${input.bible}`
  return `${QUERY_RULES_V3}${bible}${afterRules}`
}

export function buildQueryPromptV3(input: BuildQueryPromptV3Input): BuiltQueryPromptV3 {
  return {
    version: QUERY_PROMPT_V3_VERSION,
    messages: [
      { role: 'system', content: querySystemV3(input) },
      ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: 'user', content: input.question }
    ],
    maxTokens: outputBudget('query')
  }
}
