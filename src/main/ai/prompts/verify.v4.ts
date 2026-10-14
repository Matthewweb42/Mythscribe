import { KNOWS_HOWS } from '@shared/memory/knows'
import {
  VERIFY_SENTINEL,
  buildVerifyV2Prompt,
  type BuildVerifyV2PromptInput,
  type BuiltVerifyV2Prompt
} from './verify.v2'

/**
 * The story-memory fact checker (F-16.17, F-16.22, F-16.23), version 4, after the third live
 * planted-error run of 2026-10-14 (21:35; plan `ReaderPrecision.md`): about one in ten facts it
 * passed on unlabelled sentences was wrong, nearly all in the open-ended slots (history, traits,
 * relation, kinship, role): "he asked Miss Pell" as Clara's history, "all smiles" at dinner as a
 * trait, "his second daughter" as Mr. Harrow's kinship, a report in circulation as narration.
 * Same items, batches and output caps as `verify.v2`; the rules add, to `verify.v3`'s:
 *
 * - who did it: for history, role, relation and traits the one who does or is it, never the one
 *   it is done to;
 * - what each open-ended slot holds: a trait lasts (never one act, one evening's mood or others'
 *   opinion), a role is a position or work, kinship is what they are to someone (never the
 *   relative), a relation is how they stand to the other one, history is their own past act as
 *   fact (never a plan, an expectation or a report);
 * - a report or what others said or pronounced is rumour.
 *
 * The open-ended slots' facts are sent on the strong tier (the pipeline's `STRONG_CHECK_SLOTS`),
 * every other item on the fast one, in batches of their own.
 */
export const VERIFY_V4_PROMPT_VERSION = 'verify.v4'

export const VERIFY_V4_RULES =
  `${VERIFY_SENTINEL} Each numbered item gives a fact and the sentences it came from. Decide ` +
  'from those sentences alone whether they state the fact, as written.\n' +
  '- "ok": true only when the sentences say it plainly of that record. A negation never ' +
  'supports. A wish, fear, dream, memory, lie or rumour supports a fact only with that voice and ' +
  'mode; a want, hope or plan never supports having or being it now.\n' +
  '- "ok" also needs the value to be what the slot holds: eyes a colour, location where they ' +
  'are, clothing what they wear, objects what they hold or carry, role or detail:occupation ' +
  'their position or work (never an act), detail:accent how they speak, detail:home where they ' +
  "live. traits a lasting quality, never one act, one evening's mood or what others think of " +
  'them; kinship what they are to someone ("son of the steward", "Lise\'s cousin", "married"), ' +
  'never the relative ("his second daughter" is the daughter); relation how they stand to the ' +
  'other one ("admires"), never a list of people or a remark; history their own past act or ' +
  'event, told as fact, never a plan, an expectation or a report. A place has no eyes, age, ' +
  'clothes, home or location. Otherwise false.\n' +
  '- For history, role, relation and traits the record is the one who does or is it, never the ' +
  'one it is done to ("he asked Miss Pell" is his, not hers).\n' +
  '- "r": the id from "Who" the fact is about. When the subject is a pronoun ("she", "he", "I") ' +
  'or a description, pick the one record it means; null when none fits, when more than one ' +
  'could, or when it means several people ("they", "the sisters"). In speech, "you" is the one ' +
  'spoken to. A record marked "not named here" is the one only when the sentences point to it ' +
  'by a role ("his wife").\n' +
  '- "voice": narration, dialogue, thought or rumour, as the sentences give it; a report, or ' +
  'what others said or pronounced, is rumour. "mode": now, memory, hypothetical or dream.\n' +
  '- A knows item: ok only when the sentences show that record learning or holding that secret; ' +
  `"r" the learner from "Who"; "how" the way the text shows it, one of ${KNOWS_HOWS.join(', ')}; ` +
  '"fr" the id from "From" they had it from, or null.\n' +
  '- A thread item: ok when the sentences open, advance or resolve that thread; "how": opens, ' +
  'advances or resolves.\n' +
  '- A reveals item: ok when the sentences reveal that secret or set up that thread; "voice" and ' +
  '"mode" as they give it.\n' +
  '- A same item: ok only when both are the same hidden fact or open question, not merely ' +
  'related ones.\n' +
  '- A card, on-page or same item needs only "i" and "ok".\n' +
  'Reply with JSON only: {"v":[{"i":1,"ok":true,"r":"r12","voice":"narration","mode":"now"},' +
  '{"i":2,"ok":true,"r":"r7","how":"overheard","fr":"r2","voice":"narration","mode":"now"}]}'

export interface BuiltVerifyV4Prompt extends Omit<BuiltVerifyV2Prompt, 'version'> {
  version: typeof VERIFY_V4_PROMPT_VERSION
}

/** `verify.v4`'s messages: `verify.v2`'s items and caps under the v4 rules. */
export function buildVerifyV4Prompt(input: BuildVerifyV2PromptInput): BuiltVerifyV4Prompt {
  const built = buildVerifyV2Prompt(input)
  return {
    version: VERIFY_V4_PROMPT_VERSION,
    messages: built.messages.map((message) =>
      message.role === 'system' ? { ...message, content: VERIFY_V4_RULES } : message
    ),
    maxTokens: built.maxTokens
  }
}
