import { KNOWS_HOWS } from '@shared/memory/knows'
import {
  VERIFY_SENTINEL,
  buildVerifyV2Prompt,
  type BuildVerifyV2PromptInput,
  type BuiltVerifyV2Prompt
} from './verify.v2'

/**
 * The story-memory fact checker (F-16.17, F-16.22, F-16.23), version 3, after the live
 * planted-error run of 2026-10-14: `verify.v2` supported "the sisters walked to Callow Cross" as
 * Johanna's location (its rule told it to pick one record for "they"), "How can you be so
 * unfeeling" as Mrs. Harrow's accent, "I hope Mr. Ashby will like it" as Mr. Harrow's occupation
 * and "Johanna wanted thread" as an object she carried. Same items, batches and output caps as
 * `verify.v2` (`buildVerifyV2Prompt`); the rules change:
 *
 * - "r" is null for a they or a description of several, and "you" in speech is the one spoken to;
 * - "ok" also needs the value to be that slot's kind of fact (what each slot holds), and a want,
 *   hope or plan supports none.
 *
 * The knows rule keeps `verify.v2`'s opening words, which the e2e's fake provider looks for.
 */
export const VERIFY_V3_PROMPT_VERSION = 'verify.v3'

export const VERIFY_V3_RULES =
  `${VERIFY_SENTINEL} Each numbered item gives a fact and the sentences it came from. Decide ` +
  'from those sentences alone whether they state the fact, as written.\n' +
  '- "ok": true only when the sentences say it plainly of that record. A negation never ' +
  'supports. A wish, fear, dream, memory, lie or rumour supports a fact only with that voice and ' +
  'mode; a want, hope or plan never supports having or being it now.\n' +
  '- "ok" also needs the value to be what the slot holds: eyes a colour, location where they ' +
  'are, clothing what they wear, objects what they hold or carry, traits a lasting quality (not ' +
  'one act or opinion), role or detail:occupation their position or work, detail:accent how ' +
  'they speak, detail:home where they live. A place has no eyes, age, clothes or home. Otherwise ' +
  'false.\n' +
  '- "r": the id from "Who" the fact is about. When the subject is a pronoun ("she", "he", "I") ' +
  'or a description, pick the one record it means; null when none fits, when more than one ' +
  'could, or when it means several people ("they", "the sisters"). In speech, "you" is the one ' +
  'spoken to. A record marked "not named here" is the one only when the sentences point to it ' +
  'by a role ("his wife").\n' +
  '- "voice": narration, dialogue, thought or rumour, as the sentences give it. "mode": now, ' +
  'memory, hypothetical or dream.\n' +
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

export interface BuiltVerifyV3Prompt extends Omit<BuiltVerifyV2Prompt, 'version'> {
  version: typeof VERIFY_V3_PROMPT_VERSION
}

/** `verify.v3`'s messages: `verify.v2`'s items and caps under the v3 rules. */
export function buildVerifyV3Prompt(input: BuildVerifyV2PromptInput): BuiltVerifyV3Prompt {
  const built = buildVerifyV2Prompt(input)
  return {
    version: VERIFY_V3_PROMPT_VERSION,
    messages: built.messages.map((message) =>
      message.role === 'system' ? { ...message, content: VERIFY_V3_RULES } : message
    ),
    maxTokens: built.maxTokens
  }
}
