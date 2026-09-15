import { outputBudget } from '@shared/ai'
import type { SceneMeta } from '@shared/sceneMeta'
import { SUMMARY_BANK_NAMES_MAX, SUMMARY_KEY_POINTS_MAX } from '@shared/summary'
import type { AiMessage } from '../providers/types'

/**
 * The scene-summary prompt (F-5.6), version 1: one scene read back as the index every other
 * Story Intelligence feature stands on — what happens, the key points, and who is present —
 * answered as JSON on the fast tier. Prompt files are versioned (F-5.12): a change to the
 * text, the caps, or the message order is a new file (`summary.v2.ts`) with its own golden
 * test, never an edit here, so every stored row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the
 * rules, the project's character names, and the scene's metadata line, as `brief.v1` orders
 * them — and the user turn carries the scene text and the one-line instruction. No voice
 * block: a summary is index data, not prose, and every token here is spent in the background
 * on the author's behalf.
 */
export const SUMMARY_PROMPT_VERSION = 'summary.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a summary request by it, so it must not change within this version.
 */
export const SUMMARY_RULES =
  'You are the scene-summary feature inside a novel-writing app. Summarize the scene below ' +
  "for the author's index: at most 80 words, in plain past tense, stating what happens. Do " +
  'not evaluate the writing, do not give advice, and do not invent anything the scene does ' +
  `not show. Then give up to ${SUMMARY_KEY_POINTS_MAX} key points, one clause each, and the ` +
  'characters present, by name, preferring the spellings in the character list when one is ' +
  'given. Reply with JSON only: {"summary":"...","keyPoints":["..."],"characters":["..."]}.'

export interface BuildSummaryPromptInput {
  /** The scene as plain text, head-truncated to `SUMMARY_SCENE_CHAR_BUDGET` by the caller. */
  sceneText: string
  /** The scene's metadata when any field is set, else null. */
  meta: SceneMeta | null
  /** The bank's character names, so the model spells the cast the author's way; cut to the cap here. */
  characters: string[]
}

export interface BuiltSummaryPrompt {
  version: typeof SUMMARY_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildSummaryPrompt(input: BuildSummaryPromptInput): BuiltSummaryPrompt {
  const names = input.characters.slice(0, SUMMARY_BANK_NAMES_MAX)
  const cast = names.length ? `\n\nCharacters in the story bible: ${names.join(', ')}.` : ''
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  return {
    version: SUMMARY_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${SUMMARY_RULES}${cast}${scene}` },
      { role: 'user', content: `Scene text:\n"""\n${input.sceneText}\n"""\n\nSummarize the scene.` }
    ],
    maxTokens: outputBudget('summary')
  }
}
