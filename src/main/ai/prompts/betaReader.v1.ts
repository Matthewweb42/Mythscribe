import { outputBudget } from '@shared/ai'
import {
  BETA_READER_CATEGORIES,
  BETA_READER_MAX_ITEMS,
  BETA_READER_QUOTE_MAX
} from '@shared/betaReader'
import type { Honesty } from '@shared/critique'
import type { AiMessage } from '../providers/types'

/**
 * The beta-reader prompt (F-14.11), version 1: the manuscript up to one scene read in order —
 * every earlier scene as its stored summary and key points (F-5.6), the scene itself in full —
 * answered as JSON items that each name a scene by number and quote it. No voice profile, no
 * story bible, no brief: a first-time reader knows only what the page said, which is the point
 * of the feature, and it also keeps the request to the summaries and the one scene. Prompt
 * files are versioned (F-5.12): a change to the text, the caps, or the message order is a new
 * file with its own golden test, never an edit here, so every ledger row's `promptVersion`
 * stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules
 * and the honesty line (a project setting, changed rarely) — so the provider's prefix cache
 * still applies when the author asks again on the same scene. The user turn carries what
 * changes: the scenes read so far and the scene itself.
 */
export const BETA_READER_PROMPT_VERSION = 'betaReader.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a beta-reader request by it, so it must not change within this version.
 */
export const BETA_READER_RULES =
  'You are the beta-reader feature inside a novel-writing app. You have just read the numbered ' +
  'scenes below in order and know nothing else about this story. Report at most ' +
  `${BETA_READER_MAX_ITEMS} items, each one in a single category out of ` +
  `${BETA_READER_CATEGORIES.join(', ')}: what the story has told you, what you have taken to ` +
  'be true, what you are waiting for, where you lost the thread, and which thread has gone ' +
  'quiet. Every item names the scene it comes from by its number and quotes that scene word ' +
  `for word, at most ${BETA_READER_QUOTE_MAX} characters; an item whose quote is not in the ` +
  'scene it names is thrown away. Say in one or two sentences what you as the reader make of ' +
  'it: no writing advice, no fixes, no retelling of the story. Reply with JSON only: ' +
  '{"items":[{"category":"...","scene":1,"quote":"...","note":"..."}]}.'

/** How blunt the read is (F-14.8's honesty setting), said as a reader rather than an editor. */
export const BETA_READER_HONESTY: Record<Honesty, string> = {
  encouraging:
    'Be encouraging: say what held you, and put every confusion as something you wanted to ' +
    'understand.',
  direct: 'Be specific and direct: say plainly what you did not follow, no softening and no flattery.',
  brutal: 'Be brutal: say exactly where you would have put the book down, no reassurance and no hedging.'
}

/** One earlier scene as the reader read it: its stored summary and key points (F-5.6). */
export interface BetaReaderPromptScene {
  /** The scene's title as the panel labels it (`Chapter 1 › The Ferry`). */
  title: string
  summary: string
  keyPoints: string[]
}

export interface BuildBetaReaderPromptInput {
  /**
   * The scenes before this one, in reading order, each with a stored summary; the ones without
   * one and the ones the budget left out are simply absent (main counts them for the panel).
   */
  scenes: BetaReaderPromptScene[]
  /** The scene the reader has just finished, as plain text head-truncated by the caller. */
  current: { title: string; text: string }
  /** The project's honesty setting (F-14.8), shared with the editor's notes. */
  honesty: Honesty
}

export interface BuiltBetaReaderPrompt {
  version: typeof BETA_READER_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The user turn: the read-through, then the scene in full, then the ask. */
export function betaReaderReadThrough(input: BuildBetaReaderPromptInput): string {
  const earlier =
    input.scenes.length === 0
      ? 'No earlier scenes.'
      : `Scenes read so far, in order (summaries):\n${input.scenes
          .map(
            (scene, index) =>
              `[${index + 1}] ${scene.title}\n${scene.summary}` +
              scene.keyPoints.map((point) => `\n- ${point}`).join('')
          )
          .join('\n\n')}`
  const number = input.scenes.length + 1
  return [
    earlier,
    `[${number}] ${input.current.title} (this scene, full text):\n"""\n${input.current.text}\n"""`,
    'Report as the reader.'
  ].join('\n\n')
}

export function buildBetaReaderPrompt(input: BuildBetaReaderPromptInput): BuiltBetaReaderPrompt {
  return {
    version: BETA_READER_PROMPT_VERSION,
    messages: [
      { role: 'system', content: `${BETA_READER_RULES} ${BETA_READER_HONESTY[input.honesty]}` },
      { role: 'user', content: betaReaderReadThrough(input) }
    ],
    maxTokens: outputBudget('betaReader')
  }
}
