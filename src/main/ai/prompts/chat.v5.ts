import type { AiMessage } from '../providers/types'
import { buildChatPromptV4, type BuildChatPromptV4Input } from './chat.v4'

/**
 * The assistant prompt (F-5.4), version 5: version 4 plus the author's side panel for the
 * active scene (F-5.20): its synopsis and the head of its notes, as one labelled block in the
 * context right before the active scene, in both modes, so the assistant sees what the author
 * has planned for the scene and can talk about it. Everything else is version 4's: with no
 * panel the messages are version 4's exactly (the golden test pins it). Prompt files are
 * versioned (F-5.12): a change to the text, the caps, or the message order is a new file with
 * its own golden test, never an edit to a shipped one; `chat.v4.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): unchanged from version 4. The panel is
 * task-specific context, so it sits in the context at the end of the system turn, after the
 * referenced notes, the metadata, the brief, and the steer, and before the scene's text.
 */
export const CHAT_PROMPT_V5_VERSION = 'chat.v5'

/** The block's heading; shared with `query.v4`, which carries the same block. */
export const SCENE_PANEL_HEADING = "The author's side panel for this scene (their own plan):"

/** The open scene's side panel as the prompt carries it; both parts already cut to their caps. */
export interface ScenePanel {
  /** The synopsis, '' when the author has none. */
  synopsis: string
  /** The head of the notes as plain text, '' when there are none. */
  notes: string
}

/** The side-panel block, or null when the panel is empty. Shared with `query.v4`. */
export function renderScenePanel(panel: ScenePanel | null): string | null {
  if (panel === null) return null
  const lines: string[] = []
  if (panel.synopsis) lines.push(`Synopsis: ${panel.synopsis}`)
  if (panel.notes) lines.push(`Notes:\n"""\n${panel.notes}\n"""`)
  return lines.length ? `${SCENE_PANEL_HEADING}\n${lines.join('\n')}` : null
}

export interface BuildChatPromptV5Input extends BuildChatPromptV4Input {
  /** The active scene's side panel (`buildScenePanel`), or null with none open or nothing in it. */
  panel: ScenePanel | null
}

export interface BuiltChatPromptV5 {
  version: typeof CHAT_PROMPT_V5_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number | undefined
}

/** Version 4's closing context line: the active scene, or the sentence that says none is open. */
function sceneLine(sceneText: string): string {
  return sceneText
    ? `Active scene:\n"""\n${sceneText}\n"""`
    : 'No scene is open; the author is working outside the manuscript.'
}

export function buildChatPromptV5(input: BuildChatPromptV5Input): BuiltChatPromptV5 {
  const base = buildChatPromptV4(input)
  const panel = renderScenePanel(input.panel)
  const tail = sceneLine(input.sceneText)
  const messages = base.messages.map((message, index) => {
    if (index !== 0 || panel === null || !message.content.endsWith(tail)) return message
    const head = message.content.slice(0, message.content.length - tail.length)
    return { ...message, content: `${head}${panel}\n\n${tail}` }
  })
  return {
    version: CHAT_PROMPT_V5_VERSION,
    messages,
    maxTokens: base.maxTokens,
    temperature: base.temperature
  }
}
