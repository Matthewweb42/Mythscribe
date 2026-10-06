import type { AiMessage } from '../providers/types'
import { renderScenePanel, type ScenePanel } from './chat.v5'
import { QUERY_RULES, queryScenesBlock } from './query.v1'
import { buildQueryPromptV3, type BuildQueryPromptV3Input } from './query.v3'

/**
 * The Story Intelligence prompt, version 4 (F-5.20): version 3 plus the author's side panel for
 * the open scene — its synopsis and the head of its notes, the same block `chat.v5` carries —
 * between the story bible and the retrieved scenes, with one sentence that keeps it out of the
 * citations: the panel is the author's plan for the scene, not what the manuscript says, so an
 * answer may be oriented by it but never rests on it. The rules, the sentinel, the citation and
 * sheet rules are version 3's unchanged, and with no panel the messages are version 3's exactly
 * (the golden test pins it). Prompt files are versioned (F-5.12); `query.v3.ts` stays as shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): rules, then the story bible, then the side panel,
 * then the retrieved scenes, all in the system turn; the history as real turns; the question last.
 */
export const QUERY_PROMPT_V4_VERSION = 'query.v4'

/** The sentence after the panel: it orients, it is not a source. */
export const QUERY_PANEL_RULE =
  "Use the side panel to understand the open scene; it is the author's plan, not the " +
  'manuscript, so never cite it or rest a claim on it.'

export interface BuildQueryPromptV4Input extends BuildQueryPromptV3Input {
  /** The open scene's side panel (`buildScenePanel`), or null with none open or nothing in it. */
  panel: ScenePanel | null
}

export interface BuiltQueryPromptV4 {
  version: typeof QUERY_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildQueryPromptV4(input: BuildQueryPromptV4Input): BuiltQueryPromptV4 {
  const base = buildQueryPromptV3(input)
  const panel = renderScenePanel(input.panel)
  // Version 3's system turn ends with version 1's scene blocks; the panel goes right before them.
  const scenes = queryScenesBlock(input).slice(QUERY_RULES.length)
  const messages = base.messages.map((message, index) => {
    if (index !== 0 || panel === null) return message
    const head = message.content.slice(0, message.content.length - scenes.length)
    return { ...message, content: `${head}\n\n${panel}\n${QUERY_PANEL_RULE}${scenes}` }
  })
  return { version: QUERY_PROMPT_V4_VERSION, messages, maxTokens: base.maxTokens }
}
