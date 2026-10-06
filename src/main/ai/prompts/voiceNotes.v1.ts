import { outputBudget } from '@shared/ai'
import { VOICE_NOTE_MAX_CHARS, VOICE_NOTES_MAX } from '@shared/voice'
import type { AiMessage } from '../providers/types'

/**
 * The learned style notes prompt (F-14.14), version 1: a sample of the author's own paragraphs
 * (never AI-origin text) and the previous notes in, up to `VOICE_NOTES_MAX` short, concrete
 * observations about how the author writes out, as JSON. The notes are derived index data
 * (`PLAN.md` §2.6): stored apart, shown in the Voice section, removable, and carried by the
 * voice block. Prompt files are versioned (F-5.12): a change to the text, the caps, or the
 * message order is a new file with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable rules; the user turn
 * carries what changes: the earlier notes and the passages.
 */
export const VOICE_NOTES_PROMPT_VERSION = 'voiceNotes.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI can
 * recognise a style-notes request by it, so it must not change within this version.
 */
export const VOICE_NOTES_RULES =
  'You are the style-notes feature inside a novel-writing app. Read passages of the ' +
  "author's own prose and write notes on how they write, so later prompts can match their " +
  `voice. Write at most ${VOICE_NOTES_MAX} notes, each one sentence of at most ` +
  `${VOICE_NOTE_MAX_CHARS} characters, on concrete habits a reader could check: sentence ` +
  'length and rhythm, paragraphing, diction, dialogue and its tags, punctuation, point of ' +
  'view and tense, imagery, how beats open and close. Describe, never judge: no praise, no ' +
  'criticism, no advice. Nothing about the plot, the characters, or the setting. Keep earlier ' +
  'notes the passages still support, reword the ones they partly support, drop the rest. ' +
  'Reply with JSON only: {"notes":["..."]}.'

/** The user turn's closing instruction. */
export const VOICE_NOTES_INSTRUCTION = 'Write the style notes.'

export interface BuildVoiceNotesPromptInput {
  /** The sampled passages, in reading order, as sent. */
  passages: readonly string[]
  /** The notes stored now; empty for the first run or after Clear. */
  previous: readonly string[]
}

export interface BuiltVoiceNotesPrompt {
  version: typeof VOICE_NOTES_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildVoiceNotesPrompt(input: BuildVoiceNotesPromptInput): BuiltVoiceNotesPrompt {
  const user: string[] = []
  if (input.previous.length > 0) {
    user.push(['Earlier notes:', ...input.previous.map((note) => `- ${note}`)].join('\n'))
  }
  user.push(`Passages:\n"""\n${input.passages.join('\n\n')}\n"""`)
  user.push(VOICE_NOTES_INSTRUCTION)

  return {
    version: VOICE_NOTES_PROMPT_VERSION,
    messages: [
      { role: 'system', content: VOICE_NOTES_RULES },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('voiceNotes')
  }
}
