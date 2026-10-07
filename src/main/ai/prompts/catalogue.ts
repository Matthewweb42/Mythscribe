import type { AiFeatureId, Tier } from '@shared/ai'
import { BETA_READER_PROMPT_VERSION } from './betaReader.v1'
import { BETA_READER_REGEN_PROMPT_VERSION } from './betaReaderRegen.v1'
import { BRIEF_PROMPT_VERSION } from './brief.v1'
import { CHAT_PROMPT_VERSION } from './chat.v1'
import { CHAT_PROMPT_V2_VERSION } from './chat.v2'
import { CHAT_PROMPT_V3_VERSION } from './chat.v3'
import { CHAT_PROMPT_V4_VERSION } from './chat.v4'
import { CHAT_REGEN_PROMPT_VERSION } from './chatRegen.v1'
import { CHAT_REGEN_PROMPT_V2_VERSION } from './chatRegen.v2'
import { CHAT_REGEN_PROMPT_V3_VERSION } from './chatRegen.v3'
import { CHAT_REGEN_PROMPT_V4_VERSION } from './chatRegen.v4'
import { CONTINUITY_PROMPT_VERSION } from './continuity.v1'
import { CRITIQUE_PROMPT_VERSION } from './critique.v1'
import { CRITIQUE_PROMPT_V2_VERSION } from './critique.v2'
import { CRITIQUE_PROMPT_V3_VERSION } from './critique.v3'
import { CRITIQUE_REGEN_PROMPT_VERSION } from './critiqueRegen.v1'
import { CRITIQUE_REGEN_PROMPT_V2_VERSION } from './critiqueRegen.v2'
import { CRITIQUE_REGEN_PROMPT_V3_VERSION } from './critiqueRegen.v3'
import { GHOST_PROMPT_VERSION } from './ghostText.v1'
import { GHOST_PROMPT_V2_VERSION } from './ghostText.v2'
import { GHOST_PROMPT_V3_VERSION } from './ghostText.v3'
import { GHOST_PROMPT_V4_VERSION } from './ghostText.v4'
import { GHOST_REGEN_PROMPT_VERSION } from './ghostTextRegen.v1'
import { GHOST_REGEN_PROMPT_V2_VERSION } from './ghostTextRegen.v2'
import { GHOST_REGEN_PROMPT_V3_VERSION } from './ghostTextRegen.v3'
import { GHOST_REGEN_PROMPT_V4_VERSION } from './ghostTextRegen.v4'
import { IMPORT_STRUCTURE_PROMPT_VERSION } from './importStructure.v1'
import { PROOFREAD_PROMPT_VERSION } from './proofread.v1'
import { QUERY_PROMPT_VERSION } from './query.v1'
import { QUERY_PROMPT_V2_VERSION } from './query.v2'
import { QUERY_PROMPT_V3_VERSION } from './query.v3'
import { REWRITE_PROMPT_VERSION } from './rewrite.v1'
import { REWRITE_PROMPT_V2_VERSION } from './rewrite.v2'
import { REWRITE_PROMPT_V3_VERSION } from './rewrite.v3'
import { REWRITE_REGEN_PROMPT_VERSION } from './rewriteRegen.v1'
import { REWRITE_REGEN_PROMPT_V2_VERSION } from './rewriteRegen.v2'
import { REWRITE_REGEN_PROMPT_V3_VERSION } from './rewriteRegen.v3'
import { SUMMARY_PROMPT_VERSION } from './summary.v1'
import { SUMMARY_PROMPT_V2_VERSION } from './summary.v2'
import { SUMMARY_PROMPT_V3_VERSION } from './summary.v3'
import { TAGS_PROMPT_VERSION } from './tags.v1'
import { VOICE_NOTES_PROMPT_VERSION } from './voiceNotes.v1'
import { TAGS_REGEN_PROMPT_VERSION } from './tagsRegen.v1'
import { WHAT_NEXT_PROMPT_VERSION } from './whatNext.v1'
import { WHAT_NEXT_PROMPT_V2_VERSION } from './whatNext.v2'
import { CHAT_PROMPT_V5_VERSION } from './chat.v5'
import { CHAT_REGEN_PROMPT_V5_VERSION } from './chatRegen.v5'
import { QUERY_PROMPT_V4_VERSION } from './query.v4'
import { ROUTE_PROMPT_VERSION } from './route.v1'
import { SYNOPSIS_PROMPT_VERSION } from './synopsis.v1'
import { NOTES_SUGGEST_PROMPT_VERSION } from './notesSuggest.v1'
import { AGENT_PROMPT_VERSION } from './agent.v1'
import { EDIT_PASS_PROMPT_VERSION } from './editPass.v1'

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
  GHOST_PROMPT_V4_VERSION,
  GHOST_REGEN_PROMPT_V4_VERSION,
  TAGS_PROMPT_VERSION,
  TAGS_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_VERSION,
  CHAT_REGEN_PROMPT_VERSION,
  CHAT_PROMPT_V2_VERSION,
  CHAT_REGEN_PROMPT_V2_VERSION,
  CHAT_PROMPT_V3_VERSION,
  CHAT_REGEN_PROMPT_V3_VERSION,
  CHAT_PROMPT_V4_VERSION,
  CHAT_REGEN_PROMPT_V4_VERSION,
  REWRITE_PROMPT_VERSION,
  REWRITE_REGEN_PROMPT_VERSION,
  REWRITE_PROMPT_V2_VERSION,
  REWRITE_REGEN_PROMPT_V2_VERSION,
  REWRITE_PROMPT_V3_VERSION,
  REWRITE_REGEN_PROMPT_V3_VERSION,
  CRITIQUE_PROMPT_VERSION,
  CRITIQUE_REGEN_PROMPT_VERSION,
  CRITIQUE_PROMPT_V2_VERSION,
  CRITIQUE_REGEN_PROMPT_V2_VERSION,
  CRITIQUE_PROMPT_V3_VERSION,
  CRITIQUE_REGEN_PROMPT_V3_VERSION,
  BETA_READER_PROMPT_VERSION,
  BETA_READER_REGEN_PROMPT_VERSION,
  BRIEF_PROMPT_VERSION,
  SUMMARY_PROMPT_VERSION,
  SUMMARY_PROMPT_V2_VERSION,
  SUMMARY_PROMPT_V3_VERSION,
  QUERY_PROMPT_VERSION,
  QUERY_PROMPT_V2_VERSION,
  QUERY_PROMPT_V3_VERSION,
  IMPORT_STRUCTURE_PROMPT_VERSION,
  CONTINUITY_PROMPT_VERSION,
  PROOFREAD_PROMPT_VERSION,
  WHAT_NEXT_PROMPT_VERSION,
  WHAT_NEXT_PROMPT_V2_VERSION,
  CHAT_PROMPT_V5_VERSION,
  CHAT_REGEN_PROMPT_V5_VERSION,
  QUERY_PROMPT_V4_VERSION,
  ROUTE_PROMPT_VERSION,
  SYNOPSIS_PROMPT_VERSION,
  NOTES_SUGGEST_PROMPT_VERSION,
  VOICE_NOTES_PROMPT_VERSION,
  EDIT_PASS_PROMPT_VERSION,
  AGENT_PROMPT_VERSION
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
  [GHOST_PROMPT_V4_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [GHOST_REGEN_PROMPT_V4_VERSION]: {
    feature: 'ghostText',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
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
  [CHAT_PROMPT_V4_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [CHAT_REGEN_PROMPT_V4_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
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
  [REWRITE_PROMPT_V3_VERSION]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
  },
  [REWRITE_REGEN_PROMPT_V3_VERSION]: {
    feature: 'rewrite',
    tier: 'fast',
    output: 'text',
    since: 'F-14.13'
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
  [BETA_READER_PROMPT_VERSION]: {
    feature: 'betaReader',
    tier: 'strong',
    output: 'json',
    since: 'F-14.11'
  },
  [BETA_READER_REGEN_PROMPT_VERSION]: {
    feature: 'betaReader',
    tier: 'strong',
    output: 'json',
    since: 'F-14.11'
  },
  [BRIEF_PROMPT_VERSION]: { feature: 'brief', tier: 'fast', output: 'json', since: 'F-14.3' },
  [SUMMARY_PROMPT_VERSION]: { feature: 'summary', tier: 'fast', output: 'json', since: 'F-5.6' },
  [SUMMARY_PROMPT_V2_VERSION]: {
    feature: 'summary',
    tier: 'fast',
    output: 'json',
    since: 'F-5.16'
  },
  [SUMMARY_PROMPT_V3_VERSION]: {
    feature: 'summary',
    tier: 'fast',
    output: 'json',
    since: 'F-4.13'
  },
  [QUERY_PROMPT_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.7' },
  [QUERY_PROMPT_V2_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.16' },
  [QUERY_PROMPT_V3_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.7' },
  [IMPORT_STRUCTURE_PROMPT_VERSION]: {
    feature: 'importStructure',
    tier: 'fast',
    output: 'json',
    since: 'F-12.3'
  },
  // On demand the feature asks the strong tier; the background run sends the same prompt to
  // the fast one (CLAUDE.md, token rule 1). The catalogue names the tier the author asks on.
  [CONTINUITY_PROMPT_VERSION]: {
    feature: 'continuity',
    tier: 'strong',
    output: 'json',
    since: 'F-13.4'
  },
  [PROOFREAD_PROMPT_VERSION]: {
    feature: 'proofread',
    tier: 'fast',
    output: 'json',
    since: 'F-14.12'
  },
  [VOICE_NOTES_PROMPT_VERSION]: {
    feature: 'voiceNotes',
    tier: 'fast',
    output: 'json',
    since: 'F-14.14'
  },
  [WHAT_NEXT_PROMPT_VERSION]: {
    feature: 'whatNext',
    tier: 'fast',
    output: 'json',
    since: 'F-5.17'
  },
  [WHAT_NEXT_PROMPT_V2_VERSION]: {
    feature: 'whatNext',
    tier: 'fast',
    output: 'json',
    since: 'F-14.13'
  },
  [CHAT_PROMPT_V5_VERSION]: { feature: 'chat', tier: 'fast', output: 'text', since: 'F-5.20' },
  [CHAT_REGEN_PROMPT_V5_VERSION]: {
    feature: 'chat',
    tier: 'fast',
    output: 'text',
    since: 'F-5.20'
  },
  [QUERY_PROMPT_V4_VERSION]: { feature: 'query', tier: 'strong', output: 'json', since: 'F-5.20' },
  [ROUTE_PROMPT_VERSION]: { feature: 'route', tier: 'fast', output: 'json', since: 'F-5.19' },
  [SYNOPSIS_PROMPT_VERSION]: {
    feature: 'synopsis',
    tier: 'fast',
    output: 'json',
    since: 'F-5.20'
  },
  [NOTES_SUGGEST_PROMPT_VERSION]: {
    feature: 'notesSuggest',
    tier: 'fast',
    output: 'json',
    since: 'F-5.20'
  },
  // One version for every pass type; developmental, line, and custom passes ask the strong tier,
  // copy, proofread, and continuity the fast one (`EDIT_PASS_TIER`). The catalogue names strong.
  [EDIT_PASS_PROMPT_VERSION]: {
    feature: 'editPass',
    tier: 'strong',
    output: 'json',
    since: 'F-14.15'
  },
  [AGENT_PROMPT_VERSION]: { feature: 'agent', tier: 'strong', output: 'json', since: 'F-5.22' }
}

/** Whether a string (a ledger row's, a proposal's) names a catalogued prompt version. */
export function isPromptVersion(value: string): value is PromptVersion {
  return (PROMPT_VERSIONS as readonly string[]).includes(value)
}
