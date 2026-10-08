import { outputBudget } from '@shared/ai'
import {
  CONTINUITY_MAX_FINDINGS,
  CONTINUITY_QUOTE_MAX,
  type ContinuityRef
} from '@shared/continuity'
import type { AiMessage } from '../providers/types'
import type { BuildContinuityPromptInput } from './continuity.v1'

/**
 * The consistency-checker prompt (F-13.4), version 2 (F-5.23 story time, 2026-10-08): a sheet
 * describes the author's notes and plans and a fact read from a later scene describes this
 * scene's future, so neither is contradicted because the scene does not yet show an event they
 * tell (a death, a wound, a journey). Each reference line says where it comes from: the sheet
 * as the author's notes and plans, a fact as an earlier or a later scene. The rest is version
 * 1's: the shape of a finding, the message order, the caps. Prompt files are versioned (F-5.12);
 * `continuity.v1.ts` stays exactly as it shipped.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the rules and the voice profile block in the
 * system turn; the brief, the references, the timeline, and the scene text in the user turn.
 */
export const CONTINUITY_PROMPT_V2_VERSION = 'continuity.v2'

/** The rules; the opening sentence is version 1's, which the e2e's fake OpenAI keys on. */
export const CONTINUITY_RULES_V2 =
  'You are the continuity feature inside a novel-writing app. Compare the scene text below ' +
  "with the numbered references from the author's story bible; a reference marked sheet is " +
  `the author's own word and outranks the rest. List at most ${CONTINUITY_MAX_FINDINGS} ` +
  'contradictions: a passage of the scene that states what a reference rules out (a name, an ' +
  'age, a physical detail, a relationship, a rule of the world, what a character knows, how a ' +
  "character speaks, when the scene happens). Story time: a sheet is the author's notes and " +
  'plans and may tell what happens later in the book, and a reference from a later scene is ' +
  "this scene's future; neither is contradicted because this scene does not yet show an event " +
  'it tells (a death, a wound, a journey, a change of side or of heart), only by what is already ' +
  'untrue at this point in the story. Not a contradiction: anything the references do ' +
  'not mention, a detail that adds to a reference without conflicting, and a lie or a mistake ' +
  'a character makes in dialogue; when in doubt, leave it out. Each finding gives the number ' +
  'of the one reference it contradicts, a quote copied from the scene word for word and at ' +
  `most ${CONTINUITY_QUOTE_MAX} characters, one or two sentences on why both cannot be true, ` +
  'and a fix that replaces the quoted passage and nothing else so it agrees with the ' +
  "reference, in the author's voice, same point of view and tense, or null when a few words " +
  'cannot fix it. A finding whose quote is not in the scene or whose number is not a ' +
  'reference is thrown away. Reply with JSON only: ' +
  '{"findings":[{"ref":1,"quote":"...","why":"...","fix":"..."|null}]}; with no ' +
  'contradiction, {"findings":[]}.'

export interface BuildContinuityPromptV2Input extends BuildContinuityPromptInput {
  /** The manuscript documents after the checked scene in reading order (F-5.23). */
  later: ReadonlySet<string>
}

export interface BuiltContinuityPromptV2 {
  version: typeof CONTINUITY_PROMPT_V2_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/**
 * One reference as version 2 lists it: version 1's line, with where it comes from in story
 * time. The caller measures its reference budget on these lines.
 */
export function continuityRefLineV2(
  ref: ContinuityRef,
  number: number,
  later: ReadonlySet<string>
): string {
  if (ref.kind === 'timeline') return `[${number}] Previous scene, ${ref.label}: ${ref.value}`
  const who = `${ref.entityName ?? 'Unnamed'} (${ref.entityKind ?? 'entry'})`
  if (ref.kind === 'sheet') {
    return `[${number}] ${who}, sheet (notes and plans), ${ref.label}: ${ref.value}`
  }
  const when = ref.nodeId !== null && later.has(ref.nodeId) ? 'a later scene' : 'an earlier scene'
  const passage = ref.quote ? `; passage: "${ref.quote}"` : ''
  return `[${number}] ${who}, ${when}, ${ref.label}: ${ref.value}${passage}`
}

export function buildContinuityPromptV2(
  input: BuildContinuityPromptV2Input
): BuiltContinuityPromptV2 {
  const parts: string[] = []
  if (input.brief) parts.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  parts.push(
    `References:\n${input.references
      .map((ref, at) => continuityRefLineV2(ref, at + 1, input.later))
      .join('\n')}`
  )
  if (input.timeline) parts.push(`This scene's timeline: ${input.timeline}`)
  parts.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  parts.push('List the contradictions.')

  return {
    version: CONTINUITY_PROMPT_V2_VERSION,
    messages: [
      {
        role: 'system',
        content: input.voice ? `${CONTINUITY_RULES_V2} ${input.voice}` : CONTINUITY_RULES_V2
      },
      { role: 'user', content: parts.join('\n\n') }
    ],
    maxTokens: outputBudget('continuity')
  }
}
