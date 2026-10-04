import { outputBudget } from '@shared/ai'
import { WHAT_NEXT_DIRECTIONS, WHAT_NEXT_TEXT_MAX, WHAT_NEXT_TITLE_MAX } from '@shared/whatNext'
import type { AiMessage } from '../providers/types'

/**
 * The What should come next? prompt (F-5.17), version 1: three short directions for the scene,
 * grounded in the story bible, the scene brief, and the text so far. Directions are advice in
 * the chat, not manuscript prose, so no voice block goes out (AI rule 2 applies to the ghost
 * text a direction becomes, which Author mode writes with the voice profile and the fidelity
 * check). Prompt files are versioned (F-5.12): a change to the text, the caps, or the message
 * order is a new file (`whatNext.v2.ts`) with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules
 * and the story bible (F-14.9) — so the provider's prefix cache applies across runs on the same
 * scene; the user turn carries what changes: the scene brief (F-14.3) and the tail of the text.
 */
export const WHAT_NEXT_PROMPT_VERSION = 'whatNext.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a what-comes-next request by it, so it must not change within this version.
 */
export const WHAT_NEXT_RULES =
  'You are the what-comes-next feature inside a novel-writing app. Read the text so far, the ' +
  "scene brief (the author's intent), and the story bible, and suggest " +
  `${WHAT_NEXT_DIRECTIONS} different directions the story could take right after the last ` +
  'line: each a plausible next beat that follows from what is on the page, serves the brief, ' +
  'and keeps to the characters, places, and rules the bible states. Do not write the prose ' +
  'itself and do not summarise what already happened. Each direction has a title of at most ' +
  `${WHAT_NEXT_TITLE_MAX} characters and a text of one or two sentences, at most ` +
  `${WHAT_NEXT_TEXT_MAX} characters. Reply with JSON only: ` +
  '{"directions":[{"title":"...","text":"..."}]}.'

/** The user turn's closing instruction. */
export const WHAT_NEXT_INSTRUCTION = 'Suggest three directions for what comes next.'

export interface BuildWhatNextPromptInput {
  /** The tail of the scene, or of the text up to the selection's end, as sent. */
  text: string
  /** The scene brief block (`sceneBriefBlock`), or null when nobody has written one. */
  brief: string | null
  /** The story bible block (`buildStoryBible` within `STORY_BIBLE_TOKEN_BUDGET`), or null when it is empty. */
  bible: string | null
}

export interface BuiltWhatNextPrompt {
  version: typeof WHAT_NEXT_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildWhatNextPrompt(input: BuildWhatNextPromptInput): BuiltWhatNextPrompt {
  const system = input.bible ? `${WHAT_NEXT_RULES}\n\n${input.bible}` : WHAT_NEXT_RULES

  const user: string[] = []
  if (input.brief) user.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  user.push(`Text so far:\n"""\n${input.text}\n"""`)
  user.push(WHAT_NEXT_INSTRUCTION)

  return {
    version: WHAT_NEXT_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('whatNext')
  }
}
