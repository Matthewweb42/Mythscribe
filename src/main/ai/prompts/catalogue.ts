import type { AiFeatureId, Tier } from '@shared/ai'
import { BRIEF_PROMPT_VERSION } from './brief.v1'
import { CHAT_PROMPT_VERSION } from './chat.v1'
import { CHAT_PROMPT_V2_VERSION } from './chat.v2'
import { CHAT_PROMPT_V3_VERSION } from './chat.v3'
import { CHAT_REGEN_PROMPT_VERSION } from './chatRegen.v1'
import { CHAT_REGEN_PROMPT_V2_VERSION } from './chatRegen.v2'
import { CHAT_REGEN_PROMPT_V3_VERSION } from './chatRegen.v3'
import { CRITIQUE_PROMPT_VERSION } from './critique.v1'
import { CRITIQUE_PROMPT_V2_VERSION } from './critique.v2'
import { CRITIQUE_PROMPT_V3_VERSION } from './critique.v3'
import { CRITIQUE_REGEN_PROMPT_VERSION } from './critiqueRegen.v1'
import { CRITIQUE_REGEN_PROMPT_V2_VERSION } from './critiqueRegen.v2'
import { CRITIQUE_REGEN_PROMPT_V3_VERSION } from './critiqueRegen.v3'
import { GHOST_PROMPT_VERSION } from './ghostText.v1'
import { GHOST_PROMPT_V2_VERSION } from './ghostText.v2'
import { GHOST_PROMPT_V3_VERSION } from './ghostText.v3'
import { GHOST_REGEN_PROMPT_VERSION } from './ghostTextRegen.v1'
import { GHOST_REGEN_PROMPT_V2_VERSION } from './ghostTextRegen.v2'
import { GHOST_REGEN_PROMPT_V3_VERSION } from './ghostTextRegen.v3'
import { REWRITE_PROMPT_VERSION } from './rewrite.v1'
import { REWRITE_PROMPT_V2_VERSION } from './rewrite.v2'
import { REWRITE_REGEN_PROMPT_VERSION } from './rewriteRegen.v1'
import { REWRITE_REGEN_PROMPT_V2_VERSION } from './rewriteRegen.v2'
import { SUMMARY_PROMPT_VERSION } from './summary.v1'
import { TAGS_PROMPT_VERSION } from './tags.v1'
import { TAGS_REGEN_PROMPT_VERSION } from './tagsRegen.v1'

/**
 * The catalogue of shipped prompt versions (F-5.12): one entry per `<feature>.v<N>.ts` file in
 * this folder, keyed by the version string the file exports and the ledger records. The eval
 * harness (`src/main/ai/eval/`) requires every entry to have at least one case, and the token
 * report is grouped in this order, so adding a prompt file without a catalogue entry, or an
 * entry without cases, fails `npm run test`.
 *
 * Shipped versions are immutable: their text is pinned by their golden tests and their token
 * footprint by the committed token report, so a ledger row's version always names the exact
 * messages that were sent. A superseded version stays catalogued (a ledger row from before the
 * change still names it); the features send the newest one.
 */
export const PROMPT_VERSIONS = [
  GHOST_PROMPT_VERSION,
  GHOST_REGEN_PROMPT_VERSION,
  GHOST_PROMPT_V2_VERSION,
  GHOST_REGEN_PROMPT_V2_VERSION,
  GHOST_PROMPT_V3_VERSION,
  GHOST_REGEN_PROMPT_V3_VERSION,
  TAGS_PROMPT_VERSION,
  TAGS_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_VERSION,
  CHAT_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_V2_VERSION,
  CHAT_REGEN_PROMPT_V2_VERSION,
  CHAT_PROMPT_V3_VERSION,
  CHAT_REGEN_PROMPT_V3_VERSION,
  REWRITE_PROMPT_VERSION,
  REWRITE_REGEN_PROMPT_VERSION,
  REWRITE_PROMPT_V2_VERSION,
  REWRITE_REGEN_PROMPT_V2_VERSION,
  CRITIQUE_PROMPT_VERSION,
  CRITIQUE_REGEN_PROMPT_VERSION,
  CRITIQUE_PROMPT_V2_VERSION,
  CRITIQUE_REGEN_PROMPT_V2_VERSION,
  CRITIQUE_PROMPT_V3_VERSION,
  CRITIQUE_REGEN_PROMPT_V3_VERSION,
  BRIEF_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION
] as const
export type PromptVersion = (typeof PROMPT_VERSIONS)[number]

export interface PromptEntry {
  /** The feature whose budgets the version is measured against. */
  feature: AiFeatureId
  /** The tier the feature requests it on (CLAUDE.md, token rule 1). */
  tier: Tier
  /** Whether the model answers in prose or in JSON (`json: true` on the request). */
  output: 'text' | 'json'
  /** The feature ID that introduced the version, for the report. */
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
  [GHOST_PROMPT_V3_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [GHOST_REGEN_PROMPT_V3_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
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
  [CHAT_PROMPT_V3_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-14.9' },
  [CHAT_REGEN_PROMPT_V3_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [REWRITE_PROMPT_VERSION]: { feature: 'rewrite', tier: 'fast', output: 'text', since: 'F-14.10' },
  [REWRITE_REGEN_PROMPT_VERSION]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.10'
  },
  [REWRITE_PROMPT_V2_VERSION]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
  },
  [REWRITE_REGEN_PROMPT_V2_VERSION]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.9'
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
  [CRITIQUE_PROMPT_V3_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.9'
  },
  [CRITIQUE_REGEN_PROMPT_V3_VERSION]: {
    feature: 'critique',
    tier: 'strong',
    output: 'json',
    since: 'F-14.9'
  },
  [BRIEF_PROMPT_VERSION]: { feature: 'brief', tier: 'fast', output: 'json', since: 'F-14.3' },
  [SUMMARY_PROMPT_VERSION]: { feature: 'summary', tier: 'fast', output: 'json', since: 'F-5.6' }
}

/** Whether a string (a ledger row's, a proposal's) names a catalogued prompt version. */
export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value)
}
