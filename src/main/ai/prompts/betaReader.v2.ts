import { outputBudget } from '@shared/ai'
import {
  BETA_READER_CATEGORIES,
  BETA_READER_MAX_ITEMS,
  BETA_READER_QUOTE_MAX
} from '@shared/betaReader'
import type { Honesty } from '@shared/critique'
import type { AiMessage } from '../providers/types'
import { BETA_READER_HONESTY } from './betaReader.v1'

/**
 * The beta-reader prompt (F-14.11), version 2 (F-16.20, story memory v2 only; plan P2a §5.1,
 * decision P2a-D14): the earlier scenes go as their v2 card gists (`reader.v1`'s 60 to 80 words),
 * labelled a map of the earlier scenes that is never quoted, and every item quotes the current
 * scene, the one manuscript text sent; main checks each quote against that text in code. An item
 * may name the earlier scene it relates to (`ref`). About 150 tokens less per earlier scene than
 * version 1's summary and key points. A v1 project keeps sending version 1. Prompt files are
 * versioned (F-5.12): a change to the text, the caps, or the message order is a new file.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules and the honesty line in the system turn
 * (the honesty lines are version 1's); the map and the scene in the user turn.
 */
export const BETA_READER_PROMPT_V2_VERSION = 'betaReader.v2'

/**
 * The rules. The opening sentence is version 1's (the smoke e2e's fake answers by it); the map
 * heading (`BETA_READER_MAP_HEADING`) tells a v2 request apart.
 */
export const BETA_READER_RULES_V2 =
  'You are the beta-reader feature inside a novel-writing app. You have just read this story ' +
  'up to the scene below and know nothing else about it; the earlier scenes you remember only ' +
  'as the short map below, never in their own words. Report at most ' +
  `${BETA_READER_MAX_ITEMS} items, each one in a single category out of ` +
  `${BETA_READER_CATEGORIES.join(', ')}: what the story has told you, what you have taken to ` +
  'be true, what you are waiting for, where you lost the thread, and which thread has gone ' +
  'quiet. Every item quotes the scene below word for word, at most ' +
  `${BETA_READER_QUOTE_MAX} characters; an item whose quote is not in that scene is thrown ` +
  'away, so never quote the map. An item may give the number of the earlier scene it relates ' +
  'to as "ref". Say in one or two sentences what you as the reader make of it: no writing ' +
  'advice, no fixes, no retelling of the story. Reply with JSON only: ' +
  '{"items":[{"category":"...","quote":"...","note":"...","ref":null}]}.'

/** The heading over the earlier scenes; the e2e checks a v2 request by it. */
export const BETA_READER_MAP_HEADING =
  'A map of the earlier scenes (not quotable: what you remember of them), in order:'

/** One earlier scene as the reader remembers it: its title and its card's gist. */
export interface BetaReaderMapScene {
  title: string
  gist: string
}

export interface BuildBetaReaderPromptV2Input {
  /** The earlier scenes with a card, in reading order (the rest main counts as `missing`). */
  scenes: BetaReaderMapScene[]
  /** The scene the reader has just finished, as plain text head-truncated by the caller. */
  current: { title: string; text: string }
  honesty: Honesty
}

export interface BuiltBetaReaderPromptV2 {
  version: typeof BETA_READER_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The user turn: the map, then the scene in full, then the ask. */
export function betaReaderReadThroughV2(input: BuildBetaReaderPromptV2Input): string {
  const map =
    input.scenes.length === 0
      ? 'No earlier scenes.'
      : `${BETA_READER_MAP_HEADING}\n${input.scenes
          .map((scene, index) => `[${index + 1}] ${scene.title}: ${scene.gist}`)
          .join('\n')}`
  return [
    map,
    `This scene, ${input.current.title} (full text, the only text you may quote):\n"""\n${input.current.text}\n"""`,
    'Report as the reader.'
  ].join('\n\n')
}

export function buildBetaReaderPromptV2(
  input: BuildBetaReaderPromptV2Input
): BuiltBetaReaderPromptV2 {
  return {
    version: BETA_READER_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: `${BETA_READER_RULES_V2} ${BETA_READER_HONESTY[input.honesty]}` },
      { role: 'user', content: betaReaderReadThroughV2(input) }
    ],
    maxTokens: outputBudget('betaReader')
  }
}
