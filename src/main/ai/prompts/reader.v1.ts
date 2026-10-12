import { estimateTokens, inputBudget, outputBudget } from '@shared/ai'
import {
  CARD_GIST_MAX_WORDS,
  CARD_GIST_MIN_WORDS,
  CARD_LINE_MAX_WORDS
} from '@shared/memory/claims'
import { QUOTE_MAX_WORDS, QUOTE_MIN_WORDS } from '@shared/memory/quote'
import { DETAIL_LABEL_NAMES } from '@shared/memory/slots'
import type { AiMessage } from '../providers/types'

/**
 * The story-memory reader (F-16.17; design §2.3 "What is sent", plan P2a §2.2), version 1: fast
 * tier, JSON, reasoning off on every route. It reads the numbered paragraphs of one scene (a
 * window of changed paragraphs, or a page of a full read) and answers, in short keys, what the
 * prose states about the roster's records, each fact with a word-for-word quote; names not on the
 * roster with their own facts; which listed facts still stand or no longer do; and, when due, the
 * scene's card. Nothing it answers is stored as it is: the verification ladder in code
 * (`reading/pipeline.ts`) keeps only what is proved.
 *
 * Order (CLAUDE.md, token rule 3): one system message holding the rules (≤ 900 tokens) and then
 * the roster (≤ 1,600), both stable across calls so the provider's prompt cache holds them (one
 * system message, since some local servers keep only one); then the user turn: the scene's head
 * (≤ 200), the facts already known near the window (≤ 400), the facts anchored in it (≤ 250), and
 * the numbered paragraphs (≤ 2,500 prose tokens, planned by `windows.ts`). Over the input budget,
 * the near block is trimmed first, then the anchored block, never the window or the roster.
 */
export const READER_PROMPT_VERSION = 'reader.v1'

/** The rules' and the roster's caps (the golden test asserts both). */
export const READER_RULES_TOKENS = 900
export const READER_ROSTER_TOKENS = 1_600
/** The user turn's blocks: the scene's head, the facts near the window, the facts anchored in it. */
export const READER_HEAD_TOKENS = 200
export const READER_NEAR_TOKENS = 400
export const READER_ANCHORED_TOKENS = 250

/** The opening sentence: the e2e's fake provider recognises a reader request by it. */
export const READER_SENTINEL = 'You are the story-memory reader inside a novel-writing app.'

export const READER_RULES =
  `${READER_SENTINEL} Read the numbered paragraphs of one scene and list what the prose itself ` +
  'states about the records on the roster below: each fact once, with a quote copied word for ' +
  'word, in paragraph order.\n' +
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
  `other's id). Or detail:<label>, the label one of ${DETAIL_LABEL_NAMES.join(', ')}. No other ` +
  'slot.\n' +
  '- "v": the value in the quote\'s own words, short ("grey", "the quay", "dead").\n' +
  '- "voice": narration (the narrator states it), dialogue (a character says it; "sp": the ' +
  'speaker\'s id), thought ("sp": the thinker\'s id), rumour (hearsay, gossip, a report).\n' +
  '- "mode": now (true at this point of the story), memory (recalled from before), hypothetical ' +
  '(if, would, a wish, a fear, a plan), dream.\n' +
  '- "chg": true when the sentence states a change ("she cut her hair").\n' +
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

/** The heading of the roster block, after the rules. */
export const READER_ROSTER_HEADING = 'Roster (id name (nicknames) · kind):'

/** One record's roster line: `r12 Mara Vell (Mara; Captain Vell) · character`. */
export function readerRosterLine(
  short: string,
  entry: { name: string; kind: string; nicknames: readonly string[] }
): string {
  const names = entry.nicknames.length === 0 ? '' : ` (${entry.nicknames.join('; ')})`
  return `${short} ${entry.name}${names} · ${entry.kind}`
}

/** A nickname appended to a cached roster: `r12 +Ry`. */
export function readerRosterAddition(short: string, nickname: string): string {
  return `${short} +${nickname}`
}

/** One numbered paragraph (or stretch of a long one) of the window or page. */
export interface ReaderParagraph {
  p: number
  text: string
}

export interface BuildReaderPromptInput {
  /**
   * The roster lines as cached (`reading/roster.ts`): one per record and one per addition,
   * already within `READER_ROSTER_TOKENS`, byte for byte as the last call sent them.
   */
  roster: readonly string[]
  /** "Scene 14.2 “The Quay”, page 1 of 2 (the whole scene)". */
  position: string
  /** The typed details as one line ("POV r12 · place r30 (the harbour) · year 1811"), or null. */
  typed: string | null
  /** The current card as one line ("line · where … · POV r12"), or null. */
  card: string | null
  /** Live facts about the records the window names, newest first ("r12 eyes “grey”"). */
  near: readonly string[]
  /** Facts anchored in the window, with their short ids ("c7 r12 location “at the quay” ¶3"). */
  anchored: readonly string[]
  paragraphs: readonly ReaderParagraph[]
  cardDue: boolean
  /** The request's `max_tokens` (`outputCap`), at most the feature's budget. */
  maxTokens: number
}

export interface BuiltReaderPrompt {
  version: typeof READER_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
  /** What the fit left out: near and anchored lines dropped for the caps or the input budget. */
  trimmed: { near: number; anchored: number }
}

/** The longest run of `lines` from the start that fits `budget` tokens joined by new lines. */
function fitLines(lines: readonly string[], budget: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const line of lines) {
    const cost = estimateTokens(`${line}\n`)
    if (used + cost > budget) break
    kept.push(line)
    used += cost
  }
  return kept
}

/** `text` cut to about `budget` tokens at a word boundary, with an ellipsis when cut. */
function fitText(text: string, budget: number): string {
  const chars = budget * 4
  if (text.length <= chars) return text
  const cut = text.slice(0, chars - 1)
  const space = cut.lastIndexOf(' ')
  return `${(space > chars / 2 ? cut.slice(0, space) : cut).trimEnd()}…`
}

/** The system message: the rules, then the roster. */
export function readerSystem(roster: readonly string[]): string {
  return `${READER_RULES}\n\n${READER_ROSTER_HEADING}\n${roster.join('\n')}`
}

function userTurn(
  input: BuildReaderPromptInput,
  near: readonly string[],
  anchored: readonly string[]
): string {
  const head = [fitText(input.position, 40)]
  if (input.typed !== null) head.push(`Typed: ${fitText(input.typed, 60)}`)
  if (input.card !== null) head.push(`Card now: ${fitText(input.card, 90)}`)
  const parts = [head.join('\n')]
  if (near.length > 0) parts.push(`Known about the records named here:\n${near.join('\n')}`)
  if (anchored.length > 0) parts.push(`Facts listed from these paragraphs:\n${anchored.join('\n')}`)
  parts.push(
    `Paragraphs:\n${input.paragraphs.map((paragraph) => `¶${paragraph.p} ${paragraph.text}`).join('\n')}`
  )
  parts.push(`Card: ${input.cardDue ? 'yes' : 'no'}`)
  return parts.join('\n\n')
}

export function buildReaderPrompt(input: BuildReaderPromptInput): BuiltReaderPrompt {
  const system = readerSystem(input.roster)
  let near = fitLines(input.near, READER_NEAR_TOKENS)
  let anchored = fitLines(input.anchored, READER_ANCHORED_TOKENS)
  const budget = inputBudget('reader')
  const total = (): number => estimateTokens(`${system}\n${userTurn(input, near, anchored)}`)
  // Token rule 8: over the budget, the near facts go first, then the anchored ones.
  while (total() > budget && near.length > 0) near = near.slice(0, -1)
  while (total() > budget && anchored.length > 0) anchored = anchored.slice(0, -1)
  return {
    version: READER_PROMPT_VERSION,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userTurn(input, near, anchored) }
    ],
    maxTokens: Math.min(input.maxTokens, outputBudget('reader')),
    trimmed: {
      near: input.near.length - near.length,
      anchored: input.anchored.length - anchored.length
    }
  }
}
