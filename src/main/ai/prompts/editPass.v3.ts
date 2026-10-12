import type { AiMessage } from '../providers/types'
import { buildEditPassPrompt, EDIT_PASS_TASKS, type BuildEditPassPromptInput } from './editPass.v1'
import { EDIT_PASS_MOOD_TYPES } from './editPass.v2'

/**
 * The edit-pass prompt (F-14.15), version 3 (F-16.14, story memory v2 only): in a continuity pass
 * the Story notes block (`renderStoryNotes` within `STORY_BIBLE_TOKEN_BUDGET`, its continuity form:
 * `STORY_NOTES_CONTINUITY_HEADING`, no label lines) takes the place of
 * version 2's numbered references, in the user turn after the mood (which the continuity pass
 * never carries), and the continuity task says so: the notes are what the passage is checked
 * against, and each disagreement is a change the author decides on (the manuscript is canon,
 * answer 1). Every other pass type is version 2's messages exactly; the rules, the JSON contract,
 * the cap and the sentinel (the e2e's fake OpenAI keys on it) are version 1's. A v1 project keeps
 * sending version 2. Prompt files are versioned (F-5.12): `editPass.v2.ts` stays as it shipped.
 */
export const EDIT_PASS_PROMPT_V3_VERSION = 'editPass.v3'

/**
 * The continuity task of version 3: checked against the Story notes (their continuity form, under
 * `STORY_NOTES_CONTINUITY_HEADING`), not numbered references. The manuscript is canon (answer 1),
 * so a disagreement is reported, never settled: each change is a proposal, and its why says the
 * note may be the side to update.
 */
export const EDIT_PASS_V3_CONTINUITY_TASK =
  "Continuity pass: find statements that disagree with the author's story notes below. For each, " +
  'change the fewest words that would make the passage agree, and in why name the note and say ' +
  'the note may be what needs updating instead; the author decides. Anything the notes do not ' +
  'cover is not a disagreement.'

export interface BuildEditPassPromptV3Input extends Omit<BuildEditPassPromptInput, 'references'> {
  /** The scene mood block (F-5.6), or null; developmental, line and custom passes only. */
  mood: string | null
  /** The Story notes block (F-16.14), or null; the continuity pass only. */
  storyNotes: string | null
}

export interface BuiltEditPassPromptV3 {
  version: typeof EDIT_PASS_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildEditPassPromptV3(input: BuildEditPassPromptV3Input): BuiltEditPassPromptV3 {
  const v1 = buildEditPassPrompt({ ...input, references: [] })
  const continuity = input.type === 'continuity'
  const before = [
    EDIT_PASS_MOOD_TYPES.includes(input.type) ? input.mood : null,
    continuity ? input.storyNotes : null
  ].filter((block): block is string => block !== null && block !== '')
  const messages = v1.messages.map((message) => {
    if (message.role === 'system' && continuity) {
      return {
        ...message,
        content: message.content.replace(EDIT_PASS_TASKS.continuity, EDIT_PASS_V3_CONTINUITY_TASK)
      }
    }
    if (message.role === 'user' && before.length > 0) {
      return { ...message, content: `${before.join('\n\n')}\n\n${message.content}` }
    }
    return message
  })
  return { version: EDIT_PASS_PROMPT_V3_VERSION, messages, maxTokens: v1.maxTokens }
}
