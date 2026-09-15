import type { AiFeatureId, Tier } from '@shared/ai'
import { BRIEF_PROMPT_VERSION } from './brief.v1'
import { CHAT_PROMPT_VERSION } from './chat.v1'
import { CHAT_PROMPT_V2_VERSION } from './chat.v2'
import { CHAT_REGEN_PROMPT_VERSION } from './chatRegen.v1'
import { CHAT_REGEN_PROMPT_V2_VERSION } from './chatRegen.v2'
import { CRITIQUE_PROMPT_VERSION } from './critique.v1'
import { CRITIQUE_PROMPT_V2_VERSION } from './critique.v2'
import { CRITIQUE_REGEN_PROMPT_VERSION } from './critiqueRegen.v1'
import { CRITIQUE_REGEN_PROMPT_V2_VERSION } from './critiqueRegen.v2'
import { GHOST_PROMPT_VERSION } from './ghostText.v1'
import { GHOST_PROMPT_V2_VERSION } from './ghostText.v2'
import { GHOST_REGEN_PROMPT_VERSION } from './ghostTextRegen.v1'
import { GHOST_REGEN_PROMPT_V2_VERSION } from './ghostTextRegen.v2'
import { REWRITE_PROMPT_VERSION } from './rewrite.v1'
import { REWRITE_REGEN_PROMPT_VERSION } from './rewriteRegen.v1'
import { TAGS_PROMPT_VERSION } from './tags.v1'
import { TAGS_REGEN_PROMPT_VERSION } from './tagsRegen.v1'

/**
 * The catalogue of shipped prompt versions (F-5.12): one entry per `<feature>.v<N>.ts` file in
 * this directory. `PromptVersion` is what the request path (`runAiRequest`) accepts, so a
 * feature cannot send a prompt this list does not know, and the ledger's and every proposal's
 * `promptVersion` is always one of these strings. A new prompt version is a new file, a new
 * constant, and a new line here; the catalogue test refuses a file without a line (and a line
 * without a file), and the eval harness (`src/main/ai/eval/`) refuses a version without a case.
 *
 * Shipped versions are immutable: their text is pinned by their golden tests and their token
 * footprint by the committed token report, so a ledger row's version always names the exact
 * messages that were sent.
 */
export const PROMPT_VERSIONS = [
  GHOST_PROMPT_VERSION,
  GHOST_REGEN_PROMPT_VERSION,
  GHOST_PROMPT_V2_VERSION,
  GHOST_REGEN_PROMPT_V2_VERSION,
  TAGS_PROMPT_VERSION,
  TAGS_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_VERSION,
  CHAT_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_V2_VERSION,
  CHAT_REGEN_PROMPT_V2_VERSION,
  REWRITE_PROMPT_VERSION,
  REWRITE_REGEN_PROMPT_VERSION,
  CRITIQUE_PROMPT_VERSION,
  CRITIQUE_REGEN_PROMPT_VERSION,
  CRITIQUE_PROMPT_V2_VERSION,
  CRITIQUE_REGEN_PROMPT_V2_VERSION,
  BRIEF_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]

export interface PromptEntry {
  /** The feature whose budgets (`FEATURE_BUDGETS`, `FEATURE_INPUT_BUDGETS`) and toggle apply. */
  feature: AiFeatureId
  /** The tier the feature requests this prompt at (CLAUDE.md, token efficiency rule 1). */
  tier: Tier
  /** Whether the answer is asked for in JSON mode (structured) or as free text (prose). */
  output: 'json' | 'text'
  /** The feature that shipped it, for the report. */
  since: string
}

export const PROMPT_CATALOGUE: Record<PromptVersion, PromptEntry> = {
  [GHOST_PROMPT_VERSION]: { feature: 'ghostText', tier: 'fast', output: 'text', since: 'F-5.3' },
  [GHOST_REGEN_PROMPT_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.7'
  },
  [GHOST_PROMPT_V2_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.3'
  },
  [GHOST_REGEN_PROMPT_V2_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.3'
  },
  [TAGS_PROMPT_VERSION]: { feature: 'tags', tier: 'fast', output: 'json', since: 'F-4.7' },
  [TAGS_REGEN_PROMPT_VERSION]: { feature: 'tags', tier: 'fast', output: 'json', since: 'F-14.5' },
  [CHAT_PROMPT_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.4' },
  [CHAT_REGEN_PROMPT_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.4' },
  [CHAT_PROMPT_V2_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-14.3' },
  [CHAT_REGEN_PROMPT_V2_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.3'
  },
  [REWRITE_PROMPT_VERSION]: { feature: 'rewrite', tier: 'fast', output: 'text', since: 'F-14.10' },
  [REWRITE_REGEN_PROMPT_VERSION]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.10'
  },
  [CRITIQUE_PROMPT_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.8'
  },
  [CRITIQUE_REGEN_PROMPT_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.8'
  },
  [CRITIQUE_PROMPT_V2_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.3'
  },
  [CRITIQUE_REGEN_PROMPT_V2_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.3'
  },
  [BRIEF_PROMPT_VERSION]: { feature: 'brief', tier: 'fast', output: 'json', since: 'F-14.3' }
}

/** Whether a string (a ledger row's, a proposal's) names a catalogued prompt version. */
export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value)
}
