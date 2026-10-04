import { outputBudget } from '@shared/ai'
import { PROOFREAD_KINDS, PROOFREAD_MAX_FIXES, PROOFREAD_QUOTE_MAX } from '@shared/proofread'
import type { AiMessage } from '../providers/types'

/**
 * The proofread prompt (F-14.12), version 1: a mechanical pass over one scene or one selection.
 * The model quotes a short passage that holds the error and occurs once, and gives that passage
 * corrected, so main can check every fix against the text and the renderer can apply it as a
 * diff. Prompt files are versioned (F-5.12): a change to the text, the caps, or the message
 * order is a new file (`proofread.v2.ts`) with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules,
 * the voice profile block (F-14.1: the author's rules decide what is intentional), and the words
 * to keep as written (the story's names and the project dictionary) — so the provider's prefix
 * cache applies across the scenes of one POV; the user turn carries what changes: the scene
 * brief (F-14.3, context only) and the text to proofread.
 */
export const PROOFREAD_PROMPT_VERSION = 'proofread.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a proofread request by it, so it must not change within this version.
 */
export const PROOFREAD_RULES =
  'You are the proofreading feature inside a novel-writing app. Correct only spelling, typos, ' +
  'grammar, punctuation, doubled words, missing words, and misspelled story names. Never ' +
  'change style, word choice, rhythm, tense, or voice: fragments, dialect, slang, and ' +
  "deliberate repetition follow the author's voice and rules and are left alone. Words in the " +
  'keep list are correct as written, and a word close to a listed name is that name ' +
  `misspelled (kind name). List at most ${PROOFREAD_MAX_FIXES} fixes, one per error, with no ` +
  'two quotes overlapping. Each quote is the shortest passage that contains the error and ' +
  `occurs only once in the text, a few words copied word for word and at most ` +
  `${PROOFREAD_QUOTE_MAX} characters; the fix is that passage corrected and nothing else. ` +
  `Reply with JSON only: {"fixes":[{"kind":"...","quote":"...","fix":"..."}]}, kind one of ` +
  `${PROOFREAD_KINDS.join(', ')}; with no error, {"fixes":[]}.`

export interface BuildProofreadPromptInput {
  /** The text to proofread as sent: the selection, or the head of the scene. */
  text: string
  /** The voice profile block (`voiceBlock`), or null when the project has no rules or exemplars yet. */
  voice: string | null
  /** The scene brief block (`sceneBriefBlock`), or null when nobody has written one. */
  brief: string | null
  /** Names and dictionary words that are correct as written; the caller caps them. */
  keepWords: readonly string[]
}

export interface BuiltProofreadPrompt {
  version: typeof PROOFREAD_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

export function buildProofreadPrompt(input: BuildProofreadPromptInput): BuiltProofreadPrompt {
  // The keep list gets its own paragraph so it never reads as part of the last exemplar.
  let system = input.voice ? `${PROOFREAD_RULES} ${input.voice}` : PROOFREAD_RULES
  if (input.keepWords.length > 0) system += `\n\nKeep as written: ${input.keepWords.join(', ')}.`

  const user: string[] = []
  if (input.brief) {
    user.push(`Scene brief (context only, not to proofread):\n"""\n${input.brief}\n"""`)
  }
  user.push(`Text to proofread:\n"""\n${input.text}\n"""`)
  user.push('Proofread the text.')

  return {
    version: PROOFREAD_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user.join('\n\n') }
    ],
    maxTokens: outputBudget('proofread')
  }
}
