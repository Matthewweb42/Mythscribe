import { outputBudget } from '@shared/ai'
import type { PresetParams } from '@shared/presets'
import type { AiMessage } from '../providers/types'

/**
 * The ghost-text continuation prompt (F-5.3), version 2. Changed from `ghostText.v1`
 * (F-14.9): the system turn carries the story bible block (`renderStoryBible`) after the
 * rules, the voice profile, and the preset, as the ground truth for names and places. Nothing
 * else moved. Prompt files are versioned (F-5.12): a change to the text, the caps, or the
 * message order is a new file (`ghostText.v3.ts`) with its own golden test, never an edit
 * here, so every ledger row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix, in the
 * order the features fill it in: the rules, then the voice profile block (F-14.1: rules and
 * exemplars, null for a project with neither), then the preset's style instruction and its
 * new-elements rule (F-5.2), then the story bible (F-14.9), which holds still while the
 * author writes the scene. The user turn carries the task-specific context, cheapest first:
 * the scene's metadata and notes, then the caret window, then the one-line instruction.
 */
export const GHOST_PROMPT_VERSION = 'ghostText.v2'

const SYSTEM_RULES =
  'You are the ghost-text continuation feature inside a novel-writing app. Continue the ' +
  'passage exactly where the cursor is, in the same voice, tense, and person as the text ' +
  'already written. Write 1 to 2 sentences and stop at a sentence end. Reply with the ' +
  'continuation only: no preamble, no meta-commentary, and no quotation marks around the ' +
  'answer. If text follows the cursor, continue naturally into it without repeating any of it.'

const NEW_ELEMENTS_RULE =
  'Do not introduce any new named character, place, or plot fact that the passage or the ' +
  'context below does not already establish.'

/** Caps the notes text folded into the user turn; notes can run long, ghost text must stay compact. */
export const GHOST_NOTES_CHAR_CAP = 500

export interface BuildGhostTextPromptInput {
  /** Up to `GHOST_BEFORE_CHARS` of manuscript text immediately before the caret. */
  before: string
  /** Up to `GHOST_AFTER_CHARS` of manuscript text immediately after the caret, '' at the end. */
  after: string
  /** The scene's own notes as plain text (`docToText`), or null when empty. Capped in-file. */
  notes: string | null
  /** Location / POV / timeline when any field is non-empty, else null. */
  meta: { location: string; pov: string; timeline: string } | null
  /**
   * The voice profile block (F-14.1, `voiceBlock`), or null when the project has neither
   * rules nor exemplars yet. System-side, right after the rules, so it is part of the stable
   * prefix provider caching applies to.
   */
  voice: string | null
  /**
   * The story bible block (F-14.9, `renderStoryBible` within `STORY_BIBLE_GHOST_TOKEN_BUDGET`),
   * or null when the project states no story facts yet. System-side, last in the prefix.
   */
  bible: string | null
  preset: PresetParams
}

export interface BuiltGhostTextPrompt {
  version: typeof GHOST_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  temperature: number
}

export function buildGhostTextPrompt(input: BuildGhostTextPromptInput): BuiltGhostTextPrompt {
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
    version: GHOST_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${systemParts.join(' ')}${bible}` },
      { role: 'user', content: user }
    ],
    maxTokens: Math.min(input.preset.maxSuggestionTokens, outputBudget('ghostText')),
    temperature: input.preset.temperature
  }
}
