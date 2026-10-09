import {
  AGENT_MAX_STEPS,
  AGENT_READ_CHARS,
  AGENT_RETRY_MAX_TOKENS,
  AGENT_STEP_MAX_TOKENS
} from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import type { BuildAgentPromptV3Input } from './agent.v3'
import { AGENT_ORGANISE_RULES } from './agent.v4'

/**
 * The chat agent prompt (F-5.22), version 6 (F-5.24, the lookup ladder, 2026-10-09): the tools
 * become a ladder over the local knowledge model, cheapest first. `lookup` answers a named
 * record as of now in about 300 tokens (its sheet with what the scenes state, relations, threads,
 * where it is named, the last scene it was in); `cards` answers which scenes, about 100 tokens a
 * scene; `find_passages` answers exact wording from the local passage index; `read_scene` (now
 * also from a paragraph) comes last. `search` and `read_summary` are gone from this version
 * (`AGENT_TOOLS_V6`). Version 3's "sheets and notes are plans" gives way to status labels: every
 * record, note, and stated value is marked canon, plan, or idea, and the answer labels plan and
 * idea material. The organise rule (v4) and the To do tool (v5) are kept; the To do tool joins
 * the tool list. Prompt files are versioned (F-5.12); `agent.v5.ts` stays as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run and every
 * write run), then the map, the open document, the history, the message, the steps so far.
 */
export const AGENT_PROMPT_V6_VERSION = 'agent.v6'

/** The rules and the tools; the opening sentence is version 1's, which the e2e's fake keys on. */
export const AGENT_RULES_V6 =
  "You are the assistant inside a novel-writing app, working for the book's author. Before you " +
  "reply you may look things up in the author's project with tools; look up only what the " +
  'message needs, mostly about the open document.\n' +
  'Reply with one JSON object and nothing else: a tool call, ' +
  '{"tool":"lookup","args":{"name":"Mara"}}, or your reply, ' +
  '{"answer":"...","found":true,"citations":[{"id":"n3","quote":"..."}]}.\n' +
  'Tools (documents are named by ids like n3, paragraphs by ¶ numbers):\n' +
  '- lookup {"name"}: a character, place, thing, or thread as of now: sheet, what the scenes ' +
  'state, relations, threads, where it is named.\n' +
  '- cards {"ids"} or {"name"}: scene cards (who, where, when, POV, what changed) for scene ' +
  'ids or for the scenes naming a record.\n' +
  '- find_passages {"query"}: the paragraphs whose words match best, as id ¶n and a snippet.\n' +
  '- outline {}: every part, chapter, and scene with its id and word count.\n' +
  '- read_scene {"id","para"} or {"id","from"}: a document from paragraph "para", or ' +
  `${AGENT_READ_CHARS.toLocaleString('en-US')} characters from character "from" (default 0).\n` +
  '- read_notes {"id"}: a document\'s synopsis and notes.\n' +
  '- read_sheet {"name"}: a whole story-bible sheet.\n' +
  '- list_sheets {"kind"}: sheet names; kind is character, setting, world, or "" for all.\n' +
  '- tags {}: the tag names by category.\n' +
  '- todo {"kind"}: the open To do list (undefined names, contradictions, loose ends, gaps); ' +
  'kind is undefined, contradiction, looseEnd, gap, or "" for all.\n' +
  `At most ${AGENT_MAX_STEPS} tool calls, then reply. Ground what you say about the book in text ` +
  'you read: cite a passage as {"id","quote"} with the quote copied exactly, or a sheet you read ' +
  'as {"sheet":"name"}, and mark each in the answer as [1], [2] in citation order. If the ' +
  'project does not answer the question, say so and set "found" to false. The answer is plain ' +
  'prose for the author.'

/** The ladder (F-5.24): cheapest lookup first, and stop once the answer is supported. */
export const AGENT_LADDER_RULES =
  'Look up cheapest first and stop once the answer is supported: a named person, place, thing, ' +
  'or thread → lookup; which scenes → cards; exact wording or a quote → find_passages; ' +
  "read_scene last. A snippet's words between … cuts are quotable. For what is left to figure " +
  'out or loose ends, call todo and report the items as listed; never resolve one or fill a gap ' +
  'with your own idea.'

/**
 * Story time with status labels (F-5.23, F-5.24): replaces version 3's "sheets and notes are the
 * author's plans" with the canon / plan / idea marks the tools put on every source (D7).
 */
export const AGENT_STATUS_RULES =
  'Story time: the story map marks the scene the author is at with "▶ NOW". An event has ' +
  'happened only if the manuscript shows it in a scene at or before NOW; scenes after NOW are ' +
  'later in the book. Sources are marked [canon] (the story as written), [plan] (the ' +
  "author's intent, not on the page yet), or [idea] (a maybe). Sheets tell who people are and " +
  'what places are like, but an event found only in a sheet, notes, a synopsis, or a planned ' +
  'scene has not happened yet. Label plan and idea material in the answer ("your notes plan…", ' +
  '"one idea is…"); never state it as fact. Answer as of NOW unless the message asks about the ' +
  'whole book, the ending, or later.'

export interface BuiltAgentPromptV6 {
  version: typeof AGENT_PROMPT_V6_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored, as in versions 2 to 5: the drafting request carries the voice block. */
export function buildAgentPromptV6(input: BuildAgentPromptV3Input): BuiltAgentPromptV6 {
  const system = [AGENT_RULES_V6, AGENT_STATUS_RULES, AGENT_LADDER_RULES, AGENT_ORGANISE_RULES]
  if (input.access === 'write') system.push(AGENT_EDIT_RULES_V2)
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
    version: AGENT_PROMPT_V6_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
