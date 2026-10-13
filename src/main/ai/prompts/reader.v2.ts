import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  CARD_GIST_MAX_WORDS,
  CARD_GIST_MIN_WORDS,
  CARD_LINE_MAX_WORDS
} from '@shared/memory/claims'
import { KNOWS_HOWS } from '@shared/memory/knows'
import { QUOTE_MAX_WORDS, QUOTE_MIN_WORDS } from '@shared/memory/quote'
import { DETAIL_LABEL_NAMES } from '@shared/memory/slots'
import {
  TOPIC_CAPS,
  TOPIC_LABEL_MAX_WORDS,
  TOPIC_ROSTER_TOKENS,
  topicLinesTokens
} from '@shared/memory/topics'
import { PAGE_TOKENS } from '@shared/memory/windows'
import type { AiMessage } from '../providers/types'
import {
  READER_ROSTER_HEADING,
  READER_SENTINEL,
  fitLines,
  fitText,
  type ReaderParagraph
} from './reader.v1'

/**
 * The story-memory reader (F-16.17, F-16.22, F-16.23; design §2.3, §2.5; plan P2b §2.2), version
 * 2: `reader.v1` plus who knows what and plot threads. Fast tier, JSON, reasoning off on every
 * route, input cap 6,000. Besides v1's facts it answers knows facts (who learned or holds which
 * secret, how, and from whom; the learner on the page or the point of view), thread steps (opens,
 * advances, resolves) and secrets and threads not listed yet (`n` items with a kind, a label and
 * the sentence that reveals or opens them). Nothing it answers is stored as it is: the pipeline
 * keeps only what is proved, and never reads "not knowing" as a fact.
 *
 * Order (CLAUDE.md, token rule 3): one system message holding the rules (≤ 1,150 tokens), the
 * record roster (≤ 1,200, P2a's: characters, places, things, groups, terms) and then the topics
 * roster (≤ 400, the secrets and threads, never dropping one, P2b-D10), all stable across calls so
 * the provider's prompt cache holds them, a topic change never moving the record prefix; then the
 * user turn: the scene's head (≤ 200), the facts known near the window (≤ 250), the topic lines
 * (≤ 150: the secrets the window matches or someone here holds, the open threads it names), the
 * facts anchored in it (≤ 250, knows and steps included, and its re-checking reveals) and the
 * numbered paragraphs (≤ 2,500 prose tokens). Over the input budget the near lines go first,
 * then the topic lines, then the anchored ones; never the window or a roster. A topics roster past
 * its 400 takes the overflow out of the near lines' budget (`trimmed.rosterOver`), and what the
 * near lines cannot give out of the page (`readerV2PageTokens`: the pipeline plans smaller pages),
 * so a reading always fits its input cap; the roster itself stops at `TOPIC_ROSTER_MAX_TOKENS`.
 */
export const READER_V2_PROMPT_VERSION = 'reader.v2'

/** The same opening sentence as `reader.v1`: the e2e's fake provider recognises a reader by it. */
export { READER_SENTINEL }

/** The caps the golden test asserts. */
export const READER_V2_RULES_TOKENS = 1_150
export const READER_V2_RECORD_ROSTER_TOKENS = 1_200
export const READER_V2_TOPICS_TOKENS = TOPIC_ROSTER_TOKENS
/** The user turn's blocks (the design's 400-token tail split between near and topic lines). */
export const READER_V2_HEAD_TOKENS = 200
export const READER_V2_NEAR_TOKENS = 250
export const READER_V2_TOPIC_LINES_TOKENS = 150
export const READER_V2_ANCHORED_TOKENS = 250

/** The heading of the topics roster, after the record roster. */
export const READER_TOPICS_HEADING = 'Secrets and threads (id label · kind):'
/** What the topics roster says before the first secret or thread exists. */
export const READER_NO_TOPICS = '(none yet)'
/** The headings of the user turn's topic and anchored blocks. */
export const READER_TOPIC_LINES_HEADING = 'Secrets and threads here:'
export const READER_ANCHORED_HEADING = 'Facts listed from these paragraphs:'

/** The most words a thread step's "what happens" keeps. */
export const STEP_VALUE_MAX_WORDS = 12

export const READER_V2_RULES =
  `${READER_SENTINEL} Read the numbered paragraphs of one scene and list what the prose itself ` +
  'states about the records, secrets and threads listed below: each fact once, with a quote ' +
  'copied word for word, in paragraph order.\n' +
  'Rules:\n' +
  '- Only what the words say: no inference, no outside knowledge, no guesses. A negation states ' +
  'nothing ("her eyes were not blue" is no fact). Skip anything not said plainly.\n' +
  `- "q": ${QUOTE_MIN_WORDS} to ${QUOTE_MAX_WORDS} consecutive words copied exactly from ` +
  'paragraph "p", the fewest that state the fact; never join words from two places.\n' +
  '- "r": the roster id of whom the fact is about, as the text makes clear. A name that is not ' +
  'on the roster goes in "n" with its own facts; never put its facts on a look-alike record.\n' +
  '- "s", one slot. Fixed: eyes, born, species, kinship ("o": the relative\'s id). Lasting: hair, ' +
  'alive, role, age (an age the text states), scars. Transient: location, injuries, clothing, ' +
  'objects (held or carried). Accumulating: traits, history (a past event), relation ("o": the ' +
  `other's id). Or detail:<label>, the label one of ${DETAIL_LABEL_NAMES.join(', ')}. Or knows, ` +
  'thread (below). No other slot.\n' +
  '- "v": the value in the quote\'s own words, short ("grey", "the quay", "dead").\n' +
  '- "voice": narration (the narrator states it), dialogue (a character says it; "sp": the ' +
  'speaker\'s id), thought ("sp": the thinker\'s id), rumour (hearsay, gossip, a report).\n' +
  '- "mode": now (true at this point of the story), memory (recalled from before), hypothetical ' +
  '(if, would, a wish, a fear, a plan), dream.\n' +
  '- "chg": true when the sentence states a change ("she cut her hair").\n' +
  '- A secret is something the story keeps from some characters or from the reader: a hidden ' +
  'act, identity, plan or truth. A thread is an open question, promise, goal or mystery the ' +
  'story sets up to answer later.\n' +
  '- Knows: {"p":5,"r":"r7","s":"knows","o":"s3","how":"overheard","fr":"r2","q":"…",' +
  '"voice":"narration","mode":"now"}. "r": who knows, on the page or the point of view (or a ' +
  `group the sentence names). "how": one of ${KNOWS_HOWS.join(', ')}; tells or refers when they ` +
  'pass it on or show they know it, knewBefore when the text says they already knew, ' +
  'believesFalse when they believe something untrue about it. "fr": who they had it from, only ' +
  'for told, overheard, read.\n' +
  '- Thread step: {"p":2,"r":"t2","s":"thread","how":"opens","v":"what happens, at most ' +
  `${STEP_VALUE_MAX_WORDS} words","q":"…","voice":"narration","mode":"now"}; "how": opens, ` +
  'advances or resolves.\n' +
  '- A secret or thread not listed goes in "n": {"n":"its label, at most ' +
  `${TOPIC_LABEL_MAX_WORDS} words","kind":"secret","id":"x1","p":4,"q":"the sentence that ` +
  `reveals or opens it"}; its facts use "x1". At most ${TOPIC_CAPS.secret} new secrets and ` +
  `${TOPIC_CAPS.thread} new threads; never one already listed (use its id). A listed one marked ` +
  're-checking whose reveal the paragraphs still state: {"id":"s3","kind":"secret","p":4,"q":"…"}.\n' +
  '- Only what the text shows. Not knowing is never a fact: never list who does not know.\n' +
  '- "same": ids of listed facts the paragraphs still state unchanged. "drop": ids of listed ' +
  'facts marked re-checking that the paragraphs no longer state.\n' +
  `- With "Card: yes", add "card": "line" (what happens, one sentence, at most ` +
  `${CARD_LINE_MAX_WORDS} words), "gist" (${CARD_GIST_MIN_WORDS} to ${CARD_GIST_MAX_WORDS} ` +
  'words), "where", "when", "year" and "elapsed" (time since the scene before) each [value, p, ' +
  'quote] or null, "pov" [roster id, p, quote] of the point-of-view character or null, "flash" ' +
  '[true or false, p, quote] or null, "present" [[id, p, quote]] for those on the page (not only ' +
  'named), "mood" and "theme" a few words each. With "Card: no", leave "card" out.\n' +
  'Reply with JSON only: {"c":[{"p":3,"r":"r12","s":"eyes","v":"grey","q":"…",' +
  '"voice":"narration","sp":null,"mode":"now","o":null,"chg":false}],' +
  '"n":[{"n":"Hesk","p":4,"q":"…","c":[…]}],"same":["c7"],"drop":["c9"],"card":{…}}'

export interface BuildReaderV2PromptInput {
  /**
   * The record roster lines as cached (`reading/rosterCache.ts`): one per record and one per
   * addition, within `READER_V2_RECORD_ROSTER_TOKENS`, byte for byte as the last call sent them.
   */
  roster: readonly string[]
  /** The topics roster lines as cached (`s3 the sold map · secret`), base then additions. */
  topics: readonly string[]
  /** "Scene 14.2 “The Quay”, page 1 of 2 (the whole scene)". */
  position: string
  typed: string | null
  card: string | null
  /** Live facts about the records the window names ("r12 eyes “grey”"). */
  near: readonly string[]
  /**
   * The listed secrets the window matches or someone here holds, and the open threads it names
   * (`s3 the sold map: r7 overheard 9.3 (from r2)`, `t2 Ashby's return: open since 13.1`).
   */
  topicLines: readonly string[]
  /** Facts anchored in the window, knows and steps included, and its re-checking reveals. */
  anchored: readonly string[]
  paragraphs: readonly ReaderParagraph[]
  cardDue: boolean
  /** The request's `max_tokens` (`outputCap`), at most the feature's budget. */
  maxTokens: number
}

export interface BuiltReaderV2Prompt {
  version: typeof READER_V2_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  /**
   * What the fit left out: near, topic and anchored lines dropped for the caps or the input budget,
   * and how many tokens the topics roster ran past its 400 (taken from the near lines' budget).
   */
  trimmed: { near: number; topics: number; anchored: number; rosterOver: number }
}

/** How many tokens the topics roster runs past its 400 (P2b-D10). */
export const topicsRosterOver = (topics: readonly string[]): number =>
  Math.max(0, topicLinesTokens(topics) - READER_V2_TOPICS_TOKENS)

/**
 * The most prose tokens a page (or a window piece) may send beside this topics roster: 2,500, less
 * what the roster runs past its 400 beyond the near lines' 250 (P2b-D10, amended in review), so
 * the prompt's total never grows with the roster and a reading never fails its input cap.
 */
export function readerV2PageTokens(topics: readonly string[]): number {
  return PAGE_TOKENS - Math.max(0, topicsRosterOver(topics) - READER_V2_NEAR_TOKENS)
}

/** The system message: the rules, the record roster, then the topics roster. */
export function readerV2System(roster: readonly string[], topics: readonly string[]): string {
  const listed = topics.length === 0 ? READER_NO_TOPICS : topics.join('\n')
  return (
    `${READER_V2_RULES}\n\n${READER_ROSTER_HEADING}\n${roster.join('\n')}\n\n` +
    `${READER_TOPICS_HEADING}\n${listed}`
  )
}

function userTurn(
  input: BuildReaderV2PromptInput,
  near: readonly string[],
  topicLines: readonly string[],
  anchored: readonly string[]
): string {
  const head = [fitText(input.position, 40)]
  if (input.typed !== null) head.push(`Typed: ${fitText(input.typed, 60)}`)
  if (input.card !== null) head.push(`Card now: ${fitText(input.card, 90)}`)
  const parts = [head.join('\n')]
  if (near.length > 0) parts.push(`Known about the records named here:\n${near.join('\n')}`)
  if (topicLines.length > 0) parts.push(`${READER_TOPIC_LINES_HEADING}\n${topicLines.join('\n')}`)
  if (anchored.length > 0) parts.push(`${READER_ANCHORED_HEADING}\n${anchored.join('\n')}`)
  parts.push(
    `Paragraphs:\n${input.paragraphs.map((paragraph) => `¶${paragraph.p} ${paragraph.text}`).join('\n')}`
  )
  parts.push(`Card: ${input.cardDue ? 'yes' : 'no'}`)
  return parts.join('\n\n')
}

export function buildReaderV2Prompt(input: BuildReaderV2PromptInput): BuiltReaderV2Prompt {
  const system = readerV2System(input.roster, input.topics)
  // P2b-D10: the topics roster never drops a topic; what it runs past its 400 the near lines give.
  const rosterOver = topicsRosterOver(input.topics)
  let near = fitLines(input.near, Math.max(0, READER_V2_NEAR_TOKENS - rosterOver))
  let topicLines = fitLines(input.topicLines, READER_V2_TOPIC_LINES_TOKENS)
  let anchored = fitLines(input.anchored, READER_V2_ANCHORED_TOKENS)
  const budget = inputBudget('reader')
  const total = (): number =>
    estimateTokens(`${system}\n${userTurn(input, near, topicLines, anchored)}`)
  // Token rule 8: over the budget, the near facts go first, then the topic lines, then anchored.
  while (total() > budget && near.length > 0) near = near.slice(0, -1)
  while (total() > budget && topicLines.length > 0) topicLines = topicLines.slice(0, -1)
  while (total() > budget && anchored.length > 0) anchored = anchored.slice(0, -1)
  return {
    version: READER_V2_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userTurn(input, near, topicLines, anchored) }
    ],
    maxTokens: Math.min(input.maxTokens, outputBudget('reader')),
    trimmed: {
      near: input.near.length - near.length,
      topics: input.topicLines.length - topicLines.length,
      anchored: input.anchored.length - anchored.length,
      rosterOver
    }
  }
}
