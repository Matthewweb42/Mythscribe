import { outputBudget } from '@shared/ai'
import type { Honesty } from '@shared/critique'
import type { SceneMeta } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'
import { CRITIQUE_RULES, HONESTY_INSTRUCTION } from './critique.v1'

/**
 * The editor's-notes prompt (F-14.8), version 3: version 2 (the scene brief in place of the
 * notes, F-14.3) plus the story bible (F-14.9) in the system turn between the voice profile
 * and the scene's metadata line, as the ground truth a note about a name or a place is judged
 * against. The rules and the honesty lines are version 1's, imported unchanged — the opening
 * sentence is the sentinel the e2e's fake OpenAI keys on. Nothing else moved. Prompt files are
 * versioned (F-5.12): a change to the text, the caps, or the message order is a new file with
 * its own golden test, never an edit to a shipped one; `critique.v2.ts` stays exactly as it
 * shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the
 * rules, the honesty line, the voice profile block (F-14.1), the story bible (F-14.9), and the
 * scene's metadata line — so the provider's prefix cache still applies when the author asks
 * again on the same scene. The user turn carries what changes: the brief (the author's stated
 * intent) and the scene.
 */
export const CRITIQUE_PROMPT_V3_VERSION = 'critique.v3'

export interface BuildCritiquePromptV3Input {
  /** The scene as plain text, head-truncated to `CRITIQUE_SCENE_CHAR_BUDGET` by the caller. */
  sceneText: string
  /**
   * The scene brief block (F-14.3, `sceneBriefBlock`): the author's intent for this scene and
   * the one line each of the scenes around it, or null when nobody has written one.
   */
  brief: string | null
  /** The scene's metadata when any field is set, else null. */
  meta: SceneMeta | null
  /**
   * The voice profile block (F-14.1, `voiceBlock`), or null when the project has neither rules
   * nor exemplars yet (then the fidelity check on each fix is skipped too).
   */
  voice: string | null
  /**
   * The story bible block (F-14.9, `renderStoryBible` within `STORY_BIBLE_TOKEN_BUDGET`), or
   * null when the project states no story facts yet.
   */
  bible: string | null
  /** The project's honesty setting (F-14.8). */
  honesty: Honesty
}

export interface BuiltCritiquePromptV3 {
  version: typeof CRITIQUE_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildCritiquePromptV3(input: BuildCritiquePromptV3Input): BuiltCritiquePromptV3 {
  const rules = [CRITIQUE_RULES, HONESTY_INSTRUCTION[input.honesty]]
  if (input.voice) rules.push(input.voice)
  const bible = input.bible ? `\n\n${input.bible}` : ''
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  const parts: string[] = []
  if (input.brief) {
    parts.push(
      `Scene brief (the author's intent):\n"""\n${input.brief}\n"""\n` +
        'Include one "intent" note: does the scene do what the brief says? Cite the passage ' +
        'that shows it.'
    )
  }
  parts.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  parts.push("Give your editor's notes.")

  return {
    version: CRITIQUE_PROMPT_V3_VERSION,
    messages: [
      { role: 'system', content: `${rules.join(' ')}${bible}${scene}` },
      { role: 'user', content: parts.join('\n\n') }
    ],
    maxTokens: outputBudget('critique')
  }
}
