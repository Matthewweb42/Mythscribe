import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN, AGENT_RULES } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_TIME_RULES, type BuildAgentPromptV3Input } from './agent.v3'
import { AGENT_ORGANISE_RULES } from './agent.v4'

/**
 * The chat agent prompt (F-5.22), version 5 (F-9.16 To do list, 2026-10-09: the chat can answer
 * "what's left to figure out?"): version 4 plus one paragraph naming the `todo` tool, which reads
 * the open To do list (undefined names, contradictions, loose ends, gaps). The agent reports the
 * items; it never resolves one or fills a gap with its own idea ("no assuming", 2026-10-08).
 * Everything else is version 4's. Prompt files are versioned (F-5.12); `agent.v4.ts` stays as it
 * shipped. The lookup ladder planned as `agent.v5` (F-5.24) becomes `agent.v6`.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run and every
 * write run), then the map, the open document, the history, the message, the steps so far.
 */
export const AGENT_PROMPT_V5_VERSION = 'agent.v5'

/** What every run adds to the rules: the To do tool and how to use it. */
export const AGENT_TODO_RULES =
  'One more tool:\n' +
  '- todo {"kind"}: the open To do list (undefined names, contradictions, loose ends, gaps); ' +
  'kind is undefined, contradiction, looseEnd, gap, or "" for all.\n' +
  'For what is left to figure out, open questions, or loose ends, call todo; report the items ' +
  'as the list states them, never resolve one or fill a gap with your own idea.'

export interface BuiltAgentPromptV5 {
  version: typeof AGENT_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored, as in versions 2 to 4: the drafting request carries the voice block. */
export function buildAgentPromptV5(input: BuildAgentPromptV3Input): BuiltAgentPromptV5 {
  const system = [AGENT_RULES, AGENT_TIME_RULES, AGENT_ORGANISE_RULES, AGENT_TODO_RULES]
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
    version: AGENT_PROMPT_V5_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
