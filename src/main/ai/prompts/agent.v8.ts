import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN } from './agent.v1'
import { AGENT_RETRY_TURN } from './agent.v2'
import type { BuildAgentPromptV3Input } from './agent.v3'
import { AGENT_LADDER_RULES, AGENT_STATUS_RULES } from './agent.v6'
import {
  AGENT_BULK_RULES,
  AGENT_EDIT_RULES_V7,
  AGENT_ORGANISE_RULES_V7,
  AGENT_RULES_V7
} from './agent.v7'

/**
 * The chat agent prompt (F-5.22), version 8 (F-5.25, the audit's fixes 5, 7, and 8, built at the
 * author's word of 2026-10-10). Only the edit list changes, so a read run (Plan) sends version 7's
 * rules byte for byte: `"text":""` on a notes edit empties a document's notes; `status` marks a
 * record, what the scenes state of a field, or a document's notes canon, plan, or idea; `todo`
 * settles To do items by the refs the `todo` tool now prints; `undo`, `summaries`, and `open` are
 * the answer actions (undo the last turn, re-read stale summaries, open the upload or the
 * Library). Prompt files are versioned (F-5.12); `agent.v7.ts` stays as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run and every
 * write run), then the map, the open document, the history, the message, the steps so far.
 */
export const AGENT_PROMPT_V8_VERSION = 'agent.v8'

const NOTES_EDIT_V2 = '- {"edit":"notes","id","text"}: points added to the notes, one per line.\n'

const LAST_EDIT_LINE = 'Keep "answer" to a few sentences.'

/** The edits version 8 adds (F-5.25): statuses, To do items, and the answer actions. */
export const AGENT_EDITS_V8 =
  '- {"edit":"status","name","field","value","status"}: mark a record (no field), or what the ' +
  'scenes state of a field (value narrows), canon, plan, or idea; "id" for "name": a ' +
  "document's notes.\n" +
  '- {"edit":"todo","ids","done"}: settle To do items (t1…) the author calls handled; ' +
  '"done":false dismisses.\n' +
  '- {"edit":"undo"} the last turn; {"edit":"summaries"} re-summarise stale scenes; ' +
  '{"edit":"open","dialog":"upload" or "library"}\n'

/** What a write run adds to the rules: version 7's edits, notes clearing, and the version 8 edits. */
export const AGENT_EDIT_RULES_V8 = AGENT_EDIT_RULES_V7.replace(
  NOTES_EDIT_V2,
  '- {"edit":"notes","id","text"}: points added to the notes, one per line; "text":"" clears ' +
    'them.\n'
).replace(LAST_EDIT_LINE, `${AGENT_EDITS_V8}${LAST_EDIT_LINE}`)

export interface BuiltAgentPromptV8 {
  version: typeof AGENT_PROMPT_V8_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored, as in versions 2 to 7: the drafting request carries the voice block. */
export function buildAgentPromptV8(input: BuildAgentPromptV3Input): BuiltAgentPromptV8 {
  const system = [
    AGENT_RULES_V7,
    AGENT_STATUS_RULES,
    AGENT_LADDER_RULES,
    AGENT_BULK_RULES,
    AGENT_ORGANISE_RULES_V7
  ]
  if (input.access === 'write') system.push(AGENT_EDIT_RULES_V8)
  if (input.map) system.push(input.map)
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
    version: AGENT_PROMPT_V8_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
