import {
  AGENT_MAX_EDITS,
  AGENT_RETRY_MAX_TOKENS,
  AGENT_STEP_MAX_TOKENS,
  AGENT_WORDS_MAX,
  AGENT_WORDS_MIN
} from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN, AGENT_RULES, type BuildAgentPromptInput } from './agent.v1'

/**
 * The chat agent prompt (F-5.22), version 2 (2026-10-07, after a draft written inside the JSON
 * reply hit the output cap and the chat showed the raw JSON): the model never writes prose into
 * a step. An insertion or a rewrite names what to write (`brief`) and how long (`words`); the app
 * drafts the prose afterwards through the voice-checked drafting path and streams it into the
 * editor. So a write run no longer carries the voice block (the drafting request does), and a
 * step stays small and fast. Everything else is version 1's: the read rules, the tools, the
 * message order. Prompt files are versioned (F-5.12); `agent.v1.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run, and for
 * every write run), then the open document, which changes with every message; then the history,
 * the message, and the steps so far.
 */
export const AGENT_PROMPT_V2_VERSION = 'agent.v2'

/** What a write run adds to the rules: the edits it may propose, prose left to the app. */
export const AGENT_EDIT_RULES_V2 =
  `To change the project, add "edits" (at most ${AGENT_MAX_EDITS}) to your reply; only when the ` +
  'message asks for a change or clearly invites one. The author approves each edit, or it is ' +
  'applied with an undo. "find", "after", and "at" are exact text copied from the document. ' +
  'Never write manuscript prose yourself: for new or rewritten prose give a "brief" (what to ' +
  'write, in a sentence or two: who, what happens, the beat) and the app drafts it in the ' +
  "author's voice. Edits:\n" +
  `- {"edit":"insert","id","after","brief","words"}: new prose after the paragraph holding ` +
  `"after" ("" for the author's caret in the open document); "words" is the length, ` +
  `${AGENT_WORDS_MIN}-${AGENT_WORDS_MAX}.\n` +
  '- {"edit":"text","id","find","brief"}: rewrite one passage as the brief says; ' +
  '{"edit":"text","id","find","replace":""} cuts it.\n' +
  '- {"edit":"synopsis","id","text"}\n' +
  '- {"edit":"notes","id","text"}: points added to the notes, one per line.\n' +
  '- {"edit":"sheet","name","field","text"}: one field of a sheet, as read_sheet names it.\n' +
  '- {"edit":"create","level":"scene" or "chapter","in","after","title"}: "in" is the ' +
  'parent\'s id, "after" the sibling to follow ("" for last).\n' +
  '- {"edit":"rename","id","title"}\n' +
  '- {"edit":"move","id","in","after"}: "after" is the sibling to follow ("" for first).\n' +
  '- {"edit":"split","id","at","title"}: the paragraph holding "at" and the rest become a new ' +
  'scene.\n' +
  '- {"edit":"merge","id","into"}: this document joins the end of "into" and is deleted.\n' +
  '- {"edit":"tag","id","tag","add"}: add or remove a tag.\n' +
  '- {"edit":"delete","id"}, {"edit":"delete","sheet"}, or {"edit":"delete","tag"}.\n' +
  'Keep "answer" to a few sentences.'

/**
 * The user turn of the one retry after a reply that was cut off or did not parse: the same
 * request again, with the reason, asking for a short reply.
 */
export const AGENT_RETRY_TURN =
  'Your last reply was cut off or was not one JSON object. Reply again with one short JSON ' +
  'object: a brief answer, no prose for the manuscript.'

export interface BuildAgentPromptV2Input extends BuildAgentPromptInput {
  /** True for the one retry of a step whose reply was cut off or did not parse. */
  retry?: boolean
}

export interface BuiltAgentPromptV2 {
  version: typeof AGENT_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored: a write run no longer carries the voice block (the drafting request does). */
export function buildAgentPromptV2(input: BuildAgentPromptV2Input): BuiltAgentPromptV2 {
  const system = [AGENT_RULES]
  if (input.access === 'write') system.push(AGENT_EDIT_RULES_V2)
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
  if (input.retry === true) messages.push({ role: 'user', content: AGENT_RETRY_TURN })

  return {
    version: AGENT_PROMPT_V2_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
