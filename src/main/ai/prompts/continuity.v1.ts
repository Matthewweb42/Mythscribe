import { outputBudget } from '@shared/ai'
import {
  CONTINUITY_MAX_FINDINGS,
  CONTINUITY_QUOTE_MAX,
  type ContinuityRef
} from '@shared/continuity'
import type { AiMessage } from '../providers/types'

/**
 * The consistency-checker prompt (F-13.4), version 1: one scene (on demand) or the paragraphs of
 * one scene that state something the story bible states differently (in the background), held
 * against numbered references main built itself. The model cites a reference by its number and
 * the scene by a word-for-word quote, so both citations of a finding are exact. Prompt files are
 * versioned (F-5.12): a change to the text, the caps, or the message order is a new file
 * (`continuity.v2.ts`) with its own golden test, never an edit here.
 *
 * Order (CLAUDE.md, token efficiency rule 3): the system turn is the stable prefix, the rules and
 * then the voice profile block (F-14.1: rules and exemplars, since a fix is prose, AI rule 2), so
 * the provider's prefix cache applies across the scenes of one POV; the user turn carries what
 * changes: the scene brief (F-14.3), the references, this scene's timeline when the previous
 * scene's is one of them, and the scene text. Each fix is also scored against the profile
 * locally (F-14.7).
 */
export const CONTINUITY_PROMPT_VERSION = 'continuity.v1'

/**
 * The rules. The opening sentence is load-bearing beyond the model: the e2e's fake OpenAI
 * recognises a continuity request by it, so it must not change within this version.
 */
export const CONTINUITY_RULES =
  'You are the continuity feature inside a novel-writing app. Compare the scene text below ' +
  "with the numbered references from the author's story bible; a reference marked sheet is " +
  `the author's own word and outranks the rest. List at most ${CONTINUITY_MAX_FINDINGS} ` +
  'contradictions: a passage of the scene that states what a reference rules out (a name, an ' +
  'age, a physical detail, a relationship, a rule of the world, what a character knows, how a ' +
  'character speaks, when the scene happens). Not a contradiction: anything the references do ' +
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

export interface BuildContinuityPromptInput {
  /** The scene text as sent: the head of the scene, or only the paragraphs holding a candidate. */
  sceneText: string
  /** The references in the order they are numbered from 1; the caller caps them by budget. */
  references: readonly ContinuityRef[]
  /** This scene's timeline metadata, sent only when the previous scene's is a reference; else null. */
  timeline: string | null
  /** The voice profile block (`voiceBlock`), or null when the project has no rules or exemplars yet. */
  voice: string | null
  /** The scene brief block (`sceneBriefBlock`), or null when nobody has written one. */
  brief: string | null
}

export interface BuiltContinuityPrompt {
  version: typeof CONTINUITY_PROMPT_VERSION
  messages: AiMessage[]
  maxTokens: number
}

/**
 * One reference as the prompt lists it under `number`: the entity and its kind, where the
 * statement comes from, the field, the value, and for a fact the passage it was read from. The
 * caller measures its reference budget on these lines.
 */
export function continuityRefLine(ref: ContinuityRef, number: number): string {
  if (ref.kind === 'timeline') return `[${number}] Previous scene, ${ref.label}: ${ref.value}`
  const who = `${ref.entityName ?? 'Unnamed'} (${ref.entityKind ?? 'entry'})`
  if (ref.kind === 'sheet') return `[${number}] ${who}, sheet, ${ref.label}: ${ref.value}`
  const passage = ref.quote ? `; passage: "${ref.quote}"` : ''
  return `[${number}] ${who}, another scene, ${ref.label}: ${ref.value}${passage}`
}

export function buildContinuityPrompt(input: BuildContinuityPromptInput): BuiltContinuityPrompt {
  const parts: string[] = []
  if (input.brief) parts.push(`Scene brief (the author's intent):\n"""\n${input.brief}\n"""`)
  parts.push(
    `References:\n${input.references.map((ref, at) => continuityRefLine(ref, at + 1)).join('\n')}`
  )
  if (input.timeline) parts.push(`This scene's timeline: ${input.timeline}`)
  parts.push(`Scene text:\n"""\n${input.sceneText}\n"""`)
  parts.push('List the contradictions.')

  return {
    version: CONTINUITY_PROMPT_VERSION,
    messages: [
      {
        role: 'system',
        content: input.voice ? `${CONTINUITY_RULES} ${input.voice}` : CONTINUITY_RULES
      },
      { role: 'user', content: parts.join('\n\n') }
    ],
    maxTokens: outputBudget('continuity')
  }
}
