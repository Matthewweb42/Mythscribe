import { outputBudget } from '@shared/ai'
import type { PresetParams } from '@shared/presets'
import type { AiMessage } from '../providers/types'
import { GHOST_NOTES_CHAR_CAP } from './ghostText.v1'

/**
 * The ghost-text continuation prompt (F-5.3), version 4: version 3 (the brief, F-14.3, and the
 * story bible, F-14.9) plus the scene steer (F-14.13): the scene's Tone, Content, Plot threads,
 * and theme tags as a labelled block with one instruction sentence (`renderSceneSteer`), in the
 * user turn's context after the brief and before the notes. The bible only lists the scene's
 * tags as facts; the steer tells the model to write by them. Nothing else moved: with no steer
 * this is version 3's messages exactly. Prompt files are versioned (F-5.12): a change to the
 * text, the caps, or the message order is a new file with its own golden test, never an edit
 * to a shipped one; `ghostText.v3.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is version 3's stable prefix (the
 * rules, the voice profile, the preset, the bible). The steer changes per scene, so it is
 * task-specific context: the user turn opens with the scene's metadata, its brief, the steer,
 * and its notes, then the caret window, then the one-line instruction.
 */
export const GHOST_PROMPT_V4_VERSION = 'ghostText.v4'

const SYSTEM_RULES =
  'You are the ghost-text continuation feature inside a novel-writing app. Continue the ' +
  'passage exactly where the cursor is, in the same voice, tense, and person as the text ' +
  'already written. Write 1 to 2 sentences and stop at a sentence end. Reply with the ' +
  'continuation only: no preamble, no meta-commentary, and no quotation marks around the ' +
  'answer. If text follows the cursor, continue naturally into it without repeating any of it.'

const NEW_ELEMENTS_RULE =
  'Do not introduce any new named character, place, or plot fact that the passage or the ' +
  'context below does not already establish.'

export interface BuildGhostTextPromptV4Input {
  /** Up to `GHOST_BEFORE_CHARS` of manuscript text immediately before the caret. */
  before: string
  /** Up to `GHOST_AFTER_CHARS` of manuscript text immediately after the caret, '' at the end. */
  after: string
  /** The scene's own notes as plain text (`docToText`), or null when empty. Capped in-file. */
  notes: string | null
  /** Location / POV / timeline when any field is non-empty, else null. */
  meta: { location: string; pov: string; timeline: string } | null
  /** The scene brief block (F-14.3, `sceneBriefBlock`), or null when there is none. */
  brief: string | null
  /**
   * The scene steer block (F-14.13, `buildSceneSteer`), or null when the scene has no tag in a
   * steer category. User-side, after the brief.
   */
  steer: string | null
  /** The voice profile block (F-14.1, `voiceBlock`), or null; system-side, after the rules. */
  voice: string | null
  /** The story bible block (F-14.9) within `STORY_BIBLE_GHOST_TOKEN_BUDGET`, or null; last in the prefix. */
  bible: string | null
  preset: PresetParams
}

export interface BuiltGhostTextPromptV4 {
  version: typeof GHOST_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

export function buildGhostTextPromptV4(input: BuildGhostTextPromptV4Input): BuiltGhostTextPromptV4 {
  const systemParts = [SYSTEM_RULES]
  if (input.voice) systemParts.push(input.voice)
  systemParts.push(input.preset.styleInstruction)
  if (!input.preset.allowNewElements) systemParts.push(NEW_ELEMENTS_RULE)
  const bible = input.bible ? `\n\n${input.bible}` : ''

  const contextLines: string[] = []
  if (input.meta) {
    contextLines.push(
      `Scene: location ${input.meta.location || '—'}, POV ${input.meta.pov || '—'}, ` +
        `timeline ${input.meta.timeline || '—'}.`
    )
  }
  if (input.brief) contextLines.push(input.brief)
  if (input.steer) contextLines.push(input.steer)
  if (input.notes) {
    const notes =
      input.notes.length > GHOST_NOTES_CHAR_CAP
        ? `${input.notes.slice(0, GHOST_NOTES_CHAR_CAP)}…`
        : input.notes
    contextLines.push(`Notes: ${notes}`)
  }
  const context = contextLines.length ? `${contextLines.join('\n')}\n\n` : ''
  const afterBlock = input.after
    ? `\n\nText immediately after the cursor (do not repeat it):\n"""\n${input.after}\n"""`
    : ''

  const user =
    `${context}Passage so far:\n"""\n${input.before}\n"""${afterBlock}\n\n` +
    'Continue exactly at the cursor.'

  return {
    version: GHOST_PROMPT_V4_VERSION,
    messages: [
      { role: 'system', content: `${systemParts.join(' ')}${bible}` },
      { role: 'user', content: user }
    ],
    maxTokens: Math.min(input.preset.maxSuggestionTokens, outputBudget('ghostText')),
    temperature: input.preset.temperature
  }
}
