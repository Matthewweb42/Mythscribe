import {
  CARD_GIST_MAX_WORDS,
  CARD_GIST_MIN_WORDS,
  CARD_LINE_MAX_WORDS
} from '@shared/memory/claims'
import { KNOWS_HOWS } from '@shared/memory/knows'
import { RELATION_VALUE_MAX_WORDS } from '@shared/memory/ladder'
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

/**
 * The story-memory reader (F-16.17, F-16.22, F-16.23), version 5, after the third live
 * planted-error run of 2026-10-14 (21:35; plan `ReaderPrecision.md`): `reader.v4` still wrote
 * "voice" as a slot 18 times (its own field's name), and about one in ten of the facts stored on
 * unlabelled sentences was wrong, nearly all in the open-ended slots. Same layout, fit, pages,
 * input and output cap as `reader.v4` (`buildReaderMessages`, `readerV4OutputCap`); what changes:
 *
 * - **The field `voice` is `src`**, so no field shares a name with a word the model may take for
 *   a slot; `parseReaderAnswer` reads either.
 * - **What each open-ended slot holds**: a trait lasts (never one act or one evening's mood), a
 *   role is a position or work (never an act), kinship is what they are to a named person (never
 *   the relative: "his second daughter" is the daughter's), a relation is how they stand to one
 *   person in a few words (never a list of people or a remark), history is their own past act
 *   told as fact (never a plan or a report).
 * - **Who did it**: for history, role, relation and traits "r" is who does or is it, never the
 *   one it is done to ("he asked Miss Pell" is his); a he or she two people in reach could be is
 *   no one's.
 * - **A place or thing has no location**, and a report or what others said is rumour.
 *
 * The code gates of the same day (`ladder.ts`: `pronounRivals`, `pronounOfOtherGender`,
 * `actsOnSubject`, `ageIsSpan`, `relativeValue`, `relationValue`; `slots.ts`: `slotFitsKind`)
 * refuse what these rules forbid whatever the model answers, and the open-ended slots are checked
 * on the strong tier (`verify.v4`).
 */
export const READER_V5_PROMPT_VERSION = 'reader.v5'

/** The cap the golden test asserts (v4's 1,400 and the open-ended value rules). */
export const READER_V5_RULES_TOKENS = 1_550

const BASE_SLOT_LIST =
  'eyes (their colour), born (when), species, kinship (what they are to a named person: ' +
  '"Lise\'s cousin", "son of the steward", "married"; "o": that person\'s id; never the relative: ' +
  '"his second daughter" is the daughter\'s), hair, alive (alive or dead), role (their position ' +
  'or work: "steward", "guest"; never an act), age (how old, as the text says it: "eighteen", ' +
  '"about forty"; never how long something lasted), scars, location (where they are or go), ' +
  'injuries, clothing (what they wear), objects (a thing they hold, carry or own), traits (a ' +
  "lasting quality; never one act, one evening's mood, or what others think of them), history (a " +
  'past act or event of theirs, told as fact; never a plan, an expectation or a report), relation ' +
  `(how they stand to one other person, at most ${RELATION_VALUE_MAX_WORDS} words: "admires", ` +
  '"engaged to"; "o": their id; never a list of people or a remark)'

export const READER_V5_RULES =
  `${READER_SENTINEL} Read the numbered paragraphs of one scene and list what the prose itself ` +
  'states about the records, secrets and threads listed below: each fact once, in one slot, with ' +
  'a quote copied word for word, in paragraph order.\n' +
  `SLOTS. "s" is exactly one of: ${BASE_SLOT_LIST}, detail:<label> with the label one of ` +
  `${DETAIL_LABEL_NAMES.join(', ')}; knows and thread (below). Nothing else is a slot: never ` +
  'src, voice, dialogue, speech, thought, memory, dream, secret, action, event, belief, emotion ' +
  'or appearance. A fact that fits no slot is left out. A place takes only role, traits, history ' +
  "and relation; a place or a thing is never anyone's location.\n" +
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
  'goes on no one, nor does what "you" is said to be, nor a he or she that two people named ' +
  'nearby could be. For history, role, relation and traits "r" is who does or is it, never the ' +
  'one it is done to ("he asked Miss Pell" is his, not hers). A fact about someone reached ' +
  'through them ("my father was a clergyman", "his wife was ill") is that person\'s, theirs ' +
  'only as kinship, relation or history. A name that is not on the roster goes in "n" with its ' +
  'own facts; never put its facts on a look-alike record.\n' +
  '- "v": the value in the quote\'s own words, every word from the quote, short ("grey", "the ' +
  'quay", "dead"), and of its slot\'s kind: an age is an age (never "four daughters", never ' +
  '"for forty years"); an object is a thing (never a feeling, an attention or an act); a ' +
  'location is a place the quote puts them at, in or going to (never a place only described ' +
  'beside them, never where they died: that is history).\n' +
  'FIELDS, never slots: "src", only when not narration: dialogue (a character says it; "sp": ' +
  'the speaker\'s id), thought ("sp": the thinker\'s id), rumour (hearsay, gossip, a report, ' +
  'what others said or pronounced). "mode", only when not now: memory (recalled from before), ' +
  'hypothetical (if, would, a wish, a fear, a plan, an expectation), dream. "chg": true, only ' +
  'when the sentence states a change ("she cut her hair"). Leave out src, mode, sp, o and chg ' +
  'at narration, now, none and false.\n' +
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
  '{"p":4,"r":"r2","s":"traits","v":"proud","q":"…","src":"dialogue","sp":"r5"}],' +
  '"n":[{"n":"Hesk","p":4,"q":"…","c":[…]}],"same":["c7"],"drop":["c9"],"card":{…}}'

export interface BuiltReaderV5Prompt extends Omit<BuiltReaderV2Prompt, 'version'> {
  version: typeof READER_V5_PROMPT_VERSION
}

/** `reader.v5`'s messages: `reader.v2`'s layout and fit with the v5 rules. */
export function buildReaderV5Prompt(input: BuildReaderV2PromptInput): BuiltReaderV5Prompt {
  return { version: READER_V5_PROMPT_VERSION, ...buildReaderMessages(READER_V5_RULES, input) }
}
