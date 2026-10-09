import { outputBudget } from '@shared/ai'
import { RELATION_TYPES } from '@shared/relations'
import { SCENE_CARD_CHANGED_MAX } from '@shared/sceneCard'
import {
  SUMMARY_NEW_THREADS_MAX,
  SUMMARY_RELATIONS_MAX,
  SUMMARY_THREADS_MAX
} from '@shared/summary'
import { THREAD_EVENTS } from '@shared/threads'
import type { AiMessage } from '../providers/types'
import {
  buildSummaryPromptV3,
  SUMMARY_RULES_V3,
  type BuildSummaryPromptV3Input
} from './summary.v3'

/**
 * The scene-summary prompt, version 4 (F-9.14): version 3's summary, key points, cast, facts, and
 * tags, plus the scene card (where, when, POV, what changed), the relationships the scene states
 * between two named things, and the plot-thread events it holds (opened, advanced, resolved,
 * dropped). One request per scene still (CLAUDE.md, token rule 7). The "no assuming" rule (the
 * author, 2026-10-08) is spelled out: only what the text states, an empty field rather than a
 * guess, and every relationship and thread event with the words of the scene that state it (the
 * parser drops one whose quote `findQuote` cannot find). Prompt files are versioned (F-5.12):
 * a change to the text, the caps, or the message order is a new file with its own golden test.
 *
 * Order (token rule 3): the system turn is version 3's — rules, the story-bible names in the
 * scene, the tag bank, the metadata line — with the card, relationship, and thread clauses in the
 * rules and one `Threads:` line (the project's thread names, so the model reuses one instead of
 * coining a twin) after the bank line; the user turn is version 3's, byte for byte. Like the bank
 * line, the thread line is outside the scene's content hash: a new thread stales no scene.
 */
export const SUMMARY_PROMPT_V4_VERSION = 'summary.v4'

/** How many thread names the `Threads:` line lists, newest first. */
export const SUMMARY_THREAD_NAMES_MAX = 20

const V3_REPLY = ' Reply with JSON only: '
const V3_BODY = SUMMARY_RULES_V3.slice(0, SUMMARY_RULES_V3.indexOf(V3_REPLY))
const V3_SHAPE = SUMMARY_RULES_V3.slice(
  SUMMARY_RULES_V3.indexOf(V3_REPLY) + V3_REPLY.length,
  SUMMARY_RULES_V3.lastIndexOf('}.')
)

/** The rules. The opening sentence is version 1's, byte for byte: the e2e's fake OpenAI keys on it. */
export const SUMMARY_RULES_V4 =
  `${V3_BODY} Then the scene card: where and when the scene takes place and whose point of ` +
  'view it is, each as the scene states it, and what has changed by its end in at most ' +
  `${SCENE_CARD_CHANGED_MAX} characters. Then up to ${SUMMARY_RELATIONS_MAX} relationships ` +
  'the scene states between two named characters, places, or things: from, type ' +
  `(${RELATION_TYPES.join(', ')}), and to. Then up to ${SUMMARY_THREADS_MAX} plot-thread ` +
  "events: the thread's name (a listed thread or tag-bank plot thread when one fits, at most " +
  `${SUMMARY_NEW_THREADS_MAX} new), the event (${THREAD_EVENTS.join(', ')}), and for an ` +
  'opening the question it leaves open. Give each relationship and event its quote, copied ' +
  'exactly. Record only what the text states: leave a card field empty, and give no ' +
  'relationship or event, rather than guess; anything whose quote is not in the scene is ' +
  `thrown away.${V3_REPLY}${V3_SHAPE},"card":{"where":"","when":"","pov":"","changed":"..."},` +
  '"relations":[{"from":"...","type":"ally","to":"...","quote":"..."}],' +
  '"threads":[{"name":"...","event":"opened","question":"...","quote":"..."}]}.'

export interface BuildSummaryPromptV4Input extends BuildSummaryPromptV3Input {
  /** The project's thread names, newest first; cut to `SUMMARY_THREAD_NAMES_MAX` here. */
  threads: readonly string[]
}

export interface BuiltSummaryPromptV4 {
  version: typeof SUMMARY_PROMPT_V4_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/** The thread line, '' for none. */
function threadLine(threads: readonly string[]): string {
  const names = threads.slice(0, SUMMARY_THREAD_NAMES_MAX)
  return names.length > 0 ? `\n\nThreads: ${names.join(', ')}.` : ''
}

export function buildSummaryPromptV4(input: BuildSummaryPromptV4Input): BuiltSummaryPromptV4 {
  const v3 = buildSummaryPromptV3(input)
  const [system, user] = v3.messages
  if (system === undefined || user === undefined) {
    throw new Error('summary.v3 no longer builds a system and a user turn')
  }
  // Version 3's system turn is its rules, the known names, the bank line, then the scene line:
  // the rules are swapped for this version's and the thread line goes in ahead of the scene line.
  const tail = system.content.slice(SUMMARY_RULES_V3.length)
  const sceneAt = tail.lastIndexOf('\n\nScene: location ')
  const names = sceneAt === -1 ? tail : tail.slice(0, sceneAt)
  const scene = sceneAt === -1 ? '' : tail.slice(sceneAt)
  return {
    version: SUMMARY_PROMPT_V4_VERSION,
    messages: [
      {
        role: 'system',
        content: `${SUMMARY_RULES_V4}${names}${threadLine(input.threads)}${scene}`
      },
      user
    ],
    maxTokens: outputBudget('summary')
  }
}
