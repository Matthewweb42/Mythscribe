import { outputBudget } from '@shared/ai'
import { CHAT_TOKENS_PER_PARAGRAPH, type ChatMode } from '@shared/chat'
import type { PresetParams } from '@shared/presets'
import type { SceneMeta } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'
import type { ChatTurn } from './chat.v1'

/**
 * The assistant prompt (F-5.4), version 3, for both modes: version 2 (the scene brief in Agent
 * mode, F-14.3) plus the story bible (F-14.9) in the system turn between the rules and the
 * context, in both modes — Plan mode answers about the manuscript need the same ground truth
 * (PLAN.md §2.3). Nothing else moved. Prompt files are versioned (F-5.12): a change to the
 * text, the caps, or the message order is a new file with its own golden test, never an edit
 * to a shipped one; `chat.v2.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn opens with the mode's rules,
 * then, in Agent mode, the voice profile block (F-14.1) and the preset's style instruction and
 * new-elements rule (F-5.2); then the story bible (F-14.9); then the task-specific context,
 * cheapest first: the referenced notes, the scene metadata and brief (Agent mode), the scene's
 * text. The context sits at the end of the system turn so the stable part in front of it
 * caches at the provider, and so a multi-turn conversation about one scene reuses the whole
 * system turn. The history turns follow as real user/assistant messages, the author's message
 * last.
 */
export const CHAT_PROMPT_V3_VERSION = 'chat.v3'

const PLAN_RULES =
  'You are the assistant inside a novel-writing app, talking with the author about their ' +
  'manuscript. Answer the question or request in plain prose, briefly. When the active scene ' +
  'below grounds your answer, quote or point to the passage you rely on; when it does not, ' +
  'say so instead of guessing. Do not write manuscript prose unless asked.'

const AGENT_RULES =
  'You are drafting inside a novel-writing app. Write exactly the number of paragraphs asked ' +
  "for, continuing the active scene at the author's cursor, in the same voice, tense, and " +
  'person as the scene, following the instruction. Reply with the prose only: no headings, no ' +
  'notes, no preamble, and no quotation marks around the answer. Separate paragraphs with a ' +
  'blank line.'

const NEW_ELEMENTS_RULE =
  'Do not introduce any new named character, place, or plot fact that the scene or the ' +
  'context below does not already establish.'

export interface BuildChatPromptV3Input {
  mode: ChatMode
  /** Agent mode: how many paragraphs to write (`CHAT_PARAGRAPHS_MIN`–`MAX`); ignored in Plan mode. */
  paragraphs: number
  /** The active scene's plain text, already head-truncated; '' when no scene is open. */
  sceneText: string
  /** The scene's metadata when any field is set; folded in only in Agent mode. */
  sceneMeta: SceneMeta | null
  /** The scene brief block (F-14.3, `sceneBriefBlock`), Agent mode only; null when there is none. */
  brief: string | null
  /** The `#name` references that resolved, each with its linked notes. */
  refs: { name: string; notes: string }[]
  /** The recent turns, oldest first. */
  history: ChatTurn[]
  message: string
  /** The voice profile block (F-14.1), Agent mode only; null for a project with neither rules nor exemplars. */
  voice: string | null
  /**
   * The story bible block (F-14.9, `renderStoryBible` within `STORY_BIBLE_TOKEN_BUDGET`), or
   * null when the project states no story facts yet. Sent in both modes.
   */
  bible: string | null
  /** The active writing preset (F-5.2), Agent mode only. */
  preset: PresetParams | null
}

export interface BuiltChatPromptV3 {
  version: typeof CHAT_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
  /** The preset's in Agent mode; undefined (the provider's default) in Plan mode. */
  temperature: number | undefined
}

export function buildChatPromptV3(input: BuildChatPromptV3Input): BuiltChatPromptV3 {
  const agent = input.mode === 'agent'
  const rules: string[] = [agent ? AGENT_RULES : PLAN_RULES]
  if (agent) {
    if (input.voice) rules.push(input.voice)
    if (input.preset) {
      rules.push(input.preset.styleInstruction)
      if (!input.preset.allowNewElements) rules.push(NEW_ELEMENTS_RULE)
    }
  }
  const bible = input.bible ? `\n\n${input.bible}` : ''

  const context: string[] = []
  if (input.refs.length) {
    context.push(
      `Referenced notes:\n${input.refs.map((ref) => `#${ref.name}:\n${ref.notes}`).join('\n\n')}`
    )
  }
  if (agent && input.sceneMeta) {
    const meta = input.sceneMeta
    context.push(
      `Scene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, timeline ${meta.timeline || '—'}.`
    )
  }
  if (agent && input.brief) context.push(input.brief)
  context.push(
    input.sceneText
      ? `Active scene:\n"""\n${input.sceneText}\n"""`
      : 'No scene is open; the author is working outside the manuscript.'
  )

  const system = `${rules.join(' ')}${bible}\n\n${context.join('\n\n')}`
  const paragraphs = agent
    ? `Write ${input.paragraphs} paragraph${input.paragraphs === 1 ? '' : 's'}. `
    : ''
  const messages: AiMessage[] = [
    { role: 'system', content: system },
    ...input.history.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: `${paragraphs}${input.message}` }
  ]

  return {
    version: CHAT_PROMPT_V3_VERSION,
    messages,
    maxTokens: agent
      ? Math.min(input.paragraphs * CHAT_TOKENS_PER_PARAGRAPH, outputBudget('chat'))
      : outputBudget('chat'),
    temperature: agent && input.preset ? input.preset.temperature : undefined
  }
}
