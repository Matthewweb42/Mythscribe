import { outputBudget } from '@shared/ai'
import { SCENE_BRIEF_FIELD_MAX, type SceneMeta } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'

/**
 * The scene-brief drafting prompt (F-14.3), version 1: one scene read back to the author as
 * five lines of intent ("here is what I think this scene is doing; correct me"), answered as
 * JSON. Prompt files are versioned (F-5.12): a change to the text, the caps, or the message
 * order is a new file (`brief.v2.ts`) with its own golden test, never an edit here, so every
 * ledger row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules
 * and the scene's metadata line, as `rewrite.v1` orders them — and the user turn carries the
 * scene text and the one-line instruction. No voice block: the brief is a statement of intent,
 * not prose, so the author's voice has no lever on it (and every token here is one the author
 * did not ask for).
 */
export const BRIEF_PROMPT_VERSION = 'brief.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a brief request by it, so it must not change within this version.
 */
export const BRIEF_RULES =
  'You are the scene-brief feature inside a novel-writing app. Read the scene below and say ' +
  'what it is doing, so the author can correct you: goal (what the point-of-view character ' +
  'wants here), conflict (what stands in the way), turn (how the scene ends differently from ' +
  'how it began), beat (the emotional beat it lands on), after (what the reader knows at the ' +
  `end that they did not before). One plain sentence each, at most ${SCENE_BRIEF_FIELD_MAX} ` +
  'characters, in your own words: do not quote the scene, do not summarise it, and do not ' +
  'give advice. Use "" for anything the scene does not show. Reply with JSON only: ' +
  '{"goal":"...","conflict":"...","turn":"...","beat":"...","after":"..."}.'

export interface BuildBriefPromptInput {
  /** The scene as plain text, head-truncated to `BRIEF_SCENE_CHAR_BUDGET` by the caller. */
  sceneText: string
  /** The scene's metadata when any field is set, else null. */
  meta: SceneMeta | null
}

export interface BuiltBriefPrompt {
  version: typeof BRIEF_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildBriefPrompt(input: BuildBriefPromptInput): BuiltBriefPrompt {
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  return {
    version: BRIEF_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${BRIEF_RULES}${scene}` },
      { role: 'user', content: `Scene text:\n"""\n${input.sceneText}\n"""\n\nDraft the brief.` }
    ],
    maxTokens: outputBudget('brief')
  }
}
