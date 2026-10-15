import {
  CARD_GIST_MAX_WORDS,
  CARD_GIST_MIN_WORDS,
  CARD_LINE_MAX_WORDS
} from '@shared/memory/claims'
import { KNOWS_HOWS } from '@shared/memory/knows'
import { LOCATION_VALUE_MAX_WORDS } from '@shared/memory/ladder'
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
 * The story-memory reader (F-16.17, F-16.22, F-16.23), version 6: concrete facts only (the
 * author's decision of 2026-10-14, plan `ReaderNarrow.md`, after the fourth live planted-error
 * run: concrete slots were mostly right, nearly every wrong fact sat in traits, history, relation,
 * role, clothing and objects). Same layout, fit, pages, input and output cap as `reader.v5`
 * (`buildReaderMessages`, `readerV4OutputCap`); what changes:
 *
 * - **The slot list** is eyes, hair, scars, injuries, species, age, born, alive, kinship,
 *   location and the `detail:` labels; traits, history, relation, role, clothing and objects are
 *   named as never slots (`NOT_READ_SLOTS`; the pipeline refuses one anyway, `notRead`). Ms
 *   Scribe answers those questions by searching the text (`agent.v9`, `cite.v1`).
 * - **The open-ended rules are gone** (who did it, what a trait or a history is), so the rules
 *   are shorter than v5's and the replies too.
 * - **What stays, said once each**: a born is when (where is `detail:birthplace`), kinship is what
 *   they are to a named person (never the relative), a location is a place phrase of at most
 *   `LOCATION_VALUE_MAX_WORDS` words (never a clause), and a his or her before a value is whose it
 *   is ("her dark eyes" are hers, whoever else the sentence names).
 *
 * The code gates of the same day (`ladder.ts`: `possessiveOwner`, `locationPhrase`, `bornIsWhen`,
 * the plural kin of `relativeValue`) refuse what these rules forbid whatever the model answers;
 * the checker stays `verify.v4`, every batch on the fast tier.
 */
export const READER_V6_PROMPT_VERSION = 'reader.v6'

/** The cap the golden test asserts: 1,269 tokens, 211 fewer than `reader.v5`'s rules. */
export const READER_V6_RULES_TOKENS = 1_300

const SLOT_LIST =
  'eyes (their colour), hair, scars, injuries, species, age (how old, as the text says it: ' +
  '"eighteen", "about forty"; never how long something lasted), born (when: a year or a date; ' +
  'where is detail:birthplace), alive (alive or dead), kinship (what they are to a named person: ' +
  '"Lise\'s cousin", "son of the steward", "married"; "o": that person\'s id; never the relative: ' +
  '"his second daughter" is the daughter\'s), location (the place they are at or go to, at most ' +
  `${LOCATION_VALUE_MAX_WORDS} words: "the morning room"; never a clause), detail:<label> with ` +
  `the label one of ${DETAIL_LABEL_NAMES.join(', ')} (a lasting fact, a short value: "seven ` +
  'thousand a year")'

export const READER_V6_RULES =
  `${READER_SENTINEL} Read the numbered paragraphs of one scene and list what the prose itself ` +
  'states about the records, secrets and threads listed below: each fact once, in one slot, with ' +
  'a quote copied word for word, in paragraph order.\n' +
  `SLOTS. "s" is exactly one of: ${SLOT_LIST}; knows and thread (below). Nothing else is a ` +
  'slot: never traits, history, relation, role, clothing, objects, src, voice, dialogue, speech, ' +
  'thought, memory, dream, secret, action, event, belief, emotion or appearance. A fact that fits ' +
  "no slot is left out. A place or a thing is never anyone's location.\n" +
  'Rules:\n' +
  '- Only what the words say: no inference, no outside knowledge, no guesses. A negation or an ' +
  'absence states nothing ("her eyes were not blue" is no fact). A want, wish, hope or plan is ' +
  'no fact now.\n' +
  `- "q": ${QUOTE_MIN_WORDS} to ${QUOTE_MAX_WORDS} consecutive words copied exactly from ` +
  'paragraph "p", the fewest that state the fact; never join words from two places.\n' +
  '- "r": the roster id of whom the fact is about. The quote itself names them, or calls them ' +
  'he, she, his or her: a fact about several ("they") goes on no one, nor does a he, she, his or ' +
  'her that two people named nearby could be. A his or her before a value is whose it is: "her ' +
  'dark eyes" are hers, whoever else the sentence names. A fact about someone reached through ' +
  'them ("my father was a clergyman") is that person\'s, theirs only as kinship. A name that is ' +
  'not on the roster goes in "n" with its own facts; never put its facts on a look-alike record.\n' +
  '- "v": the value in the quote\'s own words, short ("grey", "the quay", "dead"), of its slot\'s ' +
  'kind; a location is where the quote puts them, never a place only described beside them, ' +
  'never where they died.\n' +
  'FIELDS, never slots: "src", only when not narration: dialogue (a character says it; "sp": ' +
  'the speaker\'s id), thought ("sp": the thinker\'s id), rumour (hearsay, gossip, a report, ' +
  'what others said). "mode", only when not now: memory (recalled from before), hypothetical ' +
  '(if, would, a wish, a fear, a plan), dream. "chg": true, only when the sentence states a ' +
  'change ("she cut her hair"). Leave out src, mode, sp, o and chg at narration, now, none and ' +
  'false.\n' +
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
  '{"p":4,"r":"r2","s":"age","v":"forty","q":"…","src":"dialogue","sp":"r5"}],' +
  '"n":[{"n":"Hesk","p":4,"q":"…","c":[…]}],"same":["c7"],"drop":["c9"],"card":{…}}'

export interface BuiltReaderV6Prompt extends Omit<BuiltReaderV2Prompt, 'version'> {
  version: typeof READER_V6_PROMPT_VERSION
}

/** `reader.v6`'s messages: `reader.v2`'s layout and fit with the v6 rules. */
export function buildReaderV6Prompt(input: BuildReaderV2PromptInput): BuiltReaderV6Prompt {
  return { version: READER_V6_PROMPT_VERSION, ...buildReaderMessages(READER_V6_RULES, input) }
}
