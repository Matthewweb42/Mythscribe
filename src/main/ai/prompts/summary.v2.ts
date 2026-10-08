import { outputBudget } from '@shared/ai'
import {
  OBSERVED_ATTRIBUTES,
  OBSERVED_KINDS,
  type ObservedKind,
  OBSERVED_FACT_QUOTE_MAX,
  OBSERVED_FACT_VALUE_MAX
} from '@shared/observedFacts'
import type { PromptSceneMeta } from '@shared/sceneMeta'
import { SUMMARY_FACTS_MAX, SUMMARY_KEY_POINTS_MAX, SUMMARY_KNOWN_NAMES_MAX } from '@shared/summary'
import type { AiMessage } from '../providers/types'

/**
 * The scene-summary prompt, version 2 (F-5.16): version 1's summary, key points, and cast, plus
 * the observed facts the automatic story bible logs — what the scene states about a character,
 * a place, or an in-world thing, each under one attribute of a fixed list per kind and each
 * with the words of the scene that state it. One request per scene still (CLAUDE.md, token rule
 * 7): the facts ride the summary call. Prompt files are versioned (F-5.12): a change to the
 * text, the caps, or the message order is a new file with its own golden test, never an edit
 * here, so every stored row's `promptVersion` stays true.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix — the rules,
 * the story-bible names that occur in the scene by kind, and the scene's metadata line — and
 * the user turn carries the scene text and the one-line instruction. Version 1 listed every
 * character tag of the bank; this one lists only the names the scene itself contains, of all
 * three kinds, so the model attaches a fact to the entity the author already has and a new
 * entity elsewhere in the project does not change what an unrelated scene sends.
 */
export const SUMMARY_PROMPT_V2_VERSION = 'summary.v2'

/** The attribute vocabulary as the rules state it: `character: age, gender, …; setting: …`. */
const ATTRIBUTE_LISTS = OBSERVED_KINDS.map(
  (kind) => `${kind}: ${OBSERVED_ATTRIBUTES[kind].join(', ')}`
).join('; ')

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a summary request by it, so it is version 1's, byte for byte.
 */
export const SUMMARY_RULES_V2 =
  'You are the scene-summary feature inside a novel-writing app. Summarize the scene below ' +
  "for the author's index: at most 80 words, in plain past tense, stating what happens. Do " +
  'not evaluate the writing, do not give advice, and do not invent anything the scene does ' +
  `not show. Then give up to ${SUMMARY_KEY_POINTS_MAX} key points, one clause each, and the ` +
  'characters present, by name, spelled as the story-bible names are when given. Then give ' +
  `up to ${SUMMARY_FACTS_MAX} facts the scene states about a character, a place (kind ` +
  '"setting"), or an in-world thing (kind "world") that stay true beyond this scene; events ' +
  'belong in the key points, and a scene that states none gets an empty list. Each fact has ' +
  `the entity's name, its kind, one attribute of that kind (${ATTRIBUTE_LISTS}), the value ` +
  `in at most ${OBSERVED_FACT_VALUE_MAX} characters, and the quote: the scene's words that ` +
  `state it, copied exactly, at most ${OBSERVED_FACT_QUOTE_MAX} characters; a fact whose ` +
  'quote is not in the scene is thrown away. Reply with JSON only: ' +
  '{"summary":"...","keyPoints":["..."],"characters":["..."],"facts":[{"entity":"...",' +
  '"kind":"character","attribute":"age","value":"...","quote":"..."}]}.'

/** The story-bible names that occur in the scene, by kind, each as the bible spells it. */
export type SummaryKnownNames = Record<ObservedKind, string[]>

/** How each kind's names are introduced in the known-names line. */
const KNOWN_LABEL: Record<ObservedKind, string> = {
  character: 'characters',
  setting: 'settings',
  world: 'world'
}

export interface BuildSummaryPromptV2Input {
  /** The scene as plain text, head-truncated to `SUMMARY_SCENE_CHAR_BUDGET` by the caller. */
  sceneText: string
  /** The scene's metadata when any field is set, else null. */
  meta: PromptSceneMeta | null
  /** The story-bible names occurring in the scene; cut to `SUMMARY_KNOWN_NAMES_MAX` in all here. */
  known: SummaryKnownNames
}

export interface BuiltSummaryPromptV2 {
  version: typeof SUMMARY_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The known-names line, kinds in story-bible order and the cap spent in that order; '' for none. */
function knownLine(known: SummaryKnownNames): string {
  let room = SUMMARY_KNOWN_NAMES_MAX
  const parts: string[] = []
  for (const kind of OBSERVED_KINDS) {
    const names = known[kind].slice(0, room)
    room -= names.length
    if (names.length > 0) parts.push(`${KNOWN_LABEL[kind]} ${names.join(', ')}`)
  }
  return parts.length ? `\n\nStory-bible names in this scene: ${parts.join('; ')}.` : ''
}

export function buildSummaryPromptV2(input: BuildSummaryPromptV2Input): BuiltSummaryPromptV2 {
  const meta = input.meta
  const scene = meta
    ? `\n\nScene: location ${meta.location || '—'}, POV ${meta.pov || '—'}, ` +
      `timeline ${meta.timeline || '—'}.`
    : ''

  return {
    version: SUMMARY_PROMPT_V2_VERSION,
    messages: [
      { role: 'system', content: `${SUMMARY_RULES_V2}${knownLine(input.known)}${scene}` },
      { role: 'user', content: `Scene text:\n"""\n${input.sceneText}\n"""\n\nSummarize the scene.` }
    ],
    maxTokens: outputBudget('summary')
  }
}
