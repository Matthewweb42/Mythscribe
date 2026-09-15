import type { AiFeatureId, Tier } from '@shared/ai'
import { CHAT_PROMPT_VERSION as CHAT_V1 } from './chat.v1'
import { CHAT_PROMPT_VERSION as CHAT_V2 } from './chat.v2'
import { CHAT_REGEN_PROMPT_VERSION as CHAT_REGEN_V1 } from './chatRegen.v1'
import { CHAT_REGEN_PROMPT_VERSION as CHAT_REGEN_V2 } from './chatRegen.v2'
import { CRITIQUE_PROMPT_VERSION as CRITIQUE_V1 } from './critique.v1'
import { CRITIQUE_PROMPT_VERSION as CRITIQUE_V2 } from './critique.v2'
import { CRITIQUE_REGEN_PROMPT_VERSION as CRITIQUE_REGEN_V1 } from './critiqueRegen.v1'
import { CRITIQUE_REGEN_PROMPT_VERSION as CRITIQUE_REGEN_V2 } from './critiqueRegen.v2'
import { GHOST_PROMPT_VERSION as GHOST_V1 } from './ghostText.v1'
import { GHOST_PROMPT_VERSION as GHOST_V2 } from './ghostText.v2'
import { GHOST_REGEN_PROMPT_VERSION as GHOST_REGEN_V1 } from './ghostTextRegen.v1'
import { GHOST_REGEN_PROMPT_VERSION as GHOST_REGEN_V2 } from './ghostTextRegen.v2'
import { REWRITE_PROMPT_VERSION as REWRITE_V1 } from './rewrite.v1'
import { REWRITE_PROMPT_VERSION as REWRITE_V2 } from './rewrite.v2'
import { REWRITE_REGEN_PROMPT_VERSION as REWRITE_REGEN_V1 } from './rewriteRegen.v1'
import { REWRITE_REGEN_PROMPT_VERSION as REWRITE_REGEN_V2 } from './rewriteRegen.v2'
import { TAGS_PROMPT_VERSION as TAGS_V1 } from './tags.v1'
import { TAGS_REGEN_PROMPT_VERSION as TAGS_REGEN_V1 } from './tagsRegen.v1'

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
 * messages that were sent. A superseded version stays catalogued (a ledger row from before the
 * change still names it); the features send the newest one.
 */
export const PROMPT_VERSIONS = [
  GHOST_V1,
  GHOST_V2,
  GHOST_REGEN_V1,
  GHOST_REGEN_V2,
  TAGS_V1,
  TAGS_REGEN_V1,
  CHAT_V1,
  CHAT_V2,
  CHAT_REGEN_V1,
  CHAT_REGEN_V2,
  REWRITE_V1,
  REWRITE_V2,
  REWRITE_REGEN_V1,
  REWRITE_REGEN_V2,
  CRITIQUE_V1,
  CRITIQUE_V2,
  CRITIQUE_REGEN_V1,
  CRITIQUE_REGEN_V2
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
  [GHOST_V1]: { feature: 'ghostText', tier: 'fast', output: 'text', since: 'F-5.3' },
  [GHOST_V2]: { feature: 'ghostText', tier: 'fast', output: 'text', since: 'F-14.9' },
  [GHOST_REGEN_V1]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.7'
  },
  [GHOST_REGEN_V2]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [TAGS_V1]: { feature: 'tags', tier: 'fast', output: 'json', since: 'F-4.7' },
  [TAGS_REGEN_V1]: { feature: 'tags', tier: 'fast', output: 'json', since: 'F-14.5' },
  [CHAT_V1]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.4' },
  [CHAT_V2]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-14.9' },
  [CHAT_REGEN_V1]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.4' },
  [CHAT_REGEN_V2]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-14.9' },
  [REWRITE_V1]: { feature: 'rewrite', tier: 'fast', output: 'text', since: 'F-14.10' },
  [REWRITE_V2]: { feature: 'rewrite', tier: 'fast', output: 'text', since: 'F-14.9' },
  [REWRITE_REGEN_V1]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.10'
  },
  [REWRITE_REGEN_V2]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [CRITIQUE_V1]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.8'
  },
  [CRITIQUE_V2]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.9'
  },
  [CRITIQUE_REGEN_V1]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.8'
  },
  [CRITIQUE_REGEN_V2]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.9'
  }
}

/** Whether a string (a ledger row's, a proposal's) names a catalogued prompt version. */
export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value)
}
