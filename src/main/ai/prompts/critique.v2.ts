import { outputBudget } from '@shared/ai'
import {
  CRITIQUE_CATEGORIES,
  CRITIQUE_MAX_NOTES,
  CRITIQUE_QUOTE_MAX,
  type Honesty
} from '@shared/critique'
import type { SceneMeta } from '@shared/sceneMeta'
import type { AiMessage } from '../providers/types'

/**
 * The editor's-notes prompt (F-14.8), version 2: one scene read as an editor would read it,
 * answered as JSON notes that each cite a passage, with an optional fix for the quoted
 * passage only. Changed from `critique.v1` (F-14.9): the system turn carries the story bible
 * block (`renderStoryBible`) between the voice profile and the scene's metadata line, as the
 * ground truth a note about a name or a place is judged against. Nothing else moved. Prompt
 * files are versioned (F-5.12): a change to the text, the caps, or the message order is a new
 * file (`critique.v3.ts`) with its own golden test, never an edit here, so every ledger row's
 * `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the
 * rules, the honesty line (a project setting, changed rarely), the voice profile block
 * (F-14.1), the story bible (F-14.9), and the scene's metadata line, so the provider's prefix
 * cache still applies when the author asks again on the same scene. The user turn carries
 * what changes: the author's notes as the scene's brief (the stand-in until F-14.3) and the
 * scene text itself.
 */
export const CRITIQUE_PROMPT_VERSION = 'critique.v2'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a critique request by it, so it must not change within this version.
 */
export const CRITIQUE_RULES =
  "You are the editor feature inside a novel-writing app. Give the author editor's notes " +
  `on the scene below: at most ${CRITIQUE_MAX_NOTES} notes, each one in a single category out ` +
  `of ${CRITIQUE_CATEGORIES.join(', ')}. Every note quotes the passage it is about, copied ` +
  `from the scene word for word and at most ${CRITIQUE_QUOTE_MAX} characters; a note whose ` +
  'quote is not in the scene is thrown away, praise included. Say in one or two sentences ' +
  'what is wrong, or what a praised passage does well: no summary of the scene, no general ' +
  'writing advice. An issue may carry a fix, which replaces the quoted passage and nothing ' +
  "else, in the author's voice, same point of view and tense; when you have no fix, and for " +
  'praise, the fix is null. Reply with JSON only: ' +
  '{"notes":[{"kind":"issue"|"praise","category":"...","quote":"...","why":"...","fix":"..."|null}]}.'

/** How blunt the notes are (F-14.8), one line per level of the honesty setting. */
export const HONESTY_INSTRUCTION: Record<Honesty, string> = {
  encouraging:
    'Be encouraging: open with what works, and put every issue as something to try next.',
  direct: 'Be specific and direct: name the problem plainly, no softening and no flattery.',
  brutal: 'Be brutal: say exactly how far the passage falls short, no reassurance and no hedging.'
}

export interface BuildCritiquePromptInput {
  /** The scene as plain text, head-truncated to `CRITIQUE_SCENE_CHAR_BUDGET` by the caller. */
  sceneText: string
  /** The scene's own notes as the brief (F-3.7), cut to `CRITIQUE_NOTES_CHAR_CAP`, or null. */
  notes: string | null
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

export interface BuiltCritiquePrompt {
  version: typeof CRITIQUE_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildCritiquePrompt(input: BuildCritiquePromptInput): BuiltCritiquePrompt {
  const rules = [CRITIQUE_RULES, HONESTY_INSTRUCTION[input.honesty]]
  if (input.voice) rules.push(input.voice)
  const bible = input.bible ? `\n\n${input.bible}` : ''
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  const parts: string[] = []
  if (input.notes) {
    parts.push(
      `Author's notes for this scene (its intent):\n"""\n${input.notes}\n"""\n` +
        'Include one "intent" note: does the scene do what these notes say? Cite the passage ' +
        'that shows it.'
    )
  }
  parts.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  parts.push("Give your editor's notes.")

  return {
    version: CRITIQUE_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${rules.join(' ')}${bible}${scene}` },
      { role: 'user', content: parts.join('\n\n') }
    ],
    maxTokens: outputBudget('critique')
  }
}
