import {
  CARD_GIST_MAX_WORDS,
  CARD_GIST_MIN_WORDS,
  CARD_LINE_MAX_WORDS
} from '@shared/memory/claims'
import { KNOWS_HOWS } from '@shared/memory/knows'
import { QUOTE_MAX_WORDS, QUOTE_MIN_WORDS } from '@shared/memory/quote'
import { DETAIL_LABEL_NAMES } from '@shared/memory/slots'
import { TOPIC_CAPS, TOPIC_LABEL_MAX_WORDS } from '@shared/memory/topics'
import { READER_SENTINEL } from './reader.v1'
import {
  READER_V2_NEAR_TOKENS,
  STEP_VALUE_MAX_WORDS,
  buildReaderMessages,
  topicsRosterOver,
  type BuildReaderV2PromptInput,
  type BuiltReaderV2Prompt
} from './reader.v2'

/**
 * The story-memory reader (F-16.17, F-16.22, F-16.23), version 3, after the live planted-error run
 * of 2026-10-14 (`test-results/eval-memory/planted-2026-10-14.md`): 83 % of `reader.v2`'s readings
 * were cut off at the 720-token cap, the model invented slots ("action", "emotion",
 * "occupation"), quoted more than 25 words, and put facts on people the quote does not name ("the
 * sisters walked to Callow Cross" as Johanna's location). Same layout, fit and input as
 * `reader.v2` (`buildReaderMessages`); what changes:
 *
 * - **Compact items**: voice, mode, sp, o and chg are left out at their defaults (narration, now,
 *   none, false; the parser has always read them so), about a third fewer output tokens a fact.
 * - **The slot list** with what each slot holds, "no other slot" made concrete, and the slots a
 *   place takes.
 * - **The subject in the quote**: the quote names the subject or calls them he, she or a
 *   description of one person; never a fact about several put on one, never what "you" is.
 * - **The value from the quote**, every word; a want, wish, hope or plan is no fact now; the
 *   quote's 25 words counted, a long sentence cut to the part that states the fact.
 *
 * Smaller pages (`READER_V3_PAGE_TOKENS`: 400 prose tokens, not 2,500) so a page's facts and its
 * card fit the reader's 720 output tokens; the code gates of the same day (`ladder.ts`:
 * `valueStated`, `quotePointsAtSubject`, `wishWord`; `slots.ts`: `slotFitsKind`, `readSlot`)
 * refuse what the rules forbid whatever the model answers.
 */
export const READER_V3_PROMPT_VERSION = 'reader.v3'

/** The caps the golden test asserts (the rules grew by the slot list and the subject rule). */
export const READER_V3_RULES_TOKENS = 1_200

/**
 * The most prose tokens a full-read page or a window piece sends (decided by Claude, unconfirmed,
 * 2026-10-14): the live run's pages of 300 to 560 tokens asked more than 720 output tokens in
 * v2's long form, the card about 230 of them; 400 prose tokens leave about 490 for some 15
 * compact facts. A reply still cut off is read again from its last quoted paragraph, in halves.
 */
export const READER_V3_PAGE_TOKENS = 400

/**
 * `reader.v3`'s ceiling: the reader's budget when it shipped (720). Pinned here since `reader.v4`
 * raised the budget (second live run of 2026-10-14), so v3's requests and token rows stay as they
 * were.
 */
export const READER_V3_OUTPUT_MAX = 720

/** What a card takes of the output (`reader.v2` counted 120; the live run's cards took ~230). */
export const READER_V3_CARD_OUTPUT = 240
/** A reply's floor, and its tokens per prose token sent (about one compact fact per 30). */
export const READER_V3_OUTPUT_BASE = 160
export const READER_V3_OUTPUT_PER_TOKEN = 1.2

export const READER_V3_RULES =
  `${READER_SENTINEL} Read the numbered paragraphs of one scene and list what the prose itself ` +
  'states about the records, secrets and threads listed below: each fact once, with a quote ' +
  'copied word for word, in paragraph order.\n' +
  'Rules:\n' +
  '- Only what the words say: no inference, no outside knowledge, no guesses. A negation states ' +
  'nothing ("her eyes were not blue" is no fact). A want, wish, hope or plan is no fact now ' +
  '("she wanted thread" is no object she holds). Skip anything not said plainly.\n' +
  `- "q": ${QUOTE_MIN_WORDS} to ${QUOTE_MAX_WORDS} consecutive words copied exactly from ` +
  'paragraph "p", the fewest that state the fact; count them, and from a long sentence copy only ' +
  'the part that states it; never join words from two places.\n' +
  '- "r": the roster id of whom the fact is about. The quote itself names them, or calls them ' +
  'he, she, his or her, or "the old man": a fact about several ("the sisters walked", "they") ' +
  'goes on no one, nor does what "you" is said to be. A name that is not on the roster goes in ' +
  '"n" with its own facts; never put its facts on a look-alike record.\n' +
  '- "s", exactly one of these slots: eyes (their colour), born (when), species, ' +
  'kinship (a relative; "o": their id), hair, alive (alive or dead), role (their position or ' +
  'work in the story), age (as the text states it), scars, location (where they are), injuries, ' +
  'clothing (what they wear), objects (what they hold or carry), traits (a lasting quality, not ' +
  'one act), history (a past event of theirs), relation (to another; "o": their id), or ' +
  `detail:<label> with the label one of ${DETAIL_LABEL_NAMES.join(', ')}; and knows, thread ` +
  '(below). A place takes only location, role, traits, history and relation. No other slot ' +
  '(no action, dialogue, emotion, question or appearance): a fact that fits none is left out.\n' +
  '- "v": the value in the quote\'s own words, every word from the quote, short ("grey", "the ' +
  'quay", "dead").\n' +
  '- "voice", only when not narration: dialogue (a character says it; "sp": the speaker\'s id), ' +
  'thought ("sp": the thinker\'s id), rumour (hearsay, gossip, a report). "mode", only when not ' +
  'now: memory (recalled from before), hypothetical (if, would, a wish, a fear, a plan), dream. ' +
  '"chg": true, only when the sentence states a change ("she cut her hair"). Leave out voice, ' +
  'mode, sp, o and chg at narration, now, none and false.\n' +
  '- A secret is something the story keeps from some characters or from the reader: a hidden ' +
  'act, identity, plan or truth. A thread is an open question, promise, goal or mystery the ' +
  'story sets up to answer later.\n' +
  '- Knows: {"p":5,"r":"r7","s":"knows","o":"s3","how":"overheard","fr":"r2","q":"…"}. "r": who ' +
  'knows, on the page or the point of view (or a group the sentence names). "how": one of ' +
  `${KNOWS_HOWS.join(', ')}; tells or refers when they pass it on or show they know it, ` +
  'knewBefore when the text says they already knew, believesFalse when they believe something ' +
  'untrue about it. "fr": who they had it from, only for told, overheard, read.\n' +
  '- Thread step: {"p":2,"r":"t2","s":"thread","how":"opens","v":"what happens, at most ' +
  `${STEP_VALUE_MAX_WORDS} words","q":"…"}; "how": opens, advances or resolves.\n` +
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
  'Reply with JSON only: {"c":[{"p":3,"r":"r12","s":"eyes","v":"grey","q":"…"},' +
  '{"p":4,"r":"r2","s":"traits","v":"proud","q":"…","voice":"dialogue","sp":"r5"}],' +
  '"n":[{"n":"Hesk","p":4,"q":"…","c":[…]}],"same":["c7"],"drop":["c9"],"card":{…}}'

/**
 * The most prose tokens a page (or a window piece) may send beside this topics roster: 400, less
 * what the roster runs past its 400 beyond the near lines' 250 (`reader.v2`'s rule, P2b-D10), and
 * never under 100 (a roster at its 1,000-token ceiling takes 350).
 */
export function readerV3PageTokens(topics: readonly string[]): number {
  return Math.max(
    100,
    READER_V3_PAGE_TOKENS - Math.max(0, topicsRosterOver(topics) - READER_V2_NEAR_TOKENS)
  )
}

/**
 * A request's `max_tokens`: 160 + 1.2 per prose token sent, plus 240 when a card is due, at most
 * the reader's 720. A full page of 400 with its card asks the whole 720.
 */
export function readerV3OutputCap(input: { proseTokens: number; cardDue: boolean }): number {
  return Math.min(
    READER_V3_OUTPUT_MAX,
    READER_V3_OUTPUT_BASE +
      Math.ceil(READER_V3_OUTPUT_PER_TOKEN * input.proseTokens) +
      (input.cardDue ? READER_V3_CARD_OUTPUT : 0)
  )
}

export interface BuiltReaderV3Prompt extends Omit<BuiltReaderV2Prompt, 'version'> {
  version: typeof READER_V3_PROMPT_VERSION
}

/** `reader.v3`'s messages: `reader.v2`'s layout and fit with the v3 rules. */
export function buildReaderV3Prompt(input: BuildReaderV2PromptInput): BuiltReaderV3Prompt {
  return {
    version: READER_V3_PROMPT_VERSION,
    ...buildReaderMessages(READER_V3_RULES, input, READER_V3_OUTPUT_MAX)
  }
}
