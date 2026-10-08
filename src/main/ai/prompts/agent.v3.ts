import { AGENT_RETRY_MAX_TOKENS, AGENT_STEP_MAX_TOKENS } from '@shared/agent'
import type { AiMessage } from '../providers/types'
import { AGENT_FINAL_TURN, AGENT_RULES } from './agent.v1'
import { AGENT_EDIT_RULES_V2, AGENT_RETRY_TURN, type BuildAgentPromptV2Input } from './agent.v2'

/**
 * The chat agent prompt (F-5.22), version 3 (F-5.23 story time, 2026-10-08, after the chat told
 * the author something had happened that only their worldbuilding notes planned): the rules gain
 * one paragraph on story time, and the system turn carries the story map (`renderStoryMap`: the
 * manuscript in reading order, each scene planned / drafted / revised, one-line summaries, and
 * "▶ NOW" on the scene the author is at). The lookups say where each source sits (before now,
 * now, after now, or the author's notes and plans; `agentTools.ts`). Everything else is version
 * 2's: the tools, the edit rules, the retry. Prompt files are versioned (F-5.12); `agent.v2.ts`
 * stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules (identical for every read run, and for
 * every write run), then the map, which changes when the author moves to another scene or a
 * summary is rewritten, then the open document, which changes with every message; then the
 * history, the message, and the steps so far.
 */
export const AGENT_PROMPT_V3_VERSION = 'agent.v3'

/** The story-time rule (F-5.23): what has happened is what the manuscript shows up to now. */
export const AGENT_TIME_RULES =
  'Story time: the story map marks the scene the author is at with "▶ NOW". An event has ' +
  'happened only if the manuscript shows it in a scene at or before NOW; scenes after NOW are ' +
  "later in the book. Sheets, notes, synopses, briefs, beats, and planned scenes are the author's " +
  'notes and plans: trust them for who people are and what places are like, but an event found ' +
  'only there has not happened yet, so say so ("your notes plan that…") instead of stating it as ' +
  'fact. Answer as of NOW unless the message asks about the whole book, the ending, or later.'

export interface BuildAgentPromptV3Input extends BuildAgentPromptV2Input {
  /** The story map block (`buildStoryMap` within `STORY_MAP_TOKEN_BUDGET`), or null with no manuscript document. */
  map: string | null
}

export interface BuiltAgentPromptV3 {
  version: typeof AGENT_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** `voice` is ignored, as in version 2: the drafting request carries the voice block. */
export function buildAgentPromptV3(input: BuildAgentPromptV3Input): BuiltAgentPromptV3 {
  const system = [AGENT_RULES, AGENT_TIME_RULES]
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
    version: AGENT_PROMPT_V3_VERSION,
    messages,
    maxTokens: input.retry === true ? AGENT_RETRY_MAX_TOKENS : AGENT_STEP_MAX_TOKENS
  }
}
