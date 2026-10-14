import { outputBudget } from '@shared/ai'
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
  STEP_VALUE_MAX_WORDS,
  buildReaderMessages,
  type BuildReaderV2PromptInput,
  type BuiltReaderV2Prompt
} from './reader.v2'
import { READER_V3_CARD_OUTPUT, READER_V3_OUTPUT_BASE } from './reader.v3'

/**
 * The story-memory reader (F-16.17, F-16.22, F-16.23), version 4, after the second live
 * planted-error run of 2026-10-14 (`test-results/eval-memory/planted-2026-10-14.md`, 19:20):
 * `reader.v3` still lost a quarter of its items to slots outside the closed list, most of them
 * "voice" (21) and "dialogue" (5), the names of its own voice and mode fields, written as a slot.
 * Same layout, fit, pages and input as `reader.v3` (`buildReaderMessages`); what changes:
 *
 * - **The slot list first and alone**: "s" is one of the listed words and nothing else, with the
 *   words it is most often confused with named as never slots (voice, dialogue, speech, memory,
 *   secret, action, event, belief); voice, mode, sp, o and chg come after it under their own
 *   heading as fields, never as slots.
 * - **What each value must be** (the facts the checker passed that were wrong): an age is an age,
 *   never a count of children; an object is a thing held or carried, never a feeling or
 *   attention; a location is where the subject is or goes, said of them, never a place only
 *   described near them, and never where they died; an absence ("not there") is no value; a fact
 *   about "my father" or "his wife" is that person's, the subject's only as kinship, relation or
 *   history; each fact in one slot.
 * - **A larger ceiling**: max_tokens min(1,000, 160 + 1.4 per prose token + 240 with the card):
 *   v3's own estimate for a 400-token page with its card was 880, clipped to 720, so most pages
 *   were cut and read again in halves.
 *
 * The code gates of the same day (`ladder.ts`: `valueOfKind`, `absentValue`, `locationStated`,
 * `diesInQuote`, `possessedOnly`, `sameQuote`; `slots.ts`: `readSlot` reads a slot's other
 * number) refuse what these rules forbid whatever the model answers.
 */
export const READER_V4_PROMPT_VERSION = 'reader.v4'

/** The cap the golden test asserts (the rules grew by the value rules and the slot heading). */
export const READER_V4_RULES_TOKENS = 1_400

/** A reply's tokens per prose token sent (v3's 1.2 left a dense page no room; ~one fact per 26). */
export const READER_V4_OUTPUT_PER_TOKEN = 1.4

const BASE_SLOT_LIST =
  'eyes (their colour), born (when), species, kinship (a relative; "o": their id), hair, alive ' +
  '(alive or dead), role (their position or work in the story), age (how old, as the text says ' +
  'it: "eighteen", "about forty"), scars, location (where they are or go), injuries, clothing ' +
  '(what they wear), objects (a thing they hold, carry or own), traits (a lasting quality, not one ' +
  'act), history (a past event of theirs), relation (to another; "o": their id)'

export const READER_V4_RULES =
  `${READER_SENTINEL} Read the numbered paragraphs of one scene and list what the prose itself ` +
  'states about the records, secrets and threads listed below: each fact once, in one slot, with ' +
  'a quote copied word for word, in paragraph order.\n' +
  `SLOTS. "s" is exactly one of: ${BASE_SLOT_LIST}, detail:<label> with the label one of ` +
  `${DETAIL_LABEL_NAMES.join(', ')}; knows and thread (below). Nothing else is a slot: never ` +
  'voice, dialogue, speech, thought, memory, dream, secret, action, event, belief, emotion or ' +
  'appearance. A fact that fits no slot is left out. A place takes only location, role, traits, ' +
  'history and relation.\n' +
  'Rules:\n' +
  '- Only what the words say: no inference, no outside knowledge, no guesses. A negation or an ' +
  'absence states nothing ("her eyes were not blue", "Lottie was not there" are no facts). A ' +
  'want, wish, hope or plan is no fact now ("she wanted thread" is no object she holds). Skip ' +
  'anything not said plainly.\n' +
  `- "q": ${QUOTE_MIN_WORDS} to ${QUOTE_MAX_WORDS} consecutive words copied exactly from ` +
  'paragraph "p", the fewest that state the fact; count them, and from a long sentence copy only ' +
  'the part that states it; never join words from two places.\n' +
  '- "r": the roster id of whom the fact is about. The quote itself names them, or calls them ' +
  'he, she, his or her, or "the old man": a fact about several ("the sisters walked", "they") ' +
  'goes on no one, nor does what "you" is said to be. A fact about someone reached through them ' +
  '("my father was a clergyman", "his wife was ill") is that person\'s, theirs only as kinship, ' +
  'relation or history. A name that is not on the roster goes in "n" with its own facts; never ' +
  'put its facts on a look-alike record.\n' +
  '- "v": the value in the quote\'s own words, every word from the quote, short ("grey", "the ' +
  'quay", "dead"), and of its slot\'s kind: an age is an age (never "four daughters"); an object ' +
  'is a thing (never a feeling, an attention or an act); a location is a place the quote puts ' +
  'them at, in or going to (never a place only described beside them, never where they died: ' +
  'that is history).\n' +
  'FIELDS, never slots: "voice", only when not narration: dialogue (a character says it; "sp": ' +
  'the speaker\'s id), thought ("sp": the thinker\'s id), rumour (hearsay, gossip, a report). ' +
  '"mode", only when not now: memory (recalled from before), hypothetical (if, would, a wish, a ' +
  'fear, a plan), dream. "chg": true, only when the sentence states a change ("she cut her ' +
  'hair"). Leave out voice, mode, sp, o and chg at narration, now, none and false.\n' +
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
 * A request's `max_tokens`: 160 + 1.4 per prose token sent, plus 240 when a card is due, at most
 * the reader's budget (1,000). A full page of 400 with its card asks 960.
 */
export function readerV4OutputCap(input: { proseTokens: number; cardDue: boolean }): number {
  return Math.min(
    outputBudget('reader'),
    READER_V3_OUTPUT_BASE +
      Math.ceil(READER_V4_OUTPUT_PER_TOKEN * input.proseTokens) +
      (input.cardDue ? READER_V3_CARD_OUTPUT : 0)
  )
}

export interface BuiltReaderV4Prompt extends Omit<BuiltReaderV2Prompt, 'version'> {
  version: typeof READER_V4_PROMPT_VERSION
}

/** `reader.v4`'s messages: `reader.v2`'s layout and fit with the v4 rules. */
export function buildReaderV4Prompt(input: BuildReaderV2PromptInput): BuiltReaderV4Prompt {
  return { version: READER_V4_PROMPT_VERSION, ...buildReaderMessages(READER_V4_RULES, input) }
}
