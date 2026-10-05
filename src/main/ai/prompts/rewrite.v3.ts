import { estimateTokens, outputBudget } from '@shared/ai'
import type { PromptSceneMeta } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'
import { REWRITE_RULES } from './rewrite.v1'

/**
 * The rewrite-in-my-voice prompt (F-14.10), version 3: version 2 (the story bible, F-14.9) plus
 * the scene steer (F-14.13): the scene's Tone, Content, Plot threads, and theme tags as a
 * labelled block with one instruction sentence (`renderSceneSteer`), first in the user turn,
 * before the text each side of the passage, so the rewrite keeps the scene's tone. The rules
 * are version 1's, imported unchanged — the opening sentence is the sentinel the e2e's fake
 * OpenAI keys on. Nothing else moved: with no steer this is version 2's messages exactly.
 * Prompt files are versioned (F-5.12): a change to the text, the caps, or the message order is
 * a new file with its own golden test, never an edit to a shipped one; `rewrite.v2.ts` stays
 * exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules,
 * then the voice profile block (F-14.1), then the story bible (F-14.9), then the scene's
 * metadata line, all of which hold still while the author rewrites one passage after another
 * in the same scene. The user turn carries the task-specific context: the scene steer, the
 * manuscript text each side of the selection (so the rewrite keeps its seams), the passage
 * itself, and the one-line instruction. No preset (the rewrite is about the author's voice,
 * not the preset's style) and no temperature (the provider's default).
 */
export const REWRITE_PROMPT_V3_VERSION = 'rewrite.v3'

/** A rewrite may run half again as long as the passage, plus a little slack for a longer close. */
const LENGTH_FACTOR = 1.5
const LENGTH_SLACK_TOKENS = 40

export interface BuildRewritePromptV3Input {
  /** The selected passage as plain text, `REWRITE_TEXT_MIN`–`REWRITE_TEXT_MAX` characters. */
  text: string
  /** Up to `REWRITE_CONTEXT_CHARS` of manuscript text immediately before the selection; '' at the start. */
  before: string
  /** Up to `REWRITE_CONTEXT_CHARS` of manuscript text immediately after the selection; '' at the end. */
  after: string
  /** The scene's metadata when any field is set, else null. */
  meta: PromptSceneMeta | null
  /**
   * The voice profile block (F-14.1, `voiceBlock`), or null when the project has neither rules
   * nor exemplars yet (then the fidelity check is skipped too).
   */
  voice: string | null
  /**
   * The story bible block (F-14.9, `renderStoryBible` within `STORY_BIBLE_TOKEN_BUDGET`), or
   * null when the project states no story facts yet.
   */
  bible: string | null
  /**
   * The scene steer block (F-14.13, `buildSceneSteer`), or null when the scene has no tag in a
   * steer category. User-side, first.
   */
  steer: string | null
}

export interface BuiltRewritePromptV3 {
  version: typeof REWRITE_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildRewritePromptV3(input: BuildRewritePromptV3Input): BuiltRewritePromptV3 {
  const rules = [REWRITE_RULES]
  if (input.voice) rules.push(input.voice)
  const bible = input.bible ? `\n\n${input.bible}` : ''
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  const parts: string[] = []
  if (input.steer) parts.push(input.steer)
  if (input.before) parts.push(`Text before:\n"""\n${input.before}\n"""`)
  if (input.after) parts.push(`Text after:\n"""\n${input.after}\n"""`)
  parts.push(`Passage to rewrite:\n"""\n${input.text}\n"""`)
  parts.push('Rewrite the passage.')

  return {
    version: REWRITE_PROMPT_V3_VERSION,
    messages: [
      { role: 'system', content: `${rules.join(' ')}${bible}${scene}` },
      { role: 'user', content: parts.join('\n\n') }
    ],
    maxTokens: Math.min(
      Math.ceil(estimateTokens(input.text) * LENGTH_FACTOR) + LENGTH_SLACK_TOKENS,
      outputBudget('rewrite')
    )
  }
}
