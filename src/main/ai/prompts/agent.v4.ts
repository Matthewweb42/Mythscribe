import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN, AGENT_RULES } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN } from './agent.v2'
import { AGENT_TIME_RULES, type BuildAgentPromptV3Input } from './agent.v3'

/**
 * The chat agent prompt (F-5.22), version 4 (F-9.10 Organise, 2026-10-08: "you should be able to
 * from the chat bot just organize it all"): version 3 plus one paragraph that lets the answer ask
 * the app to organise the project, in every chat mode. The app then runs Organise with the
 * request, which plans the changes (prompt `organise.v1`) and lands them by the chat mode: Ask
 * lists them for the author's ticks, Auto applies them with Undo, Plan only describes. Everything
 * else is version 3's. Prompt files are versioned (F-5.12); `agent.v3.ts` stays as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run and every
 * write run), then the map, the open document, the history, the message, the steps so far.
 */
export const AGENT_PROMPT_V4_VERSION = 'agent.v4'

/** What every run adds to the rules: the organise request the answer may carry. */
export const AGENT_ORGANISE_RULES =
  'Organising: when the message asks to organise, clean up, merge duplicates in, or ' +
  'streamline the tags, story-bible sheets, notes, or binder, add "organise":{"scope":[…],' +
  '"instruction":"…"} to your answer instead of edits: scope is any of tags, sheets, notes, ' +
  'binder ([] for all); instruction is what the author asked, in a sentence. The app plans the ' +
  'changes and shows them; say so in the answer in a sentence. Organising never changes the ' +
  'manuscript text.'

export interface BuiltAgentPromptV4 {
  version: typeof AGENT_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored, as in versions 2 and 3: the drafting request carries the voice block. */
export function buildAgentPromptV4(input: BuildAgentPromptV3Input): BuiltAgentPromptV4 {
  const system = [AGENT_RULES, AGENT_TIME_RULES, AGENT_ORGANISE_RULES]
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
    version: AGENT_PROMPT_V4_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
