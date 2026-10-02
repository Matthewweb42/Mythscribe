import { outputBudget } from '@shared/ai'
import {
  AUTO_TAG_BANK_CATEGORIES,
  AUTO_TAG_CATEGORIES,
  SUMMARY_BANK_TAGS_MAX,
  SUMMARY_NEW_TAGS_MAX,
  SUMMARY_TAGS_MAX
} from '@shared/summary'
import type { AiMessage } from '../providers/types'
import {
  buildSummaryPromptV2,
  SUMMARY_RULES_V2,
  type BuildSummaryPromptV2Input
} from './summary.v2'

/**
 * The scene-summary prompt, version 3 (F-4.13): version 2's summary, key points, cast, and
 * observed facts, plus the tags the background job applies to the scene — the characters,
 * places, and in-world terms it names, and its tones, themes, and plot threads. One request per
 * scene still (CLAUDE.md, token rule 7): the tags ride the summary call. Prompt files are
 * versioned (F-5.12): a change to the text, the caps, or the message order is a new file with
 * its own golden test, never an edit here.
 *
 * Order (token rule 3): the system turn is version 2's — rules, the story-bible names in the
 * scene, the metadata line — with the tags clause in the rules and one `Tag bank:` line after
 * the known names; the user turn is version 2's, byte for byte. The bank line lists only the
 * tone, content, plot-thread, and custom names (people, places, and in-world terms are the
 * known names already), so the model reuses the author's vocabulary instead of coining a twin.
 */
export const SUMMARY_PROMPT_V3_VERSION = 'summary.v3'

/** Version 2's rules up to their closing `Reply with JSON only: {…}.`, which version 3 extends. */
const V2_REPLY = ' Reply with JSON only: '
const V2_BODY = SUMMARY_RULES_V2.slice(0, SUMMARY_RULES_V2.indexOf(V2_REPLY))
const V2_SHAPE = SUMMARY_RULES_V2.slice(
  SUMMARY_RULES_V2.indexOf(V2_REPLY) + V2_REPLY.length,
  SUMMARY_RULES_V2.lastIndexOf('}.')
)

/** The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI keys on it. */
export const SUMMARY_RULES_V3 =
  `${V2_BODY} Then give up to ${SUMMARY_TAGS_MAX} tags for the scene: the characters, places, ` +
  'and in-world terms (invented words, objects, factions) it names, and its tones, themes, ' +
  'and plot threads. Each tag has a name of one to three words and a category ' +
  `(${AUTO_TAG_CATEGORIES.join(', ')}; a theme is custom). Use a tag-bank or story-bible ` +
  `name, with its category, whenever one fits, and at most ${SUMMARY_NEW_TAGS_MAX} names ` +
  `that are in neither.${V2_REPLY}${V2_SHAPE},"tags":[{"name":"...","category":"tone"}]}.`

/** The bank's tone, content, plot-thread, and custom tag names, most used first, by category. */
export type SummaryBankTags = Record<(typeof AUTO_TAG_BANK_CATEGORIES)[number], string[]>

export interface BuildSummaryPromptV3Input extends BuildSummaryPromptV2Input {
  /** The bank names the model may reuse; cut to `SUMMARY_BANK_TAGS_MAX` in all here. */
  bank: SummaryBankTags
}

export interface BuiltSummaryPromptV3 {
  version: typeof SUMMARY_PROMPT_V3_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The tag-bank line, categories in bank order and the cap spent in that order; '' for none. */
function bankLine(bank: SummaryBankTags): string {
  let room = SUMMARY_BANK_TAGS_MAX
  const parts: string[] = []
  for (const category of AUTO_TAG_BANK_CATEGORIES) {
    const names = bank[category].slice(0, room)
    room -= names.length
    if (names.length > 0) parts.push(`${category} ${names.join(', ')}`)
  }
  return parts.length ? `\n\nTag bank: ${parts.join('; ')}.` : ''
}

export function buildSummaryPromptV3(input: BuildSummaryPromptV3Input): BuiltSummaryPromptV3 {
  const v2 = buildSummaryPromptV2(input)
  const [system, user] = v2.messages
  if (system === undefined || user === undefined) {
    throw new Error('summary.v2 no longer builds a system and a user turn')
  }
  // Version 2's system turn is its rules, then the known names, then the scene line: the rules
  // are swapped for this version's and the bank line goes in ahead of the scene line.
  const tail = system.content.slice(SUMMARY_RULES_V2.length)
  const sceneAt = tail.lastIndexOf('\n\nScene: location ')
  const names = sceneAt === -1 ? tail : tail.slice(0, sceneAt)
  const scene = sceneAt === -1 ? '' : tail.slice(sceneAt)
  return {
    version: SUMMARY_PROMPT_V3_VERSION,
    messages: [
      { role: 'system', content: `${SUMMARY_RULES_V3}${names}${bankLine(input.bank)}${scene}` },
      user
    ],
    maxTokens: outputBudget('summary')
  }
}
